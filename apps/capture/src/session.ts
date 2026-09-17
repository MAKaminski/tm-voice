import { EndBehaviorType, type VoiceConnection, type VoiceReceiver } from "@discordjs/voice";
import { logger } from "@tm/shared";
import type { FinishedTrack } from "./finalise.js";
import { muxOggOpus } from "./ogg.js";
import type { Transcoder } from "./transcode.js";

/**
 * Discord's Opus is 48 kHz, 20 ms frames. The receiver hands back one stream per SSRC, and it only
 * produces packets while that person is speaking — so a track is the sum of someone's speech, not
 * a wall-clock recording of the meeting. That distinction is the whole cost story downstream: four
 * people in an hour is 240 wall-clock minutes but usually well under 90 minutes of actual audio,
 * and STT is billed on the latter.
 */
const FRAME_MS = 20;
/** Discord sends stereo even for one speaker; ffmpeg downmixes to mono in the re-encode. */
const CHANNELS = 2;

/** Silence long enough to close a sub-stream. Short enough to bound memory, long enough that a
 * breath mid-sentence does not split a speaker into dozens of fragments. */
const END_AFTER_SILENCE_MS = 1_000;

interface Sink {
  discordUserId: string;
  displayName: string | null;
  /** Raw Opus packets, accumulated across every time this person spoke. Never decoded. */
  packets: Uint8Array[];
  /** Open sub-streams; finalise waits for these so the last sentence is not dropped. */
  pending: Set<Promise<void>>;
}

/**
 * Accumulates per-speaker Opus for one meeting. Deliberately knows nothing about the database:
 * it produces FinishedTrack[] and the caller decides what to do with them.
 */
export class RecordingSession {
  readonly startedAt = new Date();
  /** Every non-bot member seen at any point, so participant_count survives people leaving early. */
  readonly seen = new Set<string>();
  private readonly sinks = new Map<string, Sink>();
  private stopped = false;

  constructor(
    readonly sessionId: string,
    readonly guildId: string,
    readonly channelId: string,
    private readonly connection: VoiceConnection,
    private readonly transcode: Transcoder,
  ) {}

  /** Subscribe to everyone who speaks. Called once, after the connection is ready. */
  listen(receiver: VoiceReceiver, displayNameOf: (userId: string) => string | null): void {
    receiver.speaking.on("start", (userId) => {
      if (this.stopped) return;
      const sink = this.sinkFor(userId, displayNameOf(userId));
      // One sub-stream per utterance. Subscribing again while one is open would duplicate audio,
      // so the receiver's own dedupe (it returns the existing stream) is relied on here.
      const done = this.capture(receiver, userId, sink).catch((e: Error) => {
        logger.error({ session_id: this.sessionId, user_id: userId, err: e.message }, "speaker stream failed");
      });
      sink.pending.add(done);
      void done.finally(() => sink.pending.delete(done));
    });
  }

  private sinkFor(discordUserId: string, displayName: string | null): Sink {
    let s = this.sinks.get(discordUserId);
    if (!s) {
      s = { discordUserId, displayName, packets: [], pending: new Set() };
      this.sinks.set(discordUserId, s);
    }
    return s;
  }

  private async capture(receiver: VoiceReceiver, userId: string, sink: Sink): Promise<void> {
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: END_AFTER_SILENCE_MS } });
    // Packets are kept exactly as they arrived and framed into Ogg at the end. Decoding here would
    // need a native Opus binding and would throw quality away before the single re-encode.
    await new Promise<void>((resolve, reject) => {
      opus.on("data", (packet: Buffer) => { sink.packets.push(new Uint8Array(packet)); });
      opus.on("end", () => resolve());
      opus.on("error", reject);
    });
  }

  /**
   * Stop listening and produce one track per speaker. Waits for open sub-streams first: the last
   * person to talk is still mid-utterance when the meeting ends, and dropping it loses exactly the
   * "so we'll add a gate code field" that the whole pipeline exists to catch.
   */
  async finish(): Promise<FinishedTrack[]> {
    this.stopped = true;
    for (const sink of this.sinks.values()) await Promise.allSettled([...sink.pending]);
    this.connection.destroy();

    const tracks: FinishedTrack[] = [];
    for (const sink of this.sinks.values()) {
      if (sink.packets.length === 0) continue;
      const audio = await this.transcode(muxOggOpus(sink.packets, { channelCount: CHANNELS }));
      tracks.push({
        discordUserId: sink.discordUserId,
        displayName: sink.displayName,
        audio,
        // Frames, not wall clock: the receiver emits only while this person is speaking.
        durationSec: (sink.packets.length * FRAME_MS) / 1000,
      });
    }
    return tracks;
  }
}
