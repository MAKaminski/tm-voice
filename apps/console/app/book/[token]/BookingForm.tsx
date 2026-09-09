"use client";
import { useState } from "react";
import { type Slot, fmtEt } from "@/lib/api";
import { submitBooking } from "./actions";

export function BookingForm({ token, serviceAddressId, slots }: { token: string; serviceAddressId: string; slots: Slot[] }) {
  const [picked, setPicked] = useState<Slot | null>(null);
  const [state, setState] = useState<{ status: "idle" | "busy" | "done" | "error"; message?: string }>({ status: "idle" });

  async function submit() {
    if (!picked) return;
    setState({ status: "busy" });
    const r = await submitBooking(token, { technician_id: picked.technician_id, service_address_id: serviceAddressId, window_start: picked.window_start, arrival_window_min: picked.arrival_window_min });
    if (r.ok) setState({ status: "done", message: r.message });
    else setState({ status: "error", message: r.message });
  }

  if (state.status === "done") {
    return <div className="card"><strong>Request received.</strong><p style={{ margin: "6px 0 0" }}>{state.message}</p></div>;
  }
  return (
    <>
      <div className="slots">
        {slots.map((s) => (
          <button key={`${s.technician_id}:${s.window_start}`} type="button" className="slot" aria-pressed={picked?.window_start === s.window_start} onClick={() => setPicked(s)}>
            {fmtEt(s.window_start)}<small>{s.arrival_window_min / 60}-hour arrival window · {s.technician_name}</small>
          </button>
        ))}
      </div>
      <button className="primary" disabled={!picked || state.status === "busy"} onClick={submit}>{state.status === "busy" ? "Sending…" : "Request this time"}</button>
      {state.status === "error" && <p className="err">{state.message}</p>}
    </>
  );
}
