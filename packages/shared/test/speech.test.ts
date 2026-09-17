import { describe, expect, it } from "vitest";
import { sayEmail, sayPhone, spellOut } from "../src/index.js";

describe("spelling things out for a voice", () => {
  it("names punctuation instead of leaving it silent", () => {
    // A spoken "." is nothing at all, which is how a listener loses where the dots are.
    expect(spellOut("a@b.co")).toBe("A, at, B, dot, C, O");
    expect(spellOut("a-b_c")).toBe("A, dash, B, underscore, C");
  });

  it("reads digits as words so zero cannot be heard as the letter O", () => {
    expect(spellOut("a0o")).toBe("A, zero, O");
  });

  it("upper-cases letters so the engine says the letter, not a word", () => {
    // "joe" left lower-case gets pronounced as a name rather than spelled.
    expect(spellOut("joe")).toBe("J, O, E");
  });

  it("separates every character with a comma, which is what makes the voice pause", () => {
    expect(spellOut("ab").split(", ")).toHaveLength(2);
  });

  it("ignores spaces a transcriber sprinkled in", () => {
    expect(spellOut(" a b ")).toBe("A, B");
  });
});

describe("reading an email back", () => {
  it("says it once whole, then spells it", () => {
    const said = sayEmail("joe.mcgrew@acme-realty.com");
    expect(said.startsWith("joe.mcgrew@acme-realty.com.")).toBe(true);
    expect(said).toContain("Let me spell that:");
    expect(said).toContain("dash");   // the hyphen is named
    expect(said).toContain("at");     // and so is the @
  });

  it("is never a single run-together word", () => {
    // This is the whole complaint: the old read-back was the raw string and nothing else.
    expect(sayEmail("a@b.co")).not.toBe("a@b.co");
  });
});

describe("reading a number back", () => {
  it("groups a US number so it is heard as a number", () => {
    expect(sayPhone("+14045550100")).toBe("four zero four, five five five, zero one zero zero");
  });

  it("handles a number with no country code", () => {
    expect(sayPhone("4045550100")).toContain("four zero four");
  });

  it("falls back to spelling anything that is not ten digits", () => {
    expect(sayPhone("12345")).toBe("one, two, three, four, five");
  });
});
