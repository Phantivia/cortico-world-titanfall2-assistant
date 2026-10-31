import { describe, expect, it } from 'vitest';
import { TITANFALL2_DEFAULTS } from '../src/config.ts';
import { newDisplayFile, parseDisplay, parseResolution, targetDisplay, withDisplay } from '../src/videoconfig.ts';

/** The shape the game writes: tab-separated quoted pairs, CRLF line ends. */
const FILE = [
  '"VideoConfig"',
  '{',
  '\t"setting.cl_gib_allow"\t\t"1"',
  '\t"setting.defaultres"\t\t"1680"',
  '\t"setting.defaultresheight"\t\t"1050"',
  '\t"setting.fullscreen"\t\t"1"',
  '\t"setting.nowindowborder"\t\t"0"',
  '\t"setting.mat_vsync_mode"\t\t"2"',
  '}',
  '',
].join('\r\n');

const SCREEN = { width: 2560, height: 1600 };

describe('game video config', () => {
  it('reads the display settings', () => {
    expect(parseDisplay(FILE)).toEqual({ fullscreen: true, borderless: false, width: 1680, height: 1050 });
  });

  it('rewrites only the four display values and keeps every other byte', () => {
    const out = withDisplay(FILE, { fullscreen: false, borderless: true, width: 2560, height: 1600 });
    expect(parseDisplay(out)).toEqual({ fullscreen: false, borderless: true, width: 2560, height: 1600 });
    const changed = new Set(['setting.defaultres', 'setting.defaultresheight', 'setting.fullscreen', 'setting.nowindowborder']);
    const before = FILE.split('\r\n');
    const after = out.split('\r\n');
    expect(after).toHaveLength(before.length);
    after.forEach((line, i) => {
      if (![...changed].some((k) => line.includes(`"${k}"`))) expect(line).toBe(before[i]);
    });
  });

  it('turns each mode into the settings it asks for', () => {
    const current = parseDisplay(FILE)!;
    const cfg = TITANFALL2_DEFAULTS.display;
    expect(targetDisplay({ ...cfg, mode: 'borderless' }, current, SCREEN)).toEqual({ fullscreen: false, borderless: true, width: 2560, height: 1600 });
    expect(targetDisplay({ ...cfg, mode: 'fullscreen', resolution: '1920x1200' }, current, SCREEN)).toEqual({ fullscreen: true, borderless: false, width: 1920, height: 1200 });
    expect(targetDisplay({ ...cfg, mode: 'windowed' }, current, SCREEN)).toEqual({ fullscreen: false, borderless: false, width: 1680, height: 1050 });
    expect(targetDisplay({ ...cfg, mode: 'game' }, current, SCREEN)).toBeNull();
  });

  it('writes a file the game has not created yet with the display settings alone', () => {
    const cfg = TITANFALL2_DEFAULTS.display;
    const target = targetDisplay({ ...cfg, mode: 'borderless' }, null, SCREEN)!;
    const text = newDisplayFile(target);
    expect(parseDisplay(text)).toEqual(target);
    expect(text).toContain('"setting.configversion"');
    expect(text.split('\r\n')[0]).toBe('"VideoConfig"');
    expect(targetDisplay({ ...cfg, mode: 'windowed' }, null, SCREEN)).toMatchObject({ width: 1280, height: 720 });
  });

  it('accepts the resolution forms people type', () => {
    expect(parseResolution('2560x1600')).toEqual(SCREEN);
    expect(parseResolution(' 2560 × 1600 ')).toEqual(SCREEN);
    expect(parseResolution('')).toBeNull();
    expect(parseResolution('wide')).toBeNull();
  });
});
