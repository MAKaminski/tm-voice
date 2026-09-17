import type { Adapters } from "@tm/adapters";
import { DEFAULT_ROLE, STATUS_NEW, TASK_OWNER_CLAUDE, type TmosRole } from "@tm/adapters";
import { meeting, speakerTrack, transcript } from "@tm/db";
import { type Config, logger } from "@tm/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx, Processor } from "../context.js";
import type { MeetingTurn } from "./meeting.js";
import { summaryLine } from "./summary.js";

export type MeetingExtractPayload = { session_id: string };

/**
 * What the model is allowed to return. Anything that does not parse is dropped rather than filed:
 * a malformed extraction must not become a task nobody can trace back to something that was said.
 */
export const extractedTask = z.object({
  title: z.string().min(1).max(300),
  speaker: z.string().min(1),
  at_sec: z.number().nonnegative(),
  /** Must appear in the transcript; verified below, not trusted. */
  quote: z.string().min(1),
  role: z.string().min(1).optional(),
});
export type ExtractedTask = z.infer<typeof extractedTask>;

export const SYSTEM_PROMPT = `You read a transcript of a working meeting and extract the commitments and specifications in it, so they can be filed as tasks.

File a line ONLY if it is a commitment or a specification — something a person decided to do, or a concrete statement of how something should behave.

File, for example:
- "we should have the bot read back the address before it books"
- "add a field for gate code"

Do NOT file:
- wishes and musings: "it'd be cool if", "someday", "at some point we might"
- questions, opinions, status reports, or anything already listed as an open task
- restating a decision that another line already covers — one task per decision

For each task return:
- title: one imperative sentence stating the outcome, not the noun
- speaker: the speaker exactly as the transcript labels them
- at_sec: the timestamp of the line it came from
- quote: the line VERBATIM from the transcript, copied exactly, not paraphrased
- role: one of the listed roles if the topic clearly belongs to one, otherwise omit it

Return a JSON array. Return [] if the meeting contained no commitments. Return nothing else.`;

/** Render the merged transcript the way the model reads it, and the way a quote is matched back. */
export function renderTranscript(turns: readonly MeetingTurn[]): string {
  return turns.map((t) => `[${Math.floor(t.at_sec)}s] ${t.speaker}: ${t.text}`).join("\n");
}

/** Strip the first fenced block, if the model wrapped its JSON in one. */
export function parseTasks(raw: string): ExtractedTask[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((x) => {
    const r = extractedTask.safeParse(x);
    return r.success ? [r.data] : [];
  });
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Keep only tasks whose quote actually appears in the transcript.
 *
 * Every task carries a verbatim quote so a card on the board can be traced back to the second
 * somebody said it. A quote the model invented breaks that, and an invented quote is exactly what
 * a hallucinated task looks like — so this is the filter that keeps fabrications off the board,
 * not a formatting nicety.
 */
export function withVerifiableQuotes(tasks: readonly ExtractedTask[], turns: readonly MeetingTurn[]): ExtractedTask[] {
  const haystack = normalise(turns.map((t) => t.text).join("\n"));
  return tasks.filter((t) => {
    const q = normalise(t.quote);
    if (q.length < 8) return false;
    return haystack.includes(q);
  });
}

/** Drop anything already open on the board, matched loosely on the title. */
export function notAlreadyOpen(tasks: readonly ExtractedTask[], openTitles: readonly string[]): ExtractedTask[] {
  const open = new Set(openTitles.map(normalise));
  return tasks.filter((t) => !open.has(normalise(t.title)));
}

/** A model-named role only counts if the board actually has it; otherwise Task Intake. */
export function resolveRole(requested: string | undefined, roles: readonly TmosRole[]): string {
  if (!requested) return DEFAULT_ROLE;
  return roles.find((r) => r.name.toLowerCase() === requested.toLowerCase())?.name ?? DEFAULT_ROLE;
}

export function buildNotes(task: ExtractedTask, sessionId: string, r2Keys: readonly string[]): string {
  const at = new Date(task.at_sec * 1000).toISOString().slice(11, 19);
  return [
    `${task.speaker} at ${at} in the Discord meeting: "${task.quote}"`,
    ``,
    `Session ${sessionId}. Audio: ${r2Keys.join(", ") || "none"}`,
  ].join("\n");
}

/** `vc:<session_id>:<n>` — the value the unique index on ops.tasks.external_key collides on. */
export const externalKey = (sessionId: string, n: number) => `vc:${sessionId}:${n}`;

async function summarise(adapters: Adapters, cfg: Config, channelId: string, count: number, durationSec: number): Promise<void> {
  try {
    await adapters.discord.postChannelMessage({
      channel_id: channelId,
      content: summaryLine(count, durationSec, cfg.TMOS_BOARD_URL ?? "the TM-OS board"),
    });
  } catch (e) {
    // The tasks are already filed; failing to announce them is not worth retrying the whole job.
    logger.warn({ channel_id: channelId, err: (e as Error).message }, "could not post the meeting summary");
  }
}

/**
 * Mine the merged transcript for commitments and file them on the TM-OS board.
 *
 * Idempotency is external_key, and it is deterministic by construction: tasks are ordered as the
 * model returned them and numbered from 1, so `vc:<session>:3` is the same commitment on every
 * replay. The unique index on ops.tasks.external_key is the backstop, and the adapter's insert
 * merges on it rather than erroring, so a re-run is a no-op rather than a failure.
 *
 * The model runs at temperature 0 for the same reason.
 */
export const meetingExtract: Processor<MeetingExtractPayload> = async (ctx: Ctx, p) => {
  const [m] = await ctx.db.select().from(meeting).where(eq(meeting.sessionId, p.session_id)).limit(1);
  if (!m) return { skipped: "unknown_meeting" };
  if (m.transcriptionState !== "transcribed") return { skipped: "not_transcribed", state: m.transcriptionState };

  const [row] = await ctx.db.select().from(transcript).where(eq(transcript.meetingId, m.id)).limit(1);
  const turns = (row?.turns ?? []) as MeetingTurn[];
  const durationSec = m.endedAt && m.startedAt ? (m.endedAt.getTime() - m.startedAt.getTime()) / 1000 : 0;
  if (turns.length === 0) {
    logger.info({ session_id: p.session_id }, "nothing was said; no tasks to file");
    await summarise(ctx.adapters, ctx.cfg, m.discordChannelId, 0, durationSec);
    return { meeting_id: m.id, filed: 0 };
  }

  const [roles, open] = await Promise.all([ctx.adapters.tmos.listRoles(), ctx.adapters.tmos.listOpenTasks()]);

  const completion = await ctx.adapters.llm.complete({
    system: SYSTEM_PROMPT,
    prompt: [
      `Roles on the board: ${roles.map((r) => r.name).join(", ")}`,
      ``,
      `Already open, do not file again:`,
      ...(open.length ? open.map((t) => `- ${t.title}`) : ["- (nothing)"]),
      ``,
      `Transcript:`,
      renderTranscript(turns),
    ].join("\n"),
  });

  const candidates = notAlreadyOpen(
    withVerifiableQuotes(parseTasks(completion.text), turns),
    open.map((t) => t.title),
  );

  const tracks = await ctx.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, m.id));
  const r2Keys = tracks.map((t) => t.r2Key);

  let filed = 0;
  for (const [i, task] of candidates.entries()) {
    const r = await ctx.adapters.tmos.createTask({
      title: task.title,
      owner: TASK_OWNER_CLAUDE,
      role: resolveRole(task.role, roles),
      status: STATUS_NEW,
      source: "vc",
      external_key: externalKey(p.session_id, i + 1),
      notes: buildNotes(task, p.session_id, r2Keys),
    });
    if (r.created) filed += 1;
  }

  await summarise(ctx.adapters, ctx.cfg, m.discordChannelId, candidates.length, durationSec);

  logger.info(
    { session_id: p.session_id, meeting_id: m.id, turns: turns.length, candidates: candidates.length, filed },
    "meeting commitments filed",
  );
  return { meeting_id: m.id, candidates: candidates.length, filed };
};
