import { describe, expect, it } from "vitest";
import { inCallingWindow } from "../src/calling-window.js";
import { type GateInput, runGate } from "../src/gate.js";

// 2026-09-10 14:00 UTC = 10:00 America/New_York (EDT)
const NOON = new Date("2026-09-10T14:00:00Z");
const ok = (): GateInput => ({
  surface: "landline_only", allowMaRecording: false,
  contact: { phoneE164: "+14045550100", lineType: "landline", state: "GA", timezone: "America/New_York" },
  consent: { latestGrantAt: null, latestRevokeAt: null }, suppressed: false, dnc: { federal: false, state: false },
  now: NOON, did: { dialsToday: 0, dailyCap: 10 }, attemptNo: 0, maxAttempts: 3,
});

describe("runGate — one case per gate_result", () => {
  it("pass", () => expect(runGate(ok()).result).toBe("pass"));
  it("surface: wireless under landline_only", () => {
    expect(runGate({ ...ok(), contact: { ...ok().contact, lineType: "wireless" } }).result).toBe("surface");
  });
  it("surface: MA excluded by default", () => {
    expect(runGate({ ...ok(), contact: { ...ok().contact, state: "MA" } }).result).toBe("surface");
    expect(runGate({ ...ok(), allowMaRecording: true, contact: { ...ok().contact, state: "MA" } }).result).toBe("pass");
  });
  it("suppressed", () => expect(runGate({ ...ok(), suppressed: true }).result).toBe("suppressed"));
  it("dnc", () => expect(runGate({ ...ok(), dnc: { federal: true, state: false } }).result).toBe("dnc"));
  it("window: 22:00 local", () => expect(runGate({ ...ok(), now: new Date("2026-09-11T02:00:00Z") }).result).toBe("window"));
  it("did_cap", () => expect(runGate({ ...ok(), did: { dialsToday: 10, dailyCap: 10 } }).result).toBe("did_cap"));
  it("attempts", () => expect(runGate({ ...ok(), attemptNo: 3 }).result).toBe("attempts"));
  it("order: surface beats suppression beats dnc", () => {
    const i = { ...ok(), suppressed: true, dnc: { federal: true, state: false }, contact: { ...ok().contact, lineType: "voip" as const } };
    expect(runGate(i).result).toBe("surface");
    expect(runGate({ ...i, contact: ok().contact }).result).toBe("suppressed");
  });
});

describe("consented_mobile", () => {
  const wireless = () => ({ ...ok(), surface: "consented_mobile" as const, contact: { ...ok().contact, lineType: "wireless" as const } });
  it("wireless without grant → surface", () => expect(runGate(wireless()).result).toBe("surface"));
  it("wireless with grant → pass", () => {
    expect(runGate({ ...wireless(), consent: { latestGrantAt: new Date("2026-09-01"), latestRevokeAt: null } }).result).toBe("pass");
  });
  it("grant older than revoke → surface", () => {
    expect(runGate({ ...wireless(), consent: { latestGrantAt: new Date("2026-08-01"), latestRevokeAt: new Date("2026-09-01") } }).result).toBe("surface");
  });
  it("landline still passes under consented_mobile", () => expect(runGate({ ...ok(), surface: "consented_mobile" }).result).toBe("pass"));
});

describe("calling window", () => {
  it("FL cutoff is 20:00", () => {
    const t = new Date("2026-09-11T00:30:00Z"); // 20:30 EDT
    expect(inCallingWindow(t, "America/New_York", "GA")).toBe(true);
    expect(inCallingWindow(t, "America/New_York", "FL")).toBe(false);
  });
  it("CT starts at 09:00", () => {
    const t = new Date("2026-09-10T12:30:00Z"); // 08:30 EDT
    expect(inCallingWindow(t, "America/New_York", "GA")).toBe(true);
    expect(inCallingWindow(t, "America/New_York", "CT")).toBe(false);
  });
  it("honors the contact timezone", () => {
    const t = new Date("2026-09-10T12:30:00Z"); // 08:30 ET, 05:30 PT
    expect(inCallingWindow(t, "America/Los_Angeles", "CA")).toBe(false);
  });
});
