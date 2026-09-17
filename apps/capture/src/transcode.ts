import { spawn } from "node:child_process";
import { AdapterError } from "@tm/shared";

/**
 * Discord sends each speaker's Opus at roughly 64–96 kbps. Stored as-is, a four-person hour is a
 * few hundred MB and every byte of it is eventually shipped to an STT provider. 16 kbps mono is
 * comfortably above the intelligibility floor for speech and cuts that by about 5x.
 *
 * The re-encode is done by ffmpeg rather than a native node binding: prism-media's Opus encoder
 * needs @discordjs/opus or opusscript compiled for the target, and the capture image already needs
 * ffmpeg on hand. One binary beats one more native build to get wrong on deploy.
 */
export const TARGET_BITRATE = "16k";

export type Transcoder = (oggOpus: Uint8Array) => Promise<Uint8Array>;

/**
 * Re-encode an Ogg Opus stream to 16 kbps mono. `-application voip` tells libopus this is speech,
 * which is what makes 16 kbps sound like a person rather than a fax.
 */
export const ffmpegTranscoder: Transcoder = (oggOpus) =>
  new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-c:a", "libopus", "-b:a", TARGET_BITRATE, "-ac", "1", "-application", "voip",
      "-f", "ogg", "pipe:1",
    ]);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => err.push(c));
    ff.on("error", (e) => reject(new AdapterError({ vendor: "stt_batch", code: "ffmpeg_spawn_failed", retryable: false, raw: e.message })));
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new AdapterError({ vendor: "stt_batch", code: "ffmpeg_failed", retryable: false, raw: { code, stderr: Buffer.concat(err).toString().slice(0, 2000) } }));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(out)));
    });

    // EPIPE here means ffmpeg died before reading stdin; the close handler already reports why.
    ff.stdin.on("error", () => {});
    ff.stdin.end(Buffer.from(oggOpus));
  });

/** Used by tests and by any run where re-encoding is not the thing under test. */
export const passthroughTranscoder: Transcoder = async (oggOpus) => oggOpus;
