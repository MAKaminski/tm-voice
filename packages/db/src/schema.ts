/**
 * Drizzle schema = the ERD. docs/ERD.md is diffed against this file in CI (scripts/erd-check.ts).
 * External vendor IDs are plain nullable text columns, never primary keys.
 */
import { sql } from "drizzle-orm";
import {
  boolean, date, index, integer, jsonb, numeric, pgSchema, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * All agent-owned tables live in the "agents" schema, never in public or ops.
 * drizzle.config.ts pins schemaFilter to ["agents"] so no migration can ever reach the CRM tables.
 */
export const agents = pgSchema("agents");

export const accountType = agents.enum("account_type", ["property_mgr", "homeowner"]);
export const lineType = agents.enum("line_type", ["wireless", "landline", "voip", "unknown"]);
export const campaignStatus = agents.enum("campaign_status", ["draft", "active", "paused", "completed"]);
export const callTaskStatus = agents.enum("call_task_status", ["queued", "claimed", "dialed", "blocked", "done"]);
export const gateResult = agents.enum("gate_result", ["pass", "surface", "suppressed", "dnc", "window", "did_cap", "attempts"]);
export const disposition = agents.enum("disposition", [
  "dry_run", "booked", "callback", "not_interested", "opt_out", "voicemail", "no_answer", "busy", "failed", "wrong_number",
]);
export const consentEventType = agents.enum("consent_event_type", ["grant", "revoke"]);
export const bookingStatus = agents.enum("booking_status", ["pending_review", "approved", "rejected", "synced", "failed"]);
export const scheduleBlockSource = agents.enum("schedule_block_source", ["hcp_job", "pto", "window"]);
/**
 * Per-row transcription state. It lives on speaker_track as well as meeting so that a crash
 * part-way through a multi-speaker transcode resumes on the tracks still pending, rather than
 * re-transcribing (and re-filing) the ones already done.
 */
export const transcriptionState = agents.enum("transcription_state", ["pending", "transcribing", "transcribed", "failed"]);

export const account = agents.table("account", {
  id: id(),
  name: text("name").notNull(),
  type: accountType("type").notNull().default("property_mgr"),
  apolloAccountId: text("apollo_account_id"),
  hcpCustomerId: text("hcp_customer_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const contact = agents.table(
  "contact",
  {
    id: id(),
    accountId: uuid("account_id").notNull().references(() => account.id),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phoneE164: text("phone_e164").notNull(),
    lineType: lineType("line_type").notNull().default("unknown"),
    state: text("state"),
    timezone: text("timezone").notNull().default("America/New_York"),
    apolloContactId: text("apollo_contact_id"),
    dncFederal: boolean("dnc_federal").notNull().default(false),
    dncState: boolean("dnc_state").notNull().default(false),
    dncCheckedAt: timestamp("dnc_checked_at", { withTimezone: true }),
    /** Last Telnyx carrier lookup. Null means line_type has never been verified, only defaulted. */
    lineTypeCheckedAt: timestamp("line_type_checked_at", { withTimezone: true }),
    bookingToken: text("booking_token").notNull().default(sql`gen_random_uuid()::text`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contact_phone_idx").on(t.phoneE164), uniqueIndex("contact_booking_token_uq").on(t.bookingToken)],
).enableRLS();

export const serviceAddress = agents.table("service_address", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => account.id),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  lat: numeric("lat", { precision: 9, scale: 6 }),
  lon: numeric("lon", { precision: 9, scale: 6 }),
  hcpAddressId: text("hcp_address_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const scriptVersion = agents.table("script_version", {
  id: id(),
  name: text("name").notNull(),
  disclosureLine: text("disclosure_line").notNull(),
  body: text("body").notNull().default(""),
  active: boolean("active").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const campaign = agents.table("campaign", {
  id: id(),
  name: text("name").notNull(),
  scriptVersionId: uuid("script_version_id").notNull().references(() => scriptVersion.id),
  apolloSavedSearchId: text("apollo_saved_search_id"),
  dailyDialCap: integer("daily_dial_cap").notNull().default(50),
  maxAttempts: integer("max_attempts").notNull().default(3),
  status: campaignStatus("status").notNull().default("draft"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const callTask = agents.table(
  "call_task",
  {
    id: id(),
    campaignId: uuid("campaign_id").notNull().references(() => campaign.id),
    contactId: uuid("contact_id").notNull().references(() => contact.id),
    earliestDialAt: timestamp("earliest_dial_at", { withTimezone: true }).notNull().defaultNow(),
    attemptNo: integer("attempt_no").notNull().default(0),
    status: callTaskStatus("status").notNull().default("queued"),
    gateResult: gateResult("gate_result"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("call_task_claim_idx").on(t.campaignId, t.earliestDialAt).where(sql`status = 'queued'`),
    // One task per contact per campaign: re-attempts increment attempt_no on the same row rather
    // than inserting another. Lets campaign ingestion re-run idempotently with onConflictDoNothing.
    uniqueIndex("call_task_campaign_contact_uq").on(t.campaignId, t.contactId),
  ],
).enableRLS();

export const did = agents.table("did", {
  id: id(),
  phoneE164: text("phone_e164").notNull().unique(),
  attestation: text("attestation").notNull().default("A"),
  dailyCap: integer("daily_cap").notNull().default(50),
  labelStatus: text("label_status").notNull().default("unknown"),
  telnyxNumberId: text("telnyx_number_id"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const call = agents.table("call", {
  id: id(),
  callTaskId: uuid("call_task_id").notNull().references(() => callTask.id),
  didId: uuid("did_id").references(() => did.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSec: integer("duration_sec").notNull().default(0),
  disposition: disposition("disposition"),
  apolloPhoneCallId: text("apollo_phone_call_id"),
  vapiCallId: text("vapi_call_id"),
  telnyxCallControlId: text("telnyx_call_control_id"),
  /**
   * The carrier's own reason the call ended, from the Telnyx hangup event. Distinct from Vapi's
   * `endedReason`: Vapi reports what the assistant saw, this is what the network did. The two
   * disagree in the cases worth knowing about — a number that rings out versus one the carrier
   * rejected both look like "no answer" from above.
   */
  telnyxHangupCause: text("telnyx_hangup_cause"),
  /**
   * Telnyx's charge for its leg, kept apart from `cost_usd` (Vapi's platform cost) rather than
   * summed. They are different vendors' numbers and adding them at write time would make the
   * cost-per-dial table in docs/RUNBOOK.md impossible to reconcile against either invoice.
   */
  telnyxCostUsd: numeric("telnyx_cost_usd", { precision: 8, scale: 4 }),
  costUsd: numeric("cost_usd", { precision: 8, scale: 4 }).notNull().default("0"),
  /**
   * Whether the fixed disclosure line was spoken verbatim as the first utterance (rule 10).
   * NULL means not assessed — no transcript, or no script version to compare against.
   *
   * Persisted rather than only logged because it is the one field here with legal exposure: a
   * campaign could breach rule 10 on every dial for a day and, while this was a log line, the only
   * trace would have been in a log retention window. Now it is queryable after the fact.
   */
  disclosureOk: boolean("disclosure_ok"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/**
 * A Discord voice meeting captured by apps/capture. Unrelated to the dial path: a meeting has no
 * call_task and no PSTN leg. `session_id` is minted by the capture service on join and is the
 * idempotency anchor for the whole downstream pipeline.
 */
export const meeting = agents.table(
  "meeting",
  {
    id: id(),
    discordGuildId: text("discord_guild_id").notNull(),
    discordChannelId: text("discord_channel_id").notNull(),
    sessionId: text("session_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    participantCount: integer("participant_count").notNull().default(0),
    transcriptionState: transcriptionState("transcription_state").notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meeting_session_uq").on(t.sessionId),
    index("meeting_channel_idx").on(t.discordChannelId, t.startedAt),
  ],
).enableRLS();

/** One row per participant stream. Opus is received per-SSRC, so each speaker is a separate track. */
export const speakerTrack = agents.table(
  "speaker_track",
  {
    id: id(),
    meetingId: uuid("meeting_id").notNull().references(() => meeting.id),
    discordUserId: text("discord_user_id").notNull(),
    displayName: text("display_name"),
    r2Key: text("r2_key").notNull(),
    durationSec: integer("duration_sec").notNull().default(0),
    byteSize: integer("byte_size").notNull().default(0),
    transcriptionState: transcriptionState("transcription_state").notNull().default("pending"),
    /** stt-batch output: [{ start_sec, end_sec, text }]. Empty until the track is transcribed. */
    segments: jsonb("segments").notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("speaker_track_meeting_user_uq").on(t.meetingId, t.discordUserId)],
).enableRLS();

/**
 * Exactly one parent: a `call` (dial path) or a `speaker_track` (Discord capture). Enforced by
 * CHECK recording_one_parent in migrations/0007_meeting_parents.sql, not by drizzle.
 * `retain_until` keeps its 5-year floor for both, so meeting audio is swept on the same clock.
 */
export const recording = agents.table("recording", {
  id: id(),
  callId: uuid("call_id").references(() => call.id),
  meetingId: uuid("meeting_id").references(() => meeting.id),
  speakerTrackId: uuid("speaker_track_id").references(() => speakerTrack.id),
  r2Key: text("r2_key").notNull(),
  signedUrl: text("signed_url"),
  signedUrlExpiresAt: timestamp("signed_url_expires_at", { withTimezone: true }),
  retainUntil: date("retain_until").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/** Exactly one parent: a `call` or a `meeting` (CHECK transcript_one_parent, migration 0007). */
export const transcript = agents.table("transcript", {
  id: id(),
  callId: uuid("call_id").references(() => call.id),
  meetingId: uuid("meeting_id").references(() => meeting.id),
  turns: jsonb("turns").notNull().default([]),
  summary: text("summary"),
  /** Vapi call analysis (structuredDataPlan): the fields the assistant captured, e.g. contact_email, packet_type, outcome. */
  structured: jsonb("structured"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/**
 * Append-only: a DB trigger (migrations/0001_consent_immutable.sql) rejects UPDATE and DELETE.
 * Exactly one subject: contact_id (phone) or meeting_id (Discord) — CHECK consent_event_one_subject.
 */
export const consentEvent = agents.table(
  "consent_event",
  {
    id: id(),
    contactId: uuid("contact_id").references(() => contact.id),
    callId: uuid("call_id").references(() => call.id),
    /** Set instead of contact_id when the notice was given in a Discord channel, not on a call. */
    meetingId: uuid("meeting_id").references(() => meeting.id),
    eventType: consentEventType("event_type").notNull(),
    channel: text("channel").notNull(),
    captureArtifact: jsonb("capture_artifact").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("consent_event_contact_idx").on(t.contactId, t.occurredAt)],
).enableRLS();

/** Keys on phone number, never on contact. */
export const suppression = agents.table("suppression", {
  id: id(),
  phoneE164: text("phone_e164").notNull().unique(),
  reason: text("reason").notNull(),
  sourceCallId: uuid("source_call_id").references(() => call.id),
  createdAt: createdAt(),
}).enableRLS();

export const technician = agents.table("technician", {
  id: id(),
  name: text("name").notNull(),
  /** Needed to invite them to the booking's calendar event; HCP employees carry one. */
  email: text("email"),
  hcpEmployeeId: text("hcp_employee_id"),
  maxJobsPerDay: integer("max_jobs_per_day").notNull().default(2),
  maxMilesBetweenJobs: integer("max_miles_between_jobs").notNull().default(50),
  homeLat: numeric("home_lat", { precision: 9, scale: 6 }),
  homeLon: numeric("home_lon", { precision: 9, scale: 6 }),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const scheduleBlock = agents.table(
  "schedule_block",
  {
    id: id(),
    technicianId: uuid("technician_id").notNull().references(() => technician.id),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    source: scheduleBlockSource("source").notNull(),
    hcpJobId: text("hcp_job_id"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lon: numeric("lon", { precision: 9, scale: 6 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("schedule_block_tech_start_idx").on(t.technicianId, t.startAt)],
).enableRLS();

export const booking = agents.table(
  "booking",
  {
    id: id(),
    callId: uuid("call_id").references(() => call.id),
    contactId: uuid("contact_id").notNull().references(() => contact.id),
    technicianId: uuid("technician_id").notNull().references(() => technician.id),
    serviceAddressId: uuid("service_address_id").notNull().references(() => serviceAddress.id),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    arrivalWindowMin: integer("arrival_window_min").notNull().default(120),
    hcpJobId: text("hcp_job_id"),
    status: bookingStatus("status").notNull().default("pending_review"),
    idempotencyKey: text("idempotency_key").notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("booking_idempotency_uq").on(t.idempotencyKey)],
).enableRLS();

export const calendarInvite = agents.table("calendar_invite", {
  id: id(),
  bookingId: uuid("booking_id").notNull().references(() => booking.id),
  graphEventId: text("graph_event_id"),
  rsvpStatus: text("rsvp_status").notNull().default("none"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const emailSend = agents.table(
  "email_send",
  {
    id: id(),
    bookingId: uuid("booking_id").notNull().references(() => booking.id),
    template: text("template").notNull(),
    providerMessageId: text("provider_message_id"),
    status: text("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("email_send_idempotency_uq").on(t.idempotencyKey)],
).enableRLS();

export const schema = {
  account, contact, serviceAddress, scriptVersion, campaign, callTask, did, call, meeting, speakerTrack,
  recording, transcript, consentEvent, suppression, technician, scheduleBlock, booking, calendarInvite,
  emailSend,
};
