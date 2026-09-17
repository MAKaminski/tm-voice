"use client";
import { useState, useTransition } from "react";
import { type Campaign, type PendingBooking, fmtEt } from "@/lib/api";
import { type ReviewResult, reviewBooking, setCampaignStatus } from "./actions";

/**
 * The reviewer's screen. AUTO_BOOK is settled false, so every booking the agent creates waits
 * here — until now the only way to decide one was to POST to the api by hand.
 */
export function ReviewQueue({ pending, campaigns }: { pending: PendingBooking[]; campaigns: Campaign[] }) {
  // Typed once and reused for every decision in the session. See actions.ts on why this is typed
  // rather than taken from a session: the console has no authentication.
  const [reviewedBy, setReviewedBy] = useState("");
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [busy, startTransition] = useTransition();
  const [acting, setActing] = useState<string | null>(null);

  const run = (key: string, fn: () => Promise<ReviewResult>) => {
    setActing(key);
    startTransition(async () => {
      setResult(await fn());
      setActing(null);
    });
  };

  return (
    <>
      <h1>Review queue</h1>

      <p className="lede">
        Every booking waits for a person: <code>AUTO_BOOK</code> is false, so nothing reaches
        Housecall Pro, the calendar or the prospect&rsquo;s inbox until it is approved here.
      </p>

      {result && (
        <div className={`empty ${result.ok ? "" : "bad"}`} role="status" aria-live="polite">{result.message}</div>
      )}

      <label className="field">
        Your name
        <input
          value={reviewedBy}
          onChange={(e) => setReviewedBy(e.target.value)}
          placeholder="Goes on the record for every decision below"
          autoComplete="name"
        />
      </label>

      <h2>Pending bookings</h2>
      {pending.length === 0 ? (
        <div className="empty">Nothing waiting.</div>
      ) : (
        <table>
          <thead><tr><th>Contact</th><th>Phone</th><th>Technician</th><th>Window (ET)</th><th /></tr></thead>
          <tbody>
            {pending.map(({ booking: b, contact, technician }) => (
              <tr key={b.id}>
                <td>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—"}</td>
                <td>{contact.phone}</td>
                <td>{technician.name}</td>
                <td>{fmtEt(b.windowStart)}</td>
                <td>
                  <button
                    className="act"
                    onClick={() => run(`${b.id}:approve`, () => reviewBooking(b.id, "approve", reviewedBy))}
                    disabled={busy}
                  >
                    {acting === `${b.id}:approve` ? "Approving…" : "Approve"}
                  </button>{" "}
                  <button
                    className="act"
                    onClick={() => run(`${b.id}:reject`, () => reviewBooking(b.id, "reject", reviewedBy))}
                    disabled={busy}
                  >
                    {acting === `${b.id}:reject` ? "Rejecting…" : "Reject"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Campaigns</h2>
      <p className="lede">
        Pausing stops the next call being placed. A call already in progress finishes — dropping a
        live call on a prospect mid-sentence is worse than letting it end.
      </p>
      {campaigns.length === 0 ? (
        <div className="empty">No campaigns.</div>
      ) : (
        <table>
          <thead><tr><th>Campaign</th><th>Status</th><th>Daily cap</th><th /></tr></thead>
          <tbody>
            {campaigns.map((camp) => (
              <tr key={camp.id}>
                <td>{camp.name}</td>
                <td><span className={`pill ${camp.status === "active" ? "warn" : ""}`}>{camp.status}</span></td>
                <td>{camp.dailyDialCap}</td>
                <td>
                  {camp.status === "active" ? (
                    <button className="act" onClick={() => run(`${camp.id}:pause`, () => setCampaignStatus(camp.id, "paused"))} disabled={busy}>
                      {acting === `${camp.id}:pause` ? "Stopping…" : "Stop dialling"}
                    </button>
                  ) : (
                    <button className="act" onClick={() => run(`${camp.id}:active`, () => setCampaignStatus(camp.id, "active"))} disabled={busy}>
                      {acting === `${camp.id}:active` ? "Resuming…" : "Resume"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
