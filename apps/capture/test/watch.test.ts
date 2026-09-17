import { describe, expect, it } from "vitest";
import { mintSessionId, shouldFinalise, shouldStart, trackKey, watchConfig } from "../src/watch.js";
import { RECORDING_NOTICE } from "../src/notice.js";

const human = (id: string) => ({ id, bot: false });
const bot = (id: string) => ({ id, bot: true });
const watched = watchConfig(["chan-a", "chan-b"]);

describe("when to start", () => {
  it("starts on two humans in a watched channel", () => {
    expect(shouldStart(watched, "chan-a", [human("1"), human("2")], false)).toBe(true);
  });

  it("never records an unwatched channel, however busy", () => {
    expect(shouldStart(watched, "chan-z", [human("1"), human("2"), human("3")], false)).toBe(false);
  });

  it("records nothing when WATCH_CHANNEL_IDS is empty, rather than everything", () => {
    expect(shouldStart(watchConfig([]), "chan-a", [human("1"), human("2")], false)).toBe(false);
  });

  it("does not count bots toward the threshold", () => {
    expect(shouldStart(watched, "chan-a", [human("1"), bot("me")], false)).toBe(false);
  });

  it("does not start twice for one meeting", () => {
    expect(shouldStart(watched, "chan-a", [human("1"), human("2")], true)).toBe(false);
  });
});

describe("when to finalise", () => {
  it("finalises when the last human leaves", () => {
    expect(shouldFinalise([bot("me")], true)).toBe(true);
    expect(shouldFinalise([], true)).toBe(true);
  });

  it("keeps recording when a three-person meeting becomes a two-person meeting", () => {
    // Dropping at the start threshold would split one meeting into two sessions and file its
    // tasks twice.
    expect(shouldFinalise([human("1"), human("2"), bot("me")], true)).toBe(false);
    expect(shouldFinalise([human("1"), bot("me")], true)).toBe(false);
  });

  it("is a no-op when not recording", () => {
    expect(shouldFinalise([], false)).toBe(false);
  });
});

describe("identifiers", () => {
  it("mints a session id that is unique per join and sorts by time", () => {
    const a = mintSessionId("g", "c", new Date("2026-09-17T10:00:00Z"));
    const b = mintSessionId("g", "c", new Date("2026-09-17T11:00:00Z"));
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });

  it("lays out R2 keys one prefix per session", () => {
    const s = mintSessionId("g1", "c1", new Date(1_700_000_000_000));
    expect(trackKey(s, "u9")).toBe("meetings/g1/c1/1700000000000/u9.opus");
  });
});

describe("what the room is told", () => {
  it("says it is recorded, transcribed, filed, and how to stop", () => {
    for (const phrase of ["recorded", "transcribed", "filed as tasks", "Leave the channel"]) {
      expect(RECORDING_NOTICE).toContain(phrase);
    }
  });
});
