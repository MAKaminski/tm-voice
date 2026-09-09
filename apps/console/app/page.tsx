import { type Booking, apiGet, fmtEt } from "@/lib/api";

interface Campaign { id: string; name: string; status: string; dailyDialCap: number; maxAttempts: number }
interface Health { ok: boolean; dial_mode: string; target_surface: string; auto_book: boolean; vendors: { vendor: string; mode: string; ok: boolean }[] }

export default async function Dashboard() {
  const [health, campaigns, pending] = await Promise.all([
    apiGet<Health>("/health"),
    apiGet<{ campaigns: Campaign[] }>("/campaigns", { internal: true }),
    apiGet<{ bookings: { booking: Booking; contact: { firstName: string; lastName: string }; technician: { name: string } }[] }>("/bookings?status=pending_review", { internal: true }),
  ]);
  return (
    <>
      <h1>Campaign console</h1>
      <p className="lede">Phase 0–2 scaffold. Campaign creation, live board and review actions arrive in Phases 4–6.</p>
      <div className="card">
        {health ? (
          <>
            <span className={`pill ${health.dial_mode === "live" ? "bad" : ""}`}>DIAL_MODE {health.dial_mode}</span>{" "}
            <span className="pill">{health.target_surface}</span>{" "}
            <span className={`pill ${health.auto_book ? "warn" : ""}`}>AUTO_BOOK {String(health.auto_book)}</span>
            <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--muted)" }}>
              Vendors: {health.vendors.map((v) => `${v.vendor} (${v.mode}${v.ok ? "" : " ✗"})`).join(" · ")}
            </p>
          </>
        ) : <span className="err">API unreachable — is apps/api running on API_BASE_URL?</span>}
      </div>
      <h2>Campaigns</h2>
      {campaigns?.campaigns.length ? (
        <table><thead><tr><th>Name</th><th>Status</th><th>Daily cap</th><th>Max attempts</th></tr></thead>
          <tbody>{campaigns.campaigns.map((c) => <tr key={c.id}><td>{c.name}</td><td><span className="pill">{c.status}</span></td><td>{c.dailyDialCap}</td><td>{c.maxAttempts}</td></tr>)}</tbody></table>
      ) : <div className="empty">No campaigns yet. Run <code>pnpm db:seed</code>.</div>}
      <h2>Bookings awaiting review</h2>
      {pending?.bookings.length ? (
        <table><thead><tr><th>Contact</th><th>Technician</th><th>Window (ET)</th><th>Status</th></tr></thead>
          <tbody>{pending.bookings.map(({ booking: b, contact, technician }) => <tr key={b.id}><td>{contact.firstName} {contact.lastName}</td><td>{technician.name}</td><td>{fmtEt(b.windowStart)}</td><td><span className="pill warn">{b.status}</span></td></tr>)}</tbody></table>
      ) : <div className="empty">Nothing pending.</div>}
    </>
  );
}
