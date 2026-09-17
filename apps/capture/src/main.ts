import { createServer } from "node:http";
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { createAdapters, parseWatchChannelIds } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { createDb } from "@tm/db";
import { getConfig, logger } from "@tm/shared";
import { ChannelType, Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { type Deps, finaliseMeeting, startMeeting } from "./finalise.js";
import { RecordingSession } from "./session.js";
import { ffmpegTranscoder } from "./transcode.js";
import { type Member, mintSessionId, shouldFinalise, shouldStart, watchConfig } from "./watch.js";

/**
 * The Discord meeting recorder. This is the ONE piece of tm-voice that does not run on Railway:
 * Discord voice media is Opus over UDP with no TCP fallback, and Railway does not carry it. Fly.io
 * does, so capture lives there and everything downstream — the queue, the worker, the database —
 * stays where it was. See docs/ARCHITECTURE.md.
 */
const cfg = getConfig();
const channelIds = parseWatchChannelIds(cfg.WATCH_CHANNEL_IDS);
if (!cfg.DISCORD_BOT_TOKEN) throw new Error("capture requires DISCORD_BOT_TOKEN");
if (channelIds.length === 0) throw new Error("capture requires WATCH_CHANNEL_IDS; an empty list would mean recording nothing, which is a silent no-op");

const { db } = createDb(cfg.DATABASE_URL);
const deps: Deps = { db, adapters: createAdapters(cfg), producer: createProducer(cfg.REDIS_URL) };
const watch = watchConfig(channelIds);
const sessions = new Map<string, RecordingSession>();

/**
 * Guilds + GuildVoiceStates and nothing else. Neither is privileged. MessageContent and
 * GuildMessages are absent on purpose: this bot posts two lines into a channel it is already
 * recording and never reads anything, so it has no business holding the intent that would let it.
 */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const membersOf = (channel: VoiceBasedChannel): Member[] =>
  [...channel.members.values()].map((m) => ({ id: m.id, bot: m.user.bot }));

async function start(channel: VoiceBasedChannel): Promise<void> {
  const startedAt = new Date();
  const sessionId = mintSessionId(channel.guild.id, channel.id, startedAt);
  const members = membersOf(channel);

  // Notice and consent first. If either fails, nothing below runs and no audio is retained.
  await startMeeting(deps, { sessionId, guildId: channel.guild.id, channelId: channel.id, startedAt, members });

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // deafened, we would receive nothing
    selfMute: true,  // this bot never speaks
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const session = new RecordingSession(sessionId, channel.guild.id, channel.id, connection, ffmpegTranscoder);
  for (const m of members) if (!m.bot) session.seen.add(m.id);
  session.listen(connection.receiver, (userId) => channel.members.get(userId)?.displayName ?? null);
  sessions.set(channel.id, session);
}

async function finish(channelId: string): Promise<void> {
  const session = sessions.get(channelId);
  if (!session) return;
  sessions.delete(channelId);
  const tracks = await session.finish();
  await finaliseMeeting(deps, {
    sessionId: session.sessionId,
    endedAt: new Date(),
    participantCount: session.seen.size,
    tracks,
  });
}

client.on("voiceStateUpdate", (oldState, newState) => {
  void (async () => {
    // Both sides matter: joining fires on newState.channel, leaving on oldState.channel.
    for (const channel of new Set([oldState.channel, newState.channel])) {
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;
      const members = membersOf(channel);
      const recording = sessions.has(channel.id);
      try {
        if (shouldStart(watch, channel.id, members, recording)) await start(channel);
        else if (shouldFinalise(members, recording)) await finish(channel.id);
      } catch (e) {
        logger.error({ channel_id: channel.id, err: (e as Error).message }, "voice state handling failed");
      }
    }
  })();
});

client.once("clientReady", () => {
  logger.info({ watched: channelIds, user: client.user?.tag }, "capture up");
});

// HTTP health, not UDP. Nothing dials this service: Discord voice is outbound-initiated — the bot
// opens the socket and receives on the return path — so there is no inbound port to expose.
const port = Number(process.env.PORT ?? 8080);
const health = createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404).end(); return; }
  const ok = client.isReady();
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, watched: channelIds.length, active_sessions: sessions.size, dial_mode: cfg.DIAL_MODE }));
});
health.listen(port, "0.0.0.0");

await client.login(cfg.DISCORD_BOT_TOKEN);

const shutdown = async () => {
  // Finalise in flight rather than losing the meeting: Fly gives a SIGTERM grace period and an
  // un-finalised session is audio nobody ever sees.
  await Promise.allSettled([...sessions.keys()].map((id) => finish(id)));
  await deps.producer.close();
  client.destroy();
  health.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
