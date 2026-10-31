import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Captions, DIALOGUE_HOOK, parseCaption, patchDialogueScript } from '../src/story.ts';

describe('patchDialogueScript', () => {
  it('reports each dialogue alias played through a variable and leaves UI sounds and other lines alone', () => {
    const src = [
      '\t\t\tfile.currentDialoguePlayingHandle = EmitSoundOnEntity( speaker, data.alias )',
      '\t\t\tEmitSoundOnEntity( speaker, data.btStartAlias )',
      '\t\t\t\tsoundObj = EmitSoundOnEntity( player, closingLine )',
      '\t\tEmitSoundOnEntity( player, "UI_PlayerDialogue_Selection" )',
      '\t\twait duration',
    ].join('\r\n');
    const { text, hooks } = patchDialogueScript(src);
    expect(hooks).toBe(3);
    const lines = text.split('\r\n');
    expect(lines).toEqual([
      `\t\t\t${DIALOGUE_HOOK}( data.alias, speaker )`,
      '\t\t\tfile.currentDialoguePlayingHandle = EmitSoundOnEntity( speaker, data.alias )',
      `\t\t\t${DIALOGUE_HOOK}( data.btStartAlias, speaker )`,
      '\t\t\tEmitSoundOnEntity( speaker, data.btStartAlias )',
      `\t\t\t\t${DIALOGUE_HOOK}( closingLine, player )`,
      '\t\t\t\tsoundObj = EmitSoundOnEntity( player, closingLine )',
      '\t\tEmitSoundOnEntity( player, "UI_PlayerDialogue_Selection" )',
      '\t\twait duration',
    ]);
  });
});

/** A VCCD file with one block holding the given alias → caption pairs. */
function vccd(entries: Array<[string, string]>): Buffer {
  const blockSize = 8192;
  const dataOffset = 512;
  const dir = Buffer.alloc(entries.length * 12);
  const block = Buffer.alloc(blockSize);
  let at = 0;
  entries.forEach(([alias, text], i) => {
    const bytes = Buffer.from(`${text}\0`, 'utf16le');
    bytes.copy(block, at);
    dir.writeUInt32LE(crc32(alias.toLowerCase()) >>> 0, i * 12);
    dir.writeInt32LE(0, i * 12 + 4);
    dir.writeUInt16LE(at, i * 12 + 8);
    dir.writeUInt16LE(bytes.length, i * 12 + 10);
    at += bytes.length;
  });
  const head = Buffer.alloc(24);
  head.write('VCCD', 0, 'ascii');
  head.writeInt32LE(1, 4);
  head.writeInt32LE(1, 8);
  head.writeInt32LE(blockSize, 12);
  head.writeInt32LE(entries.length, 16);
  head.writeInt32LE(dataOffset, 20);
  const pad = Buffer.alloc(dataOffset - 24 - dir.length);
  return Buffer.concat([head, dir, pad, block]);
}

describe('Captions', () => {
  it('finds a caption by alias in any letter case and splits off the speaker', () => {
    const table = Captions.parse(vccd([
      ['diag_sp_test_01_mcor_bt', '<clr:255,255,255>BT: 鐵馭，掃描中…'],
      ['diag_sp_test_02_mcor_grunt', '<I>無人應答</I>'],
    ]));
    expect(table.get('DIAG_SP_TEST_01_MCOR_BT')).toEqual({ speaker: 'BT', text: '鐵馭，掃描中…' });
    expect(table.get('diag_sp_test_02_mcor_grunt')).toEqual({ speaker: '', text: '無人應答' });
    expect(table.get('diag_missing')).toBeNull();
  });

  it('treats a full-width colon as the speaker separator', () => {
    expect(parseCaption('BT：目標完成。')).toEqual({ speaker: 'BT', text: '目標完成。' });
  });
});
