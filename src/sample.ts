/**
 * Cuts one sound alias out of the installed game's Miles banks and decodes it to a mono PCM16 WAV.
 *
 * `r2/sound/general.mbnk` (version 13) lists every source: name, language, patch, and where its
 * Bink Audio header and data sit. The header lives at `headerOffset` of the `.mstr` stream file with
 * the same language and patch; the data starts at that file's `dataOffset` + the source's data
 * offset. Header + data is a standalone `1FCB` Bink Audio file that ffmpeg's binka demuxer decodes.
 * Layout as read by LegionPlus (MilesLib.cpp).
 */
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Miles language indices of Titanfall 2. */
export const MILES_LANGUAGES = ['english', 'french', 'german', 'spanish', 'italian', 'japanese', 'polish', 'portuguese', 'russian', 'tchinese', 'mspanish'] as const;

const SOURCE_SIZE = 0x58;
const STREAM_MAGIC = 0x43535452; // "RTSC"

export interface MilesSource {
  name: string;
  sampleRate: number;
  channels: number;
  headerOffset: number;
  headerSize: number;
  dataOffset: number;
  /** -1 for sources shared by every language. */
  language: number;
  patch: number;
}

export function languageIndex(language: string): number {
  const i = MILES_LANGUAGES.indexOf(language.trim().toLowerCase() as (typeof MILES_LANGUAGES)[number]);
  if (i < 0) throw new Error(`unknown audio language "${language}"; one of ${MILES_LANGUAGES.join(', ')}`);
  return i;
}

/** The source named `alias` in `language` (or language-neutral); null when the bank has none. */
export function findSource(soundDir: string, alias: string, language: number): MilesSource | null {
  const bank = readFileSync(join(soundDir, 'general.mbnk'));
  const version = bank.readUInt32LE(4);
  if (version < 0xc || version > 0xd) throw new Error(`general.mbnk version ${version} is not a Titanfall 2 bank`);
  const sourcesAt = Number(bank.readBigUInt64LE(0x48));
  const namesAt = Number(bank.readBigUInt64LE(0x70));
  const perLanguage = bank.readUInt32LE(0x9c);
  const count = bank.readUInt32LE(0xa0) + perLanguage * language;
  const want = Buffer.from(`${alias}\0`);
  for (let i = 0; i < count; i++) {
    const e = sourcesAt + i * SOURCE_SIZE;
    const lang = bank.readInt16LE(e + 0x50);
    if (lang !== -1 && lang !== language) continue;
    const nameAt = namesAt + bank.readUInt32LE(e + 0x10);
    if (bank.compare(want, 0, want.length, nameAt, nameAt + want.length) !== 0) continue;
    return {
      name: alias,
      sampleRate: bank.readUInt16LE(e + 0x14),
      channels: bank.readUInt8(e + 0x18),
      headerSize: bank.readUInt32LE(e + 0x30),
      headerOffset: Number(bank.readBigUInt64LE(e + 0x38)),
      dataOffset: Number(bank.readBigUInt64LE(e + 0x40)),
      language: lang,
      patch: bank.readUInt16LE(e + 0x52),
    };
  }
  return null;
}

function readAt(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return n === length ? buf : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** The `.mstr` stream file holding a source, with the offset its data counts from. */
export function streamFileOf(soundDir: string, src: MilesSource): { path: string; dataBase: number } {
  for (const name of readdirSync(soundDir)) {
    if (!name.endsWith('.mstr')) continue;
    const path = join(soundDir, name);
    const head = readAt(path, 0, 16);
    if (head.length < 16 || head.readUInt32LE(0) !== STREAM_MAGIC) continue;
    if (head.readInt16LE(6) === src.language && head.readUInt16LE(12) === src.patch) return { path, dataBase: head.readUInt32LE(8) };
  }
  throw new Error(`no .mstr file for language ${src.language} patch ${src.patch}`);
}

/** The source as a standalone Bink Audio file. */
export function binkaOf(soundDir: string, src: MilesSource): Buffer {
  const { path, dataBase } = streamFileOf(soundDir, src);
  const header = readAt(path, src.headerOffset, src.headerSize);
  if (header.toString('ascii', 0, 4) !== '1FCB') throw new Error(`${src.name}: no Bink Audio header at ${src.headerOffset}`);
  const total = header.readUInt32LE(16);
  return Buffer.concat([header, readAt(path, dataBase + src.dataOffset, total - src.headerSize)]);
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 << 20 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${file} ${err.message}${stderr ? `: ${String(stderr).slice(-300)}` : ''}`));
      else resolve(String(stderr));
    });
  });
}

/**
 * Writes the alias as mono PCM16 to `outWav` through ffmpeg; returns the source it used.
 * ffmpeg reports an I/O error at the end of every binka stream, so only a missing output fails.
 */
export async function extractSample(gameDir: string, alias: string, language: string, outWav: string, ffmpeg = 'ffmpeg'): Promise<MilesSource> {
  const soundDir = join(gameDir, 'r2', 'sound');
  const src = findSource(soundDir, alias, languageIndex(language));
  if (!src) throw new Error(`"${alias}" is not in the ${language} audio of ${soundDir}`);
  mkdirSync(dirname(outWav), { recursive: true });
  const binka = `${outWav}.binka`;
  writeFileSync(binka, binkaOf(soundDir, src));
  await run(ffmpeg, ['-v', 'error', '-y', '-i', binka, '-ac', '1', '-c:a', 'pcm_s16le', outWav]).catch((err: Error) => {
    if (!/I\/O error/.test(err.message)) throw err;
  });
  rmSync(binka, { force: true });
  if (!existsSync(outWav)) throw new Error('ffmpeg wrote no output');
  return src;
}
