import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegTranscoder, passthroughTranscoder } from "../src/transcode.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("passthrough", () => {
  it("returns the bytes untouched", async () => {
    const b = new Uint8Array([1, 2, 3]);
    expect(await passthroughTranscoder(b)).toBe(b);
  });
});

describe.skipIf(!hasFfmpeg)("ffmpeg transcoder", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcode-"));

  const source = (bitrate: string, seconds: number): Uint8Array => {
    const f = join(dir, `src-${bitrate}-${seconds}.ogg`);
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-c:a", "libopus", "-b:a", bitrate, "-ac", "2", f,
    ]);
    return new Uint8Array(readFileSync(f));
  };

  it("re-encodes to 16 kbps mono and shrinks the file substantially", async () => {
    const original = source("64k", 10);
    const out = await ffmpegTranscoder(original);

    const f = join(dir, "out.ogg");
    writeFileSync(f, out);
    const probe = execFileSync("ffprobe", [
      "-hide_banner", "-loglevel", "error",
      "-show_entries", "stream=codec_name,channels:format=duration,bit_rate",
      "-of", "default=noprint_wrappers=1", f,
    ]).toString();

    expect(probe).toContain("codec_name=opus");
    expect(probe).toContain("channels=1");
    expect(Number(/duration=([\d.]+)/.exec(probe)![1])).toBeCloseTo(10, 0);

    // The point of the step: the bytes that eventually go to an STT provider get much smaller.
    expect(out.byteLength).toBeLessThan(original.byteLength / 2);
    // ~16 kbps over 10s is ~20 kB; allow generous headroom for container overhead.
    expect(out.byteLength).toBeLessThan(40_000);
  });

  it("reports a structured, non-retryable error for input ffmpeg cannot read", async () => {
    await expect(ffmpegTranscoder(new Uint8Array([0, 1, 2, 3, 4])))
      .rejects.toMatchObject({ code: "ffmpeg_failed", retryable: false });
  });
});
