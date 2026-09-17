/**
 * A minimal Ogg Opus muxer (RFC 3533 framing, RFC 7845 headers).
 *
 * Discord hands us Opus packets already encoded; all that is missing to make a playable file is the
 * container. prism-media v1 has no Ogg muxer — the one used by the discord.js recording example is
 * in the v2 alpha — and taking an alpha dependency to write 40 bytes of header, plus the native
 * @discordjs/opus peer it drags in, is a worse trade than the code below. Nothing here decodes:
 * packets go in as they arrived and come out framed.
 *
 * This is the one part of the capture path that can be checked without a Discord call, and it is:
 * test/ogg.test.ts mints a file and has ffmpeg decode it.
 */

const OGG_CAPTURE = Buffer.from("OggS", "ascii");
const HEADER_LEN = 27;

/** Opus is always timed at 48 kHz in Ogg, whatever the encoder's internal rate (RFC 7845 §4). */
export const OPUS_GRANULE_RATE = 48_000;
/** A 20 ms Discord frame at 48 kHz. */
export const SAMPLES_PER_FRAME = 960;
/** What the reference encoder reports; players trim this many samples off the front. */
export const PRE_SKIP = 312;

/**
 * Ogg's CRC is its own variant: polynomial 0x04c11db7, no reflection of input or output, initial
 * value 0 and no final XOR. It is NOT the common zlib CRC-32, and using that produces a file every
 * decoder rejects.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x8000_0000 ? (r << 1) ^ 0x04c1_1db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(buf: Buffer): number {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/**
 * Ogg lacing: a packet is written as ceil(len/255) segment lengths. A packet whose length is an
 * exact multiple of 255 needs a trailing 0 segment, otherwise the decoder cannot tell that the
 * packet ended rather than continuing into the next page.
 */
export function laceOne(length: number): number[] {
  const segments: number[] = [];
  let remaining = length;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining);
  return segments;
}

export type HeaderType = 0x00 | 0x01 | 0x02 | 0x04;

export function buildPage(opts: {
  headerType: number;
  granulePosition: bigint;
  serial: number;
  sequence: number;
  segments: number[];
  payload: Buffer;
}): Buffer {
  if (opts.segments.length > 255) throw new Error("a page holds at most 255 segments");
  const page = Buffer.alloc(HEADER_LEN + opts.segments.length + opts.payload.length);
  OGG_CAPTURE.copy(page, 0);
  page.writeUInt8(0, 4); // stream structure version
  page.writeUInt8(opts.headerType, 5);
  page.writeBigUInt64LE(opts.granulePosition, 6);
  page.writeUInt32LE(opts.serial >>> 0, 14);
  page.writeUInt32LE(opts.sequence >>> 0, 18);
  page.writeUInt32LE(0, 22); // CRC is computed over the page with this field zeroed
  page.writeUInt8(opts.segments.length, 26);
  for (const [i, s] of opts.segments.entries()) page.writeUInt8(s, HEADER_LEN + i);
  opts.payload.copy(page, HEADER_LEN + opts.segments.length);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

export function opusHead(channelCount: number): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head.writeUInt8(1, 8);              // version
  head.writeUInt8(channelCount, 9);
  head.writeUInt16LE(PRE_SKIP, 10);
  head.writeUInt32LE(OPUS_GRANULE_RATE, 12);
  head.writeInt16LE(0, 16);           // output gain
  head.writeUInt8(0, 18);             // channel mapping family 0: mono or standard stereo
  return head;
}

export function opusTags(vendor = "tm-voice capture"): Buffer {
  const v = Buffer.from(vendor, "utf8");
  const tags = Buffer.alloc(8 + 4 + v.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(v.length, 8);
  v.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + v.length); // no user comments
  return tags;
}

/**
 * Frame a sequence of Opus packets into one Ogg stream.
 *
 * Pages are capped well under the 255-segment limit rather than packed to it: a corrupted or
 * truncated page loses only what it held, and 50 frames is one second of speech.
 */
export function muxOggOpus(packets: readonly Uint8Array[], opts: { serial?: number; channelCount?: number; framesPerPage?: number } = {}): Uint8Array {
  const serial = opts.serial ?? (Math.random() * 0xffff_ffff) >>> 0;
  const framesPerPage = opts.framesPerPage ?? 50;
  const pages: Buffer[] = [];
  let sequence = 0;

  // Each header gets its own page, and the first carries the beginning-of-stream flag.
  const head = opusHead(opts.channelCount ?? 2);
  pages.push(buildPage({ headerType: 0x02, granulePosition: 0n, serial, sequence: sequence++, segments: laceOne(head.length), payload: head }));
  const tags = opusTags();
  pages.push(buildPage({ headerType: 0x00, granulePosition: 0n, serial, sequence: sequence++, segments: laceOne(tags.length), payload: tags }));

  let granule = 0n;
  for (let i = 0; i < packets.length; i += framesPerPage) {
    const batch = packets.slice(i, i + framesPerPage);
    const segments = batch.flatMap((p) => laceOne(p.length));
    const payload = Buffer.concat(batch.map((p) => Buffer.from(p)));
    granule += BigInt(batch.length * SAMPLES_PER_FRAME);
    const last = i + framesPerPage >= packets.length;
    pages.push(buildPage({ headerType: last ? 0x04 : 0x00, granulePosition: granule, serial, sequence: sequence++, segments, payload }));
  }

  // A stream with no audio still needs its end-of-stream page, or the file is truncated.
  if (packets.length === 0) {
    pages.push(buildPage({ headerType: 0x04, granulePosition: 0n, serial, sequence: sequence++, segments: [0], payload: Buffer.alloc(0) }));
  }
  return new Uint8Array(Buffer.concat(pages));
}
