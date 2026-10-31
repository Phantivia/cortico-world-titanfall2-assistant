import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { binkaOf, findSource, languageIndex } from '../src/sample.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Entry { name: string; lang: number; patch: number; hoff: number; hsize: number; doff: number }

/** A general.mbnk with the version-13 layout findSource reads. */
function bank(entries: Entry[], perLanguage: number, shared: number): Buffer {
  const names = Buffer.concat(entries.map((e) => Buffer.from(`${e.name}\0`)));
  const sourcesAt = 0x100;
  const namesAt = sourcesAt + entries.length * 0x58;
  const buf = Buffer.alloc(namesAt + names.length);
  buf.writeUInt32LE(13, 4);
  buf.writeBigUInt64LE(BigInt(sourcesAt), 0x48);
  buf.writeBigUInt64LE(BigInt(namesAt), 0x70);
  buf.writeUInt32LE(perLanguage, 0x9c);
  buf.writeUInt32LE(shared, 0xa0);
  let nameOff = 0;
  entries.forEach((e, i) => {
    const at = sourcesAt + i * 0x58;
    buf.writeUInt32LE(nameOff, at + 0x10);
    buf.writeUInt16LE(48000, at + 0x14);
    buf.writeUInt8(2, at + 0x18);
    buf.writeUInt32LE(e.hsize, at + 0x30);
    buf.writeBigUInt64LE(BigInt(e.hoff), at + 0x38);
    buf.writeBigUInt64LE(BigInt(e.doff), at + 0x40);
    buf.writeInt16LE(e.lang, at + 0x50);
    buf.writeUInt16LE(e.patch, at + 0x52);
    nameOff += e.name.length + 1;
  });
  names.copy(buf, namesAt);
  return buf;
}

function mstr(lang: number, patch: number, dataBase: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('RTSC', 0, 'ascii');
  buf.writeUInt16LE(2, 4);
  buf.writeInt16LE(lang, 6);
  buf.writeUInt32LE(dataBase, 8);
  buf.writeUInt16LE(patch, 12);
  return buf;
}

describe('Miles sample extraction', () => {
  it('finds a line in the requested language and joins its header with its stream data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf2-miles-'));
    dirs.push(dir);
    const zh = languageIndex('tchinese');
    const line = 'diag_sp_test_mcor_bt';
    // shared and English sources first, then one block per further language in index order
    const other = Array.from({ length: zh - 1 }, (_, i) => ({ name: line, lang: i + 1, patch: 0, hoff: 0, hsize: 0, doff: 0 }));
    writeFileSync(join(dir, 'general.mbnk'), bank([
      { name: 'sfx_shared', lang: -1, patch: 0, hoff: 0, hsize: 0, doff: 0 },
      { name: line, lang: 0, patch: 0, hoff: 0, hsize: 0, doff: 0 },
      ...other,
      { name: line, lang: zh, patch: 1, hoff: 0x20, hsize: 24, doff: 8 },
    ], 1, 2));
    const header = Buffer.alloc(24);
    header.write('1FCB', 0, 'ascii');
    header.writeUInt32LE(24 + 6, 16);
    const stream = mstr(zh, 1, 0x80, 0x100);
    header.copy(stream, 0x20);
    Buffer.from('BINKAD').copy(stream, 0x80 + 8);
    writeFileSync(join(dir, 'general_tchinese_patch_1.mstr'), stream);
    writeFileSync(join(dir, 'general_english.mstr'), mstr(0, 0, 0x80, 0x100));

    const src = findSource(dir, line, zh);
    expect(src).toMatchObject({ language: zh, patch: 1, headerOffset: 0x20, headerSize: 24, dataOffset: 8, sampleRate: 48000, channels: 2 });
    expect(findSource(dir, line, languageIndex('japanese'))).toMatchObject({ language: languageIndex('japanese') });
    expect(findSource(dir, 'diag_missing', zh)).toBeNull();
    const binka = binkaOf(dir, src!);
    expect(binka.subarray(0, 4).toString('ascii')).toBe('1FCB');
    expect(binka.subarray(24).toString('ascii')).toBe('BINKAD');
  });
});
