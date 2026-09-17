"use server";
import { revalidatePath } from "next/cache";
import { type Booking, type Campaign, apiPatch, apiPost } from "@/lib/api";

export type ReviewResult = { ok: boolean; message: string };

/**
 * Approve or reject one booking.
 *
 * `reviewed_by` is typed by the reviewer because the console has no authentication of any kind —
 * no session, no middleware, nothing that knows who is looking at the page. So the audit trail in
 * `booking.reviewed_by` is self-asserted, and that is a real limitation rather than a design: it
 * is recorded in docs/RUNBOOK.md as the reason the console needs auth before more than a handful
 * of people use it. A free-text name is still better than writing "console" on every row.
 */
export async function reviewBooking(id: string, decision: "approve" | "reject", reviewedBy: string): Promise<ReviewResult> {
  const name = reviewedBy.trim();
  if (!name) return { ok: false, message: "Enter your name first — it goes on the record for this decision." };

  const r = await apiPost<{ booking: Booking }>(`/bookings/${encodeURIComponent(id)}/review`, { decision, reviewed_by: name }, { internal: true });
  if (r.status === 200) {
    revalidatePath("/review");
    return {
      ok: true,
      message: decision === "approve"
        // Approval is not the end of it: three fulfillment jobs run afterwards and can each fail.
        ? "Approved. The job, the calendar invite and the email are queued."
        : "Rejected. Nothing was sent.",
    };
  }
  // The realistic failure: two reviewers on the same booking. Saying so beats a generic error.
  if (r.status === 409) { revalidatePath("/review"); return { ok: false, message: "Someone already decided this one." }; }
  if (r.status === 401) return { ok: false, message: "The console is not authorised against the api. Check INTERNAL_API_TOKEN." };
  return { ok: false, message: `Could not record that decision (HTTP ${r.status || "no response"}).` };
}

/** Pause or resume a campaign. The gate refuses to claim work for a campaign that is not active. */
export async function setCampaignStatus(id: string, status: "active" | "paused"): Promise<ReviewResult> {
  const r = await apiPatch<{ campaign: Campaign }>(`/campaigns/${encodeURIComponent(id)}`, { status });
  if (r.status === 200) {
    revalidatePath("/review");
    return {
      ok: true,
      message: status === "paused"
        // Worth being precise: pausing stops the next dial, it does not hang up a live call.
        ? "Paused. No new calls will be placed; any call already in progress will finish."
        : "Resumed. Dialling will pick up on the next tick.",
    };
  }
  return { ok: false, message: `Could not change the campaign (HTTP ${r.status || "no response"}).` };
}
