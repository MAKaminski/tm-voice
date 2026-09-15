/**
 * Voice-profile ↔ docs check. `pnpm voice:check` fails when docs/ARCHITECTURE.md's generated block
 * drifts from the profile in packages/adapters/src/vapi/voice.ts, or when that profile is not a
 * shape ElevenLabs will honour. `pnpm voice:write` regenerates the block. CI runs the check.
 *
 * Why this exists: Joe's voice used to live only in the Vapi dashboard, where a change to how the
 * agent sounds to a prospect left no trace. Now every change to it is a reviewable diff in two
 * places at once — the tuning and the document a reader actually opens.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SPEED_MAX, SPEED_MIN, VOICE_PROFILE, voiceProfileSchema } from "@tm/adapters";

const START = "<!-- voice:generated -->", END = "<!-- /voice:generated -->";

/** One line per knob, with the range, so a reviewer can judge a diff without opening the docs. */
const NOTES: Record<keyof typeof VOICE_PROFILE, string> = {
  model: "ElevenLabs model. V2-or-newer is required for `style` to have any effect",
  stability: "0–1. Lower is more expressive; high stability flattens prosody into a monotone",
  similarityBoost: "0–1. Adherence to the source recording. Raising it re-flattens delivery",
  style: "0–1. Style exaggeration. 0 is the flat read; higher costs some latency",
  useSpeakerBoost: "Keeps the speaker's timbre while the settings above loosen up",
  speed: `${SPEED_MIN}–${SPEED_MAX}. Below 1.0 reads as downbeat`,
};

function render(): string {
  const lines = [
    "```",
    "# Joe's ElevenLabs voice, as applied to VAPI_ASSISTANT_ID by the vapi.syncAssistant job.",
    "# Generated from packages/adapters/src/vapi/voice.ts; do not hand-edit. Run: pnpm voice:write",
  ];
  for (const [k, v] of Object.entries(VOICE_PROFILE)) {
    lines.push(`  ${k.padEnd(16)}${String(v).padEnd(18)}${NOTES[k as keyof typeof VOICE_PROFILE]}`);
  }
  lines.push("```");
  return lines.join("\n");
}

const problems: string[] = [];

/**
 * The profile is a shape the vendor accepts. The schema owns the rules, including the one that
 * looks like nothing at all when it is broken: a `style` set on a model that ignores it, where the
 * PATCH succeeds, the dashboard shows the value, and the call still sounds flat.
 */
const parsed = voiceProfileSchema.safeParse(VOICE_PROFILE);
if (!parsed.success) {
  for (const i of parsed.error.issues) problems.push(`voice profile ${i.path.join(".") || "(root)"}: ${i.message}`);
}

const path = new URL("../docs/ARCHITECTURE.md", import.meta.url);
const doc = readFileSync(path, "utf8");
const s = doc.indexOf(START), e = doc.indexOf(END);
if (s < 0 || e < 0) {
  console.error(`docs/ARCHITECTURE.md must contain ${START} … ${END}`);
  process.exit(1);
}

if (problems.length) {
  console.error("voice-check failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const current = doc.slice(s + START.length, e).trim();
const fresh = render();
if (process.argv.includes("--write")) {
  writeFileSync(path, doc.slice(0, s + START.length) + "\n" + fresh + "\n" + doc.slice(e));
  console.log("docs/ARCHITECTURE.md voice block regenerated");
} else if (current !== fresh) {
  console.error("docs/ARCHITECTURE.md is out of date with packages/adapters/src/vapi/voice.ts. Run: pnpm voice:write");
  process.exit(1);
} else {
  console.log(`voice-check: ${Object.keys(VOICE_PROFILE).length} settings match docs/ARCHITECTURE.md`);
}
