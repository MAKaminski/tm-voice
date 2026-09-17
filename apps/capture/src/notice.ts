/**
 * The recording notice. Fixed text, posted before any audio is retained, and written verbatim into
 * the consent_event capture_artifact so what the room was told is recoverable years later.
 *
 * Georgia is one-party consent, but this bot is not a party to the conversation and the meetings
 * are recorded to a durable store, so the notice is given unconditionally and does not depend on
 * where anyone is sitting. docs/COMPLIANCE.md carries the reasoning.
 */
export const RECORDING_NOTICE =
  "Recording started. This voice channel is being recorded and transcribed by the Transparent Maintenance " +
  "meeting bot, and commitments made here are filed as tasks on the TM-OS board. Leave the channel to stop " +
  "being recorded. Details are pinned in this channel.";
