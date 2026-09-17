import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLES_PER_FRAME, buildPage, laceOne, muxOggOpus, oggCrc, opusHead, opusTags } from "../src/ogg.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Read the Opus packets back out of an Ogg file, so a round trip can be asserted. */
function demux(ogg: Buffer): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let off = 0;
  let carry: Buffer[] = [];
  while (off < ogg.length) {
    if (ogg.subarray(off, off + 4).toString("ascii") !== "OggS") throw new Error(`no capture pattern at ${off}`);
    const nSegments = ogg.readUInt8(off + 26);
    const table = ogg.subarray(off + 27, off + 27 + nSegments);
    let dataOff = off + 27 + nSegments;
    let acc: Buffer[] = carry;
    carry = [];
    for (const len of table) {
      acc.push(ogg.subarray(dataOff, dataOff + len));
      dataOff += len;
      if (len < 255) { packets.push(new Uint8Array(Buffer.concat(acc))); acc = []; }
    }
    carry = acc;
    off = dataOff;
  }
  return packets;
}

describe("lacing", () => {
  it("splits at 255 and terminates a short segment", () => {
    expect(laceOne(0)).toEqual([0]);
    expect(laceOne(100)).toEqual([100]);
    expect(laceOne(254)).toEqual([254]);
  });

  it("adds a zero segment for an exact multiple of 255, or the packet never ends", () => {
    expect(laceOne(255)).toEqual([255, 0]);
    expect(laceOne(510)).toEqual([255, 255, 0]);
    expect(laceOne(256)).toEqual([255, 1]);
  });
});

describe("the Ogg CRC variant", () => {
  it("is the unreflected 0x04c11db7 CRC, not zlib's", () => {
    // Known value for the Ogg variant over "123456789".
    expect(oggCrc(Buffer.from("123456789", "ascii"))).toBe(0x89a1897f);
  });

  it("is written into the page and validates over the page with the field zeroed", () => {
    const page = Buffer.from(buildPage({
      headerType: 0x02, granulePosition: 0n, serial: 7, sequence: 0,
      segments: laceOne(4), payload: Buffer.from("abcd"),
    }));
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    expect(oggCrc(page)).toBe(stored);
  });
});

describe("headers", () => {
  it("writes an OpusHead the spec shape", () => {
    const h = opusHead(2);
    expect(h.subarray(0, 8).toString("ascii")).toBe("OpusHead");
    expect(h.readUInt8(8)).toBe(1);
    expect(h.readUInt8(9)).toBe(2);
    expect(h.readUInt32LE(12)).toBe(48_000);
    expect(h.length).toBe(19);
  });

  it("writes OpusTags with a vendor and no user comments", () => {
    const t = opusTags("x");
    expect(t.subarray(0, 8).toString("ascii")).toBe("OpusTags");
    expect(t.readUInt32LE(8)).toBe(1);
    expect(t.readUInt32LE(13)).toBe(0);
  });
});

describe("muxing", () => {
  it("puts each header on its own page and flags BOS then EOS", () => {
    const ogg = Buffer.from(muxOggOpus([new Uint8Array([1, 2, 3])], { serial: 1 }));
    expect(ogg.readUInt8(5)).toBe(0x02); // first page: beginning of stream
    const pages = [...ogg.toString("binary").matchAll(/OggS/g)].map((m) => m.index!);
    expect(pages).toHaveLength(3); // head, tags, audio
    expect(ogg.readUInt8(pages[2]! + 5)).toBe(0x04); // last page: end of stream
  });

  it("advances the granule position by 960 samples per frame", () => {
    const ogg = Buffer.from(muxOggOpus(Array.from({ length: 3 }, () => new Uint8Array([9])), { serial: 1, framesPerPage: 50 }));
    const audioPage = [...ogg.toString("binary").matchAll(/OggS/g)].map((m) => m.index!)[2]!;
    expect(ogg.readBigUInt64LE(audioPage + 6)).toBe(BigInt(3 * SAMPLES_PER_FRAME));
  });

  it("round-trips packets of every awkward length, including the 255 boundary", () => {
    const packets = [1, 254, 255, 256, 510, 700].map((n) => new Uint8Array(n).fill(n & 0xff));
    const out = demux(Buffer.from(muxOggOpus(packets, { serial: 1, framesPerPage: 2 })));
    // Two header packets, then ours.
    expect(out.slice(2).map((p) => p.length)).toEqual([1, 254, 255, 256, 510, 700]);
  });

  it("still closes the stream when nobody said anything", () => {
    const ogg = Buffer.from(muxOggOpus([], { serial: 1 }));
    expect(ogg.readUInt8(ogg.lastIndexOf("OggS") + 5)).toBe(0x04);
  });
});

describe.skipIf(!hasFfmpeg)("against a real decoder", () => {
  const dir = mkdtempSync(join(tmpdir(), "ogg-"));

  /** Real Opus packets, produced by libopus rather than invented. */
  const realPackets = (): Uint8Array[] => {
    const src = join(dir, "src.ogg");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:a", "libopus", "-b:a", "24k", "-ac", "2", "-frame_duration", "20", src,
    ]);
    return demux(readFileSync(src)).slice(2); // drop OpusHead + OpusTags
  };

  it("produces a file ffmpeg decodes to the expected duration", () => {
    const packets = realPackets();
    expect(packets.length).toBeGreaterThan(50);

    const out = join(dir, "muxed.ogg");
    writeFileSync(out, muxOggOpus(packets, { serial: 0xdead_beef, channelCount: 2 }));

    const probe = execFileSync("ffprobe", [
      "-hide_banner", "-loglevel", "error", "-show_entries", "format=duration:stream=codec_name,channels",
      "-of", "default=noprint_wrappers=1", out,
    ]).toString();
    expect(probe).toContain("codec_name=opus");
    expect(probe).toContain("channels=2");
    // 2 seconds of 20 ms frames, allowing for pre-skip trimming.
    expect(Number(/duration=([\d.]+)/.exec(probe)![1])).toBeCloseTo(2, 1);

    // Decoding must produce audio, not silence or an error.
    const pcm = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "s16le", "-"], { maxBuffer: 1 << 26 });
    expect(pcm.length).toBeGreaterThan(48_000 * 2 * 2);
    expect(pcm.some((b) => b !== 0)).toBe(true);
  });
});
