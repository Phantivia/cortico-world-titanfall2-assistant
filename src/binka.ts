/*
 * Ported from FFmpeg's libavcodec/binkaudio.c and libavformat/binka.c (n7.1):
 *   Copyright (c) 2007-2011 Peter Ross (pross@xvid.org)
 *   Copyright (c) 2009 Daniel Verkamp (daniel@drv.nu)
 *   Copyright (c) 2021 Paul B Mahol
 * This file is free software under the GNU Lesser General Public License version 2.1 or later, unlike the rest
 * of the package (MIT); see THIRD_PARTY_NOTICES.md.
 */

/**
 * Bink Audio (`1FCB`, the Miles Sound System container Titanfall 2 stores its lines in) to PCM, so cutting the
 * voice sample needs no ffmpeg. Its output matches ffmpeg's to within one PCM16 step.
 *
 * Container: a header (channels at 5, sample rate at 6, a seek table of `entries` u16 at 22), then packets of
 * a 2-byte skip, a u16 payload size and the payload. A payload holds one or more blocks, each 32-bit aligned.
 * A block, per channel: two floats, a quantizer per frequency band, run-length coded coefficients; an inverse
 * DCT-III turns them into `frame_len` samples, of which the last sixteenth cross-fades into the next block.
 */

/** Upper edges of the critical bands in Hz (FFmpeg's ff_wma_critical_freqs). */
const CRITICAL_FREQS = [
  100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150,
  3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500, 24500,
];
const RLE_LENGTHS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 32, 64];

export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  /** Planar samples, nominally within ±1. */
  planes: Float32Array[];
}

/** Little-endian bit reader: bits come out of each byte least significant first. */
class Bits {
  private pos = 0;
  constructor(private readonly buf: Uint8Array, private readonly end: number) {}

  left(): number {
    return this.end * 8 - this.pos;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) v += ((this.buf[this.pos >> 3] >> (this.pos & 7)) & 1) * 2 ** i;
    return v;
  }

  skip(n: number): void {
    this.pos += n;
  }

  align32(): void {
    this.pos += (32 - (this.pos & 31)) & 31;
  }

  /** A 5-bit power, a 23-bit mantissa and a sign bit. */
  float(): number {
    const power = this.read(5);
    const f = this.read(23) * 2 ** (power - 23);
    return this.read(1) ? -f : f;
  }
}

export function decodeBinka(file: Uint8Array): DecodedAudio {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (String.fromCharCode(file[0], file[1], file[2], file[3]) !== '1FCB') throw new Error('not a Bink Audio (1FCB) file');
  const channels = file[5];
  const sampleRate = view.getUint16(6, true);
  const entries = view.getUint16(20, true);
  if (channels < 1 || channels > 2 || !sampleRate) throw new Error(`unsupported Bink Audio: ${channels} channels at ${sampleRate} Hz`);

  const frameLenBits = sampleRate < 22050 ? 9 : sampleRate < 44100 ? 10 : 11;
  const frameLen = 1 << frameLenBits;
  const overlap = frameLen / 16;
  const root = frameLen / (Math.sqrt(frameLen) * 32768);
  const quantTable = Array.from({ length: 96 }, (_, i) => Math.exp(i * 0.15289164787221953823) * root);
  const halfRate = Math.floor((sampleRate + 1) / 2);
  let numBands = 1;
  while (numBands < 25 && halfRate > CRITICAL_FREQS[numBands - 1]) numBands++;
  const bands = [2];
  for (let i = 1; i < numBands; i++) bands.push(Math.floor((CRITICAL_FREQS[i - 1] * frameLen) / halfRate) & ~1);
  bands.push(frameLen);

  // DCT-III scaled by 2/N: x[k] = 2/N (c[0]/2 + sum c[n] cos(pi/N n (k + 1/2))), with c[0] doubled first as FFmpeg does.
  const dctScale = 2 / frameLen;
  const cos = new Float32Array(frameLen * frameLen);
  for (let n = 0; n < frameLen; n++) for (let k = 0; k < frameLen; k++) cos[n * frameLen + k] = Math.cos((Math.PI / frameLen) * n * (k + 0.5));

  const out: number[][] = Array.from({ length: channels }, () => []);
  const previous = Array.from({ length: channels }, () => new Float32Array(overlap));
  const coeffs = new Float32Array(frameLen);
  const block = new Float32Array(frameLen);
  let first = true;

  let at = 22 + entries * 2 + 2;
  while (at + 4 <= file.length) {
    const size = view.getUint16(at + 2, true);
    const start = at + 4;
    at = start + size;
    if (!size || at > file.length) break;
    const bits = new Bits(file.subarray(start, at), size);
    // a tail too short for a block ends the packet, as FFmpeg drops an incomplete one
    while (bits.left() >= 2 + 58 * channels) {
      bits.skip(2);
      const decoded: Float32Array[] = [];
      for (let ch = 0; ch < channels; ch++) {
        coeffs[0] = bits.float() * root;
        coeffs[1] = bits.float() * root;
        const quant = Array.from({ length: numBands }, () => quantTable[Math.min(bits.read(8), 95)]);
        let k = 0;
        let q = quant[0];
        let i = 2;
        while (i < frameLen) {
          let j = i + 8;
          if (bits.read(1)) j = i + RLE_LENGTHS[bits.read(4)] * 8;
          j = Math.min(j, frameLen);
          const width = bits.read(4);
          if (width === 0) {
            coeffs.fill(0, i, j);
            i = j;
            while (bands[k] < i) q = quant[k++];
          } else {
            for (; i < j; i++) {
              if (bands[k] === i) q = quant[k++];
              const c = bits.read(width);
              coeffs[i] = c ? (bits.read(1) ? -q * c : q * c) : 0;
            }
          }
        }
        coeffs[0] *= 2;
        block.fill(0);
        for (let n = 0; n < frameLen; n++) {
          const c = (n === 0 ? coeffs[0] / 2 : coeffs[n]) * dctScale;
          if (!c) continue;
          const row = n * frameLen;
          for (let x = 0; x < frameLen; x++) block[x] += c * cos[row + x];
        }
        decoded.push(Float32Array.from(block));
      }
      const count = overlap * channels;
      for (let ch = 0; ch < channels; ch++) {
        const samples = decoded[ch];
        if (!first) for (let i = 0, j = ch; i < overlap; i++, j += channels) samples[i] = (previous[ch][i] * (count - j) + samples[i] * j) / count;
        previous[ch].set(samples.subarray(frameLen - overlap));
        for (let i = 0; i < frameLen - overlap; i++) out[ch].push(samples[i]);
      }
      first = false;
      bits.align32();
    }
  }
  return { sampleRate, channels, planes: out.map((p) => Float32Array.from(p)) };
}

/** Mono PCM16 (channels averaged) as a WAV file. */
export function toMonoWav(a: DecodedAudio): Buffer {
  const frames = a.planes[0].length;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const plane of a.planes) sum += plane[i];
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((sum / a.planes.length) * 32768))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(a.sampleRate, 24);
  head.writeUInt32LE(a.sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
