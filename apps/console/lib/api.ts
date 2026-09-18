/** Console never touches the DB. Everything goes through apps/api with INTERNAL_API_TOKEN (server-side only). */
const API = process.env.API_BASE_URL ?? "http://localhost:8787";
const TOKEN = process.env.INTERNAL_API_TOKEN ?? "";

/**
 * Why a call failed, on the server's stdout.
 *
 * Every helper here used to end in `catch { return null }`, and a non-2xx returned null too. So the
 * Calls tab could say "Could not reach the api" while the console knew — and threw away — whether
 * that was a refused connection, a DNS miss, a timeout or a 401. Diagnosing it meant reading the
 * *api's* log and reasoning from the absence of a line, which is the hardest evidence there is.
 *
 * The host is logged because it is the field most likely to be wrong; the token never is.
 */
function why(path: string, detail: string): null {
  console.error(`[console→api] ${path} failed: ${detail} (API_BASE_URL host: ${hostOf(API)})`);
  return null;
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return `unparseable: ${u}`; } };
const reason = (e: unknown) => {
  const err = e as { cause?: { code?: string }; code?: string; message?: string };
  const code = err?.cause?.code ?? err?.code;
  return code ? `${code} ${err.message ?? ""}`.trim() : (err?.message ?? String(e));
};

export async function apiGet<T>(path: string, opts: { internal?: boolean } = {}): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: opts.internal ? { authorization: `Bearer ${TOKEN}` } : {}, cache: "no-store" });
    if (!res.ok) return why(path, `HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) { return why(path, reason(e)); }
}

export async function apiPost<T>(path: string, body: unknown, opts: { internal?: boolean } = {}): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(opts.internal ? { authorization: `Bearer ${TOKEN}` } : {}) }, cache: "no-store",
    });
    if (!res.ok) why(path, `HTTP ${res.status}`);
    return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
  } catch (e) { why(path, reason(e)); return { status: 0, data: null }; }
}

export async function apiPatch<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "PATCH", body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, cache: "no-store",
    });
    if (!res.ok) why(path, `HTTP ${res.status}`);
    return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
  } catch (e) { why(path, reason(e)); return { status: 0, data: null }; }
}

export interface Slot { technician_id: string; technician_name: string; window_start: string; window_end: string; arrival_window_min: number; day: string }
export interface BookPage { contact: { first_name: string | null; last_name: string | null }; addresses: { id: string; line1: string; city: string | null; state: string | null }[]; slots: Slot[] }
export interface Booking { id: string; status: string; windowStart: string; arrivalWindowMin: number; createdAt: string }
export interface PendingBooking {
  booking: Booking;
  contact: { firstName: string | null; lastName: string | null; phone: string };
  technician: { name: string };
}
export interface Campaign { id: string; name: string; status: string; dailyDialCap: number; maxAttempts: number }

export const fmtEt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
