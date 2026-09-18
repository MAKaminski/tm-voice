"use client";
import { useState, useTransition } from "react";
import { fmtEt } from "@/lib/api";
import { type TestCallResult, placeTestCall } from "./actions";

export interface CallRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  disposition: string | null;
  disclosureOk: boolean | null;
  costUsd: string | null;
  vapiCallId: string | null;
  phoneE164: string;
  firstName: string | null;
  lastName: string | null;
  campaignName: string;
  assistantId: string | null;
  gateResult: string | null;
  taskStatus: string;
}

export interface TaskRow {
  id: string;
  status: string;
  gateResult: string | null;
  attemptNo: number;
  assistantId: string | null;
  updatedAt: string;
  phoneE164: string;
  campaignName: string;
}

const named = (r: CallRow) => [r.firstName, r.lastName].filter(Boolean).join(" ") || "—";

/** Anything that is not a completed conversation is worth colouring, so a red run is visible at a glance. */
const dispositionClass = (d: string | null) =>
  d === "booked" ? "" : d === "failed" || d === "opt_out" ? "bad" : d ? "warn" : "";

export function CallsScreen({
  calls, blocked, dialMode, defaultAssistant,
}: {
  calls: CallRow[];
  blocked: TaskRow[];
  dialMode: string;
  defaultAssistant: string | null;
}) {
  const [phone, setPhone] = useState("");
  const [attestedBy, setAttestedBy] = useState("");
  const [attested, setAttested] = useState(false);
  const [assistantId, setAssistantId] = useState("");
  const [result, setResult] = useState<TestCallResult | null>(null);
  const [busy, startTransition] = useTransition();

  const submit = () => {
    startTransition(async () => {
      const r = await placeTestCall(phone, attestedBy, attested, assistantId);
      setResult(r);
      if (r.ok) { setPhone(""); setAttested(false); }
    });
  };

  return (
    <>
      <h1>Calls</h1>

      <p className="lede">
        Place a test call and see every call the system has made. A test call is not a shortcut: it
        creates the same rows and runs the same pre-dial gate as a campaign dial, so what you are
        testing is the system rather than a bypass of it.
      </p>

      <div className="card">
        <h2>Place a test call</h2>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted)" }}>
          <span className={`pill ${dialMode === "live" ? "bad" : ""}`}>DIAL_MODE {dialMode}</span>{" "}
          {dialMode === "dry_run"
            ? "No real call is placed in dry_run — the adapter returns a synthetic call and the row is recorded as dry_run."
            : "This dials a real phone."}
        </p>

        <label className="field">
          Phone number (E.164)
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+14045550100" inputMode="tel" />
        </label>

        <label className="field">
          Assistant id <span style={{ color: "var(--muted)" }}>— blank uses {defaultAssistant ?? "the deployment default"} (Joe)</span>
          <input value={assistantId} onChange={(e) => setAssistantId(e.target.value)} placeholder={defaultAssistant ?? "VAPI_ASSISTANT_ID"} />
        </label>

        <label className="field">
          Your name
          <input value={attestedBy} onChange={(e) => setAttestedBy(e.target.value)} placeholder="Michael Kaminski" />
        </label>

        {/*
          The gate refuses a mobile without a consent grant. This checkbox is what creates that
          grant, so it is worded as the claim it actually records — not as a formality to click past.
        */}
        <label className="field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            I own this number, or I have the account holder&rsquo;s permission to call it for testing.
            <br />
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              This writes a consent grant against the number, recorded as a console attestation with your name and the time.
              It is append-only and cannot be edited afterwards.
            </span>
          </span>
        </label>

        <button onClick={submit} disabled={busy}>{busy ? "Placing…" : "Place test call"}</button>

        {result && (
          <div className={`empty ${result.ok ? "" : "bad"}`} role="status" aria-live="polite" style={{ marginTop: 12 }}>
            {result.message}
          </div>
        )}
      </div>

      <h2>Blocked before dialling</h2>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)" }}>
        Tasks the gate refused, or that are still queued. A blocked task never becomes a call, so it
        would otherwise look like nothing happened.
      </p>
      {blocked.length === 0 ? (
        <div className="empty">Nothing queued or blocked.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Number</th><th>Campaign</th><th>Status</th><th>Gate</th><th>Attempt</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {blocked.map((t) => (
              <tr key={t.id}>
                <td>{t.phoneE164}</td>
                <td>{t.campaignName}</td>
                <td><span className={`pill ${t.status === "blocked" ? "bad" : ""}`}>{t.status}</span></td>
                <td>{t.gateResult ? <span className="pill bad">{t.gateResult}</span> : "—"}</td>
                <td>{t.attemptNo}</td>
                <td>{fmtEt(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Call log</h2>
      {calls.length === 0 ? (
        <div className="empty">No calls placed yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started (ET)</th><th>Number</th><th>Name</th><th>Campaign</th>
              <th>Assistant</th><th>Disposition</th><th>Disclosure</th><th>Sec</th><th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((r) => (
              <tr key={r.id}>
                <td>{fmtEt(r.startedAt)}</td>
                <td>{r.phoneE164}</td>
                <td>{named(r)}</td>
                <td>{r.campaignName}</td>
                <td style={{ fontSize: 12, color: "var(--muted)" }}>{r.assistantId ?? "default"}</td>
                <td>{r.disposition ? <span className={`pill ${dispositionClass(r.disposition)}`}>{r.disposition}</span> : <span className="pill warn">in flight</span>}</td>
                <td>{r.disclosureOk === null ? "—" : r.disclosureOk ? "ok" : <span className="pill bad">missing</span>}</td>
                <td>{r.durationSec ?? "—"}</td>
                <td>{r.costUsd ? `$${r.costUsd}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
