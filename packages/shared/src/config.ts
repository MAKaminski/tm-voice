import { z } from "zod";

export const DIAL_MODES = ["dry_run", "verified_only", "live"] as const;
export type DialMode = (typeof DIAL_MODES)[number];
export const TARGET_SURFACES = ["landline_only", "consented_mobile"] as const;
export type TargetSurface = (typeof TARGET_SURFACES)[number];

const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

/**
 * Vendor keys. Required unless DIAL_MODE=dry_run, in which case adapters fall back to mocks.
 * The list here is the single source of truth and must match infra/env.example.
 */
export const VENDOR_KEYS = [
  "APOLLO_API_KEY",
  "HCP_API_KEY",
  "TELNYX_API_KEY",
  "TELNYX_CONNECTION_ID",
  "TELNYX_PUBLIC_KEY",
  "VAPI_PRIVATE_KEY",
  "VAPI_WEBHOOK_SECRET",
  "VAPI_ASSISTANT_ID",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "RESEND_API_KEY",
  "MAIL_FROM",
  "MS_TENANT_ID",
  "MS_CLIENT_ID",
  "MS_CLIENT_CERT_PEM",
  "MS_BOOKING_MAILBOX",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "DNC_API_KEY",
] as const;
export type VendorKey = (typeof VENDOR_KEYS)[number];

/**
 * The subset the dial path itself calls, and therefore the only keys required to leave dry_run.
 * Requiring all 25 made a single test call depend on nine vendor signups; the rest stay mocked
 * and are reported as `mode:"mock"` by /health plus a boot warning.
 *
 * All three Telnyx keys are required together on purpose: the adapter only goes real when it has
 * every one, and its mock resolves most numbers to "landline" — the one value landline_only
 * accepts. A partial Telnyx config outside dry_run would therefore fail *open* and dial mobiles.
 *
 * Deepgram, ElevenLabs and the LLM are absent because no code here calls them: those keys are
 * pasted into Vapi's own Provider Keys, so demanding them locally gated nothing.
 */
export const DIAL_PATH_VENDOR_KEYS = [
  "TELNYX_API_KEY",
  "TELNYX_CONNECTION_ID",
  "TELNYX_PUBLIC_KEY",
  "VAPI_PRIVATE_KEY",
  "VAPI_WEBHOOK_SECRET",
  "VAPI_ASSISTANT_ID",
  "DNC_API_KEY",
] as const satisfies readonly VendorKey[];

const vendorShape = Object.fromEntries(
  VENDOR_KEYS.map((k) => [k, z.string().min(1).optional()]),
) as Record<VendorKey, z.ZodOptional<z.ZodString>>;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).optional(),
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    API_BASE_URL: z.string().url().default("http://localhost:8787"),
    INTERNAL_API_TOKEN: z.string().min(16),
    PORT: z.coerce.number().int().default(8787),
    DIAL_MODE: z.enum(DIAL_MODES).default("dry_run"),
    DIAL_ALLOWLIST: z
      .string()
      .default("")
      .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
    COMPLIANCE_TARGET_SURFACE: z.enum(TARGET_SURFACES).default("landline_only"),
    AUTO_BOOK: bool.default(false),
    ALLOW_MA_RECORDING: bool.default(false),
    ...vendorShape,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.DIAL_MODE !== "dry_run") {
      const missing = DIAL_PATH_VENDOR_KEYS.filter((k) => !cfg[k]);
      if (missing.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `DIAL_MODE=${cfg.DIAL_MODE} requires the dial-path vendor keys; missing: ${missing.join(", ")}`,
        });
      }
      if (cfg.DIAL_MODE === "verified_only" && cfg.DIAL_ALLOWLIST.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "DIAL_MODE=verified_only requires a non-empty DIAL_ALLOWLIST",
        });
      }
      if (!cfg.REDIS_URL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "REDIS_URL is required outside dry_run" });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

/**
 * A variable set to an empty (or whitespace-only) string means "not set".
 * Railway hands a declared-but-blank variable to the container as "", and
 * infra/env.example ships every vendor key blank — both must read as absent
 * so dry_run boots on mocks instead of failing `.min(1)`.
 */
function dropBlanks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => typeof v !== "string" || v.trim() !== ""),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(dropBlanks(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
export function resetConfigForTests(): void {
  cached = undefined;
}
