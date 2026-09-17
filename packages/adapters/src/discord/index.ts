import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

const API = "https://discord.com/api/v10";

export const postMessageInput = z.object({
  channel_id: z.string().min(1),
  content: z.string().min(1).max(2000),
});
export type PostMessageInput = z.infer<typeof postMessageInput>;

export interface DiscordChannel { id: string; name: string; guild_id: string; type: number }

/**
 * The Discord *HTTP* surface. Gateway and voice live in apps/capture (they need a long-lived socket
 * and a UDP path, neither of which fits the request/response adapter shape), but every REST call
 * goes through here so rule 1 holds and the bot's write surface is one auditable file.
 *
 * The bot posts in exactly one place: the watched channel it is recording, at the moment it joins
 * and once when the meeting has been filed. It never reads message history.
 */
export interface DiscordAdapter extends Adapter {
  getChannel(channelId: string): Promise<DiscordChannel>;
  postChannelMessage(input: PostMessageInput): Promise<{ id: string }>;
}

/** Comma-separated in env; the capture service and the adapter must agree on how it splits. */
export function parseWatchChannelIds(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function createDiscordAdapter(cfg: Config): DiscordAdapter & { mock?: MockRecorder } {
  const watched = new Set(parseWatchChannelIds(cfg.WATCH_CHANNEL_IDS));
  /**
   * Refuse to post anywhere but a watched channel. The bot's token is scoped by Discord to the
   * guilds it was invited to, which is coarser than the boundary we promised: WATCH_CHANNEL_IDS
   * plus channel-level Connect. This is that boundary, enforced before the request is built.
   */
  const assertWatched = (channelId: string) => {
    if (watched.size > 0 && !watched.has(channelId)) {
      throw new AdapterError({ vendor: "discord", code: "channel_not_watched", retryable: false, raw: { channel_id: channelId } });
    }
  };

  if (useMock(cfg, "DISCORD_BOT_TOKEN")) {
    const mock = new MockRecorder();
    let n = 0;
    return {
      name: "discord", mode: "mock", mock,
      async healthcheck() { return { vendor: "discord", ok: true, mode: "mock" as const }; },
      async getChannel(channelId) {
        mock.record("getChannel", channelId);
        return { id: channelId, name: "mock-voice", guild_id: "mock_guild", type: 2 };
      },
      async postChannelMessage(input) {
        const v = validate("discord", postMessageInput, input);
        assertWatched(v.channel_id);
        mock.record("postChannelMessage", v);
        return { id: `mock_msg_${++n}` };
      },
    };
  }

  const auth = () => ({ authorization: `Bot ${cfg.DISCORD_BOT_TOKEN!}` });
  return {
    name: "discord", mode: "real",
    async healthcheck() {
      const r = await fetch(`${API}/users/@me`, { headers: auth() });
      if (!r.ok) return { vendor: "discord", ok: false, mode: "real", detail: `HTTP ${r.status}` };
      const me = (await r.json().catch(() => ({}))) as { username?: string };
      return { vendor: "discord", ok: true, mode: "real", detail: me.username ? `bot ${me.username}` : undefined };
    },
    async getChannel(channelId) {
      return request<DiscordChannel>({ vendor: "discord", url: `${API}/channels/${channelId}`, headers: auth() });
    },
    async postChannelMessage(input) {
      const v = validate("discord", postMessageInput, input);
      assertWatched(v.channel_id);
      const res = await request<{ id?: string }>({
        vendor: "discord", method: "POST", url: `${API}/channels/${v.channel_id}/messages`,
        headers: auth(),
        // allowed_mentions empty: a recording notice must never ping a room.
        body: { content: v.content, allowed_mentions: { parse: [] } },
      });
      if (!res.id) throw new AdapterError({ vendor: "discord", code: "missing_message_id", retryable: false, raw: res });
      return { id: res.id };
    },
  };
}
