"use server";
import { type Booking, apiPost } from "@/lib/api";

export async function submitBooking(token: string, body: { technician_id: string; service_address_id: string; window_start: string; arrival_window_min: number }) {
  const r = await apiPost<{ booking: Booking }>(`/book/${encodeURIComponent(token)}`, body);
  if (r.status === 201 || r.status === 200) {
    return { ok: true as const, message: r.data?.booking.status === "pending_review" ? "A member of our team will confirm within one business day and send a calendar invite." : "Confirmed. A calendar invite is on its way." };
  }
  if (r.status === 409) return { ok: false as const, message: "That time was just taken. Please pick another." };
  if (r.status === 404) return { ok: false as const, message: "This link is no longer valid." };
  return { ok: false as const, message: "Something went wrong. Please try again." };
}
