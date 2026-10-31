import { describe, expect, it } from 'vitest';
import { pages, pageSeconds, SPEAKER, width, wrap } from '../src/speech.ts';
import { decodeWav } from '../src/voice.ts';

describe('subtitle wrapping', () => {
  it('keeps every line within the width and breaks after punctuation when it can', () => {
    const text = '前方有敌人，左侧也有一个泰坦正在靠近。';
    const lines = wrap(text, 8);
    expect(lines.join('')).toBe(text);
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(8);
    expect(lines[0]).toBe('前方有敌人，');
  });

  it('puts the speaker on the first line and at most two lines on a page', () => {
    const out = pages('a'.repeat(100), 20);
    expect(out[0][0].startsWith(SPEAKER)).toBe(true);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(2);
  });

  it('shares one voiced line\'s length across its pages by width, so pages turn while the voice runs on', () => {
    const list = [['一二三四'], ['五六']];
    const secs = pageSeconds(list, 3000, 3);
    expect(secs[0] / (secs[1] - 0.4)).toBeCloseTo(2);
    expect(secs.reduce((a, b) => a + b, 0)).toBeCloseTo(3.4);
  });
});

function wav(format: number, bits: number, channels: number, samples: number[]): Buffer {
  const width = bits / 8;
  const data = Buffer.alloc(samples.length * width);
  samples.forEach((s, i) => (format === 3 ? data.writeFloatLE(s, i * 4) : data.writeInt16LE(s, i * 2)));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(format, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(48000, 24);
  head.writeUInt16LE(bits, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

describe('decodeWav', () => {
  it('averages stereo PCM16 into mono', () => {
    const out = decodeWav(wav(1, 16, 2, [1000, 3000, -2000, -4000]));
    expect([out.pcm.readInt16LE(0), out.pcm.readInt16LE(2)]).toEqual([2000, -3000]);
    expect(out.sampleRate).toBe(48000);
  });

  it('scales float32 samples to PCM16', () => {
    const out = decodeWav(wav(3, 32, 1, [0.5, -1]));
    expect([out.pcm.readInt16LE(0), out.pcm.readInt16LE(2)]).toEqual([16384, -32767]);
  });
});
