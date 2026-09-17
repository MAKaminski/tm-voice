/**
 * Turning data into something a text-to-speech voice says intelligibly.
 *
 * Handing a raw email address to a TTS engine is what produced "when it repeats email address,
 * you cannot understand it": the engine renders `joe.mcgrew@acme-realty.com` as a fast run of
 * syllables, and the parts that actually matter to a listener writing it down — where the dots
 * are, whether it is a hyphen or an underscore — are exactly the parts it swallows.
 *
 * So the address is spelled out: letter by letter, punctuation named in words, with commas
 * between so the voice pauses instead of sprinting.
 */

/** Punctuation has to be named, not rendered. A spoken "." is nothing at all. */
const SPOKEN: Record<string, string> = {
  "@": "at",
  ".": "dot",
  "-": "dash",
  _: "underscore",
  "+": "plus",
  "/": "slash",
};

/**
 * Digits are read as words so "0" cannot come out as "oh" and be written down as the letter O,
 * which is the single most common transcription error on a spelled-out address.
 */
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;

/**
 * Spell one token for speech. Letters are upper-cased so the engine says the letter name rather
 * than trying to pronounce a run of them as a word.
 */
export function spellOut(value: string): string {
  const parts: string[] = [];
  for (const ch of value.trim()) {
    if (ch === " ") continue;
    const named = SPOKEN[ch];
    if (named) { parts.push(named); continue; }
    if (ch >= "0" && ch <= "9") { parts.push(DIGITS[Number(ch)]!); continue; }
    parts.push(ch.toUpperCase());
  }
  // Commas are what make the voice pause between characters instead of running them together.
  return parts.join(", ");
}

/**
 * An email address as a sentence Joe can read at dictation speed.
 *
 * The address is given once as itself and then spelled, because a listener who already knows
 * their own address only needs the spelling to check it, and one whose address we misheard needs
 * to hear the wrong version to notice.
 */
export function sayEmail(email: string): string {
  return `${email.trim()}. Let me spell that: ${spellOut(email)}.`;
}

/** Same idea for a phone number: grouped, so it is heard as a number and not fifteen digits. */
export function sayPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return spellOut(local);
  const groups = [local.slice(0, 3), local.slice(3, 6), local.slice(6)];
  return groups.map((g) => [...g].map((d) => DIGITS[Number(d)]!).join(" ")).join(", ");
}
