/** Console never touches the DB. Everything goes through apps/api with INTERNAL_API_TOKEN (server-side only). */
const API = process.env.API_BASE_URL ?? "http://localhost:8787";
const TOKEN = process.env.INTERNAL_API_TOKEN ?? "";

export async function apiGet<T>(path: string, opts: { internal?: boolean } = {}): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: opts.internal ? { authorization: `Bearer ${TOKEN}` } : {}, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

export async function apiPost<T>(path: string, body: unknown, opts: { internal?: boolean } = {}): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(opts.internal ? { authorization: `Bearer ${TOKEN}` } : {}) }, cache: "no-store",
    });
    return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
  } catch { return { status: 0, data: null }; }
}

export async function apiPatch<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "PATCH", body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, cache: "no-store",
    });
    return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
  } catch { return { status: 0, data: null }; }
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
