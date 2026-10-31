/**
 * The game's display settings in `<Documents>\Respawn\Titanfall2\local\videoconfig.txt`.
 *
 * The game reads the file when it starts and writes it back when it exits, so the World changes it only while the
 * game is not running. Documents is the shell folder the game resolves the same way, the "Personal" value under
 * User Shell Folders; it can sit on another drive than the user profile.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Titanfall2ConfigSection } from './config.ts';
import { regValue } from './game.ts';

export interface GameDisplay {
  fullscreen: boolean;
  /** With `fullscreen` off: no window border. The game draws one at start anyway unless launched with `-noborder`. */
  borderless: boolean;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

const KEYS: Record<keyof GameDisplay, string> = {
  fullscreen: 'setting.fullscreen',
  borderless: 'setting.nowindowborder',
  width: 'setting.defaultres',
  height: 'setting.defaultresheight',
};

const pattern = (key: string): RegExp => new RegExp(`("${key.replace(/\./g, '\\.')}"\\s+)"([^"]*)"`);

export async function videoConfigFile(): Promise<string | null> {
  const docs = await regValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Personal');
  return docs ? join(docs, 'Respawn', 'Titanfall2', 'local', 'videoconfig.txt') : null;
}

export function parseDisplay(text: string): GameDisplay | null {
  const get = (k: keyof GameDisplay): string | undefined => pattern(KEYS[k]).exec(text)?.[2];
  const [fullscreen, borderless, width, height] = [get('fullscreen'), get('borderless'), get('width'), get('height')];
  if (fullscreen === undefined || borderless === undefined || !Number(width) || !Number(height)) return null;
  return { fullscreen: fullscreen === '1', borderless: borderless === '1', width: Number(width), height: Number(height) };
}

/** The file's text with the four display settings replaced and every other byte kept. */
export function withDisplay(text: string, d: GameDisplay): string {
  const values: Record<keyof GameDisplay, string> = { fullscreen: d.fullscreen ? '1' : '0', borderless: d.borderless ? '1' : '0', width: String(d.width), height: String(d.height) };
  let out = text;
  for (const k of Object.keys(KEYS) as Array<keyof GameDisplay>) out = out.replace(pattern(KEYS[k]), `$1"${values[k]}"`);
  return out;
}

export function parseResolution(s: string): Size | null {
  const m = /^\s*(\d{3,5})\s*[x×*]\s*(\d{3,5})\s*$/i.exec(s);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * The settings the configured mode asks for, or null when the game keeps its own. Without a configured
 * resolution, fullscreen and borderless take the primary screen's; a window keeps its size.
 */
export function targetDisplay(cfg: Titanfall2ConfigSection['display'], current: GameDisplay, screen: Size | null): GameDisplay | null {
  if (cfg.mode === 'game') return null;
  const size = parseResolution(cfg.resolution) ?? (cfg.mode !== 'windowed' && screen ? screen : { width: current.width, height: current.height });
  return { fullscreen: cfg.mode === 'fullscreen', borderless: cfg.mode === 'borderless', width: size.width, height: size.height };
}

export function sameDisplay(a: GameDisplay, b: GameDisplay): boolean {
  return a.fullscreen === b.fullscreen && a.borderless === b.borderless && a.width === b.width && a.height === b.height;
}

export function readDisplayFile(file: string): { text: string; display: GameDisplay | null } | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return { text, display: parseDisplay(text) };
}

export function writeDisplayFile(file: string, text: string, d: GameDisplay): void {
  writeFileSync(file, withDisplay(text, d));
}
