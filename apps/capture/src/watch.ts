/**
 * The join/leave decision, kept free of discord.js so every branch is unit-tested.
 *
 * The recording boundary is WATCH_CHANNEL_IDS plus channel-level Connect, and nothing else. This
 * service must never record server-wide, so an unset WATCH_CHANNEL_IDS records NOTHING rather than
 * everything — the opposite of the adapter's posting guard, where an empty list is "unconfigured,
 * don't second-guess". Recording is the dangerous direction; posting is not.
 */
export interface Member { id: string; bot: boolean }

export interface WatchConfig {
  channelIds: ReadonlySet<string>;
  /** Members below this and we do not start. Two is the brief: a meeting, not someone parked alone. */
  minMembers: number;
}

export function watchConfig(channelIds: string[], minMembers = 2): WatchConfig {
  return { channelIds: new Set(channelIds), minMembers };
}

export const nonBots = (members: readonly Member[]): Member[] => members.filter((m) => !m.bot);

/** Start a recording: the channel is watched and enough humans are in it. */
export function shouldStart(cfg: WatchConfig, channelId: string, members: readonly Member[], recording: boolean): boolean {
  if (recording) return false;
  if (!cfg.channelIds.has(channelId)) return false;
  return nonBots(members).length >= cfg.minMembers;
}

/**
 * Finalise when the last non-bot member leaves — not when the count drops below minMembers. A
 * three-person meeting that becomes a two-person meeting is still the same meeting, and dropping
 * at the threshold would split it into two sessions and file its tasks twice.
 */
export function shouldFinalise(members: readonly Member[], recording: boolean): boolean {
  return recording && nonBots(members).length === 0;
}

/** `<guild>:<channel>:<started_at ms>` — stable, sortable, and unique per join. */
export function mintSessionId(guildId: string, channelId: string, startedAt: Date): string {
  return `${guildId}:${channelId}:${startedAt.getTime()}`;
}

/** R2 layout: one prefix per session so a meeting's audio is one `ls` and one retention sweep. */
export function trackKey(sessionId: string, discordUserId: string): string {
  return `meetings/${sessionId.replaceAll(":", "/")}/${discordUserId}.opus`;
}
