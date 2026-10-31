/**
 * The game's display settings in `<Documents>\Respawn\Titanfall2\local\videoconfig.txt`.
 *
 * The game reads the file when it starts and writes it back when it exits, so the World changes it only while the
 * game is not running. Documents is the shell folder the game resolves the same way, the "Personal" value under
 * User Shell Folders; it can sit on another drive than the user profile. A game never started has no file yet;
 * the World then writes one holding the display settings alone, and the game fills in the rest with its defaults.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** The video config version the game writes; a file without it is reset to defaults. */
const CONFIG_VERSION = '7';
/** A window's size when neither the settings nor the game give one. */
const DEFAULT_WINDOW: Size = { width: 1280, height: 720 };

const pattern = (key: string): RegExp => new RegExp(`("${key.replace(/\./g, '\\.')}"\\s+)"([^"]*)"`);

/** `<Documents>\Respawn\Titanfall2`, where the game keeps its settings and saves. */
async function gameFolder(): Promise<string | null> {
  const docs = await regValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Personal');
  return docs ? join(docs, 'Respawn', 'Titanfall2') : null;
}

export async function videoConfigFile(): Promise<string | null> {
  const dir = await gameFolder();
  return dir ? join(dir, 'local', 'videoconfig.txt') : null;
}

/**
 * Whether Northstar's main menu will ask about signing in to its master server: it does until the player
 * answers, kept as `ns_has_agreed_to_send_token` (0 undecided, 1 yes, 2 no) in the game's profile.cfg.
 */
export async function northstarWillAsk(): Promise<boolean> {
  const dir = await gameFolder();
  if (!dir) return true;
  try {
    const m = /^ns_has_agreed_to_send_token\s+"(\d+)"/m.exec(readFileSync(join(dir, 'profile', 'profile.cfg'), 'utf8'));
    return !m || m[1] === '0';
  } catch {
    return true;
  }
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

/** A whole video config file holding the display settings alone, in the game's layout. */
export function newDisplayFile(d: GameDisplay): string {
  const lines = (Object.keys(KEYS) as Array<keyof GameDisplay>).map((k) => `\t"${KEYS[k]}"\t\t"${k === 'fullscreen' || k === 'borderless' ? (d[k] ? '1' : '0') : d[k]}"`);
  return ['"VideoConfig"', '{', ...lines, `\t"setting.configversion"\t\t"${CONFIG_VERSION}"`, '}', ''].join('\r\n');
}

/**
 * The settings the configured mode asks for, or null when the game keeps its own. `current` is null before the
 * game has written its file. Without a configured resolution, fullscreen and borderless take the primary
 * screen's; a window keeps its size.
 */
export function targetDisplay(cfg: Titanfall2ConfigSection['display'], current: GameDisplay | null, screen: Size | null): GameDisplay | null {
  if (cfg.mode === 'game') return null;
  const fill = cfg.mode === 'windowed' ? null : screen;
  const size = parseResolution(cfg.resolution) ?? fill ?? (current ? { width: current.width, height: current.height } : DEFAULT_WINDOW);
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

/** Rewrites the display settings of an existing file, or creates the file when `text` is null. */
export function writeDisplayFile(file: string, text: string | null, d: GameDisplay): void {
  if (text === null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, newDisplayFile(d));
  } else {
    writeFileSync(file, withDisplay(text, d));
  }
}
