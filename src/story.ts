/**
 * Campaign dialogue from the installed game: which line just played, and what it says.
 *
 * The mod reports dialogue through a hook added to the game's own `sp/sh_sp_dialogue.gnut`: the
 * World reads that script from the player's VPK, inserts a `CorticoTF2_OnDialogue( alias, speaker )`
 * call before each place it plays a dialogue alias on the client, and installs the result as a file
 * override inside the mod folder in the game. Nothing from the game ships in this package.
 *
 * Line text comes from `resource/subtitles_<language>.dat` (VCCD: CRC32 of the lowercase alias →
 * UTF-16 text with `<clr:…>`-style tags); the speaker is the caption's `NAME:` prefix.
 */
import { crc32 } from 'node:zlib';
import { dirVpkOf, readVpkFile } from './vpk.ts';

export const DIALOGUE_SCRIPT = 'scripts/vscripts/sp/sh_sp_dialogue.gnut';
export const DIALOGUE_HOOK = 'CorticoTF2_OnDialogue';
/** Any SP level VPK carries the shared SP scripts; every copy is the same. */
const SP_SCRIPT_MAP = 'sp_training';

const EMIT = /^(\s*)((?:file\.currentDialoguePlayingHandle|soundObj)\s*=\s*)?EmitSoundOnEntity\(\s*(\w+)\s*,\s*([A-Za-z_][\w.]*)\s*\)\s*$/;

/**
 * Inserts the hook before every dialogue emit whose alias is a variable (literal aliases are UI
 * sounds). Each emit is a statement of its own, so a line before it runs under the same condition.
 */
export function patchDialogueScript(source: string): { text: string; hooks: number } {
  let hooks = 0;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const m = EMIT.exec(line);
    if (m) {
      out.push(`${m[1]}${DIALOGUE_HOOK}( ${m[4]}, ${m[3]} )`);
      hooks++;
    }
    out.push(line);
  }
  return { text: out.join(eol), hooks };
}

/** The patched dialogue script built from the game in `gameDir`. */
export function buildDialogueOverride(gameDir: string): { text: string; hooks: number } {
  const src = readVpkFile(dirVpkOf(gameDir, SP_SCRIPT_MAP), DIALOGUE_SCRIPT);
  if (!src) throw new Error(`${DIALOGUE_SCRIPT} not found in the ${SP_SCRIPT_MAP} VPK`);
  return patchDialogueScript(src.toString('latin1'));
}

export interface Caption {
  /** Speaker as the caption names it ("BT", "反抗軍步兵"); empty when the caption has none. */
  speaker: string;
  text: string;
}

/** Strips caption markup and splits off the `NAME:` prefix. */
export function parseCaption(raw: string): Caption {
  const plain = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const m = /^([^:：]{1,24})[:：]\s*(.*)$/.exec(plain);
  return m ? { speaker: m[1].trim(), text: m[2].trim() } : { speaker: '', text: plain };
}

/** alias → caption lookup over one subtitles `.dat`. */
export class Captions {
  private constructor(private readonly byHash: Map<number, string>) {}

  static parse(dat: Buffer): Captions {
    if (dat.toString('ascii', 0, 4) !== 'VCCD') throw new Error('not a VCCD captions file');
    const blockSize = dat.readInt32LE(12);
    const count = dat.readInt32LE(16);
    const dataOffset = dat.readInt32LE(20);
    const byHash = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const at = 24 + i * 12;
      const hash = dat.readUInt32LE(at);
      const block = dat.readInt32LE(at + 4);
      const offset = dat.readUInt16LE(at + 8);
      const length = dat.readUInt16LE(at + 10);
      const start = dataOffset + block * blockSize + offset;
      byHash.set(hash, dat.toString('utf16le', start, start + length).replace(/\0+$/, ''));
    }
    return new Captions(byHash);
  }

  static load(gameDir: string, language: string): Captions {
    const dat = readVpkFile(dirVpkOf(gameDir, 'frontend'), `resource/subtitles_${language}.dat`);
    if (!dat) throw new Error(`no subtitles_${language}.dat in the game`);
    return Captions.parse(dat);
  }

  get size(): number {
    return this.byHash.size;
  }

  get(alias: string): Caption | null {
    const raw = this.byHash.get(crc32(alias.toLowerCase()) >>> 0);
    return raw === undefined ? null : parseCaption(raw);
  }
}
