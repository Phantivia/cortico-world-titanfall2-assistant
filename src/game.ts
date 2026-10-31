/**
 * The installed game: finding it, installing Northstar and the mod, the EA app it signs in through,
 * and launching through Northstar.
 *
 * NorthstarLauncher.exe runs the game in its own process; a Steam launch with `-northstar` runs it
 * as Titanfall2.exe. Either way the mod only reaches 127.0.0.1 with `-allowlocalhttp`, which the
 * World keeps in `ns_startup_args.txt` so manual launches carry it too. Installing also writes the
 * dialogue hook override (story.ts) built from this game's own files into the mod folder.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { downloadFile, unzip, type Progress } from './download.ts';
import { buildDialogueOverride, DIALOGUE_HOOK, DIALOGUE_SCRIPT } from './story.ts';

export const MOD_NAME = 'Cortico.Titanfall2Assistant';
export const MOD_SOURCE = fileURLToPath(new URL(`../mod/${MOD_NAME}`, import.meta.url));
const STARTUP_ARGS_FILE = 'ns_startup_args.txt';
const LOCAL_HTTP = '-allowlocalhttp';
const GAME_PROCESSES = ['NorthstarLauncher.exe', 'Titanfall2.exe'];

/** The Northstar release installed when the game has none; its archive unpacks over the game folder. */
export const NORTHSTAR_VERSION = '1.31.14';
const NORTHSTAR_URL = `https://github.com/R2Northstar/Northstar/releases/download/v${NORTHSTAR_VERSION}/Northstar.release.v${NORTHSTAR_VERSION}.zip`;
/** The EA app's LSX server, which the game asks for the signed-in account. */
const EA_LSX_PORT = 3216;

const run = promisify(execFile);

/** stdout of a console tool, or '' when it fails; never blocks the event loop. */
async function output(file: string, args: string[]): Promise<string> {
  try {
    return (await run(file, args, { encoding: 'utf8', windowsHide: true })).stdout;
  } catch {
    return '';
  }
}

async function regValue(key: string, name: string): Promise<string> {
  const out = await output('reg', ['query', key, '/v', name]);
  return new RegExp(`${name}\\s+REG_SZ\\s+(.+)`).exec(out)?.[1]?.trim() ?? '';
}

export interface GameCheck {
  dir: string;
  game: boolean;
  northstar: boolean;
  /** The installed mod matches the one in this package. */
  modCurrent: boolean;
  localHttp: boolean;
  /** The patched dialogue script that reports story lines is in place. */
  dialogueHook: boolean;
}

export function checkGame(dir: string): GameCheck {
  const game = existsSync(join(dir, 'Titanfall2.exe'));
  const northstar = existsSync(join(dir, 'R2Northstar', 'Northstar.dll')) && existsSync(join(dir, 'NorthstarLauncher.exe'));
  let dialogueHook = false;
  try {
    dialogueHook = readFileSync(join(modDir(dir), 'mod', DIALOGUE_SCRIPT), 'latin1').includes(DIALOGUE_HOOK);
  } catch {
    // not installed
  }
  return { dir, game, northstar, modCurrent: northstar && sameTree(MOD_SOURCE, modDir(dir)), localHttp: startupArgs(dir).includes(LOCAL_HTTP), dialogueHook };
}

function modDir(gameDir: string): string {
  return join(gameDir, 'R2Northstar', 'mods', MOD_NAME);
}

function startupArgs(gameDir: string): string[] {
  try {
    return readFileSync(join(gameDir, STARTUP_ARGS_FILE), 'utf8').split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function sameTree(a: string, b: string): boolean {
  if (!existsSync(b)) return false;
  for (const name of readdirSync(a)) {
    const pa = join(a, name);
    const pb = join(b, name);
    if (statSync(pa).isDirectory()) {
      if (!sameTree(pa, pb)) return false;
    } else if (!existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb))) {
      return false;
    }
  }
  return true;
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
}

/** Copies the mod into the game and adds `-allowlocalhttp` to the startup arguments. */
export function installMod(gameDir: string): GameCheck {
  const check = checkGame(gameDir);
  if (!check.game) throw new Error(`no Titanfall2.exe in ${gameDir}`);
  if (!check.northstar) throw new Error(`Northstar is not installed in ${gameDir}`);
  if (!check.modCurrent) copyTree(MOD_SOURCE, modDir(gameDir));
  const override = buildDialogueOverride(gameDir);
  const target = join(modDir(gameDir), 'mod', DIALOGUE_SCRIPT);
  if (override.hooks > 0) {
    let current = '';
    try {
      current = readFileSync(target, 'latin1');
    } catch {
      // first install
    }
    if (current !== override.text) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, override.text, 'latin1');
    }
  }
  if (!check.localHttp) writeFileSync(join(gameDir, STARTUP_ARGS_FILE), [...startupArgs(gameDir), LOCAL_HTTP].join(' '));
  return checkGame(gameDir);
}

/** Downloads the pinned Northstar release into `workDir` and unpacks it over the game folder. */
export async function installNorthstar(gameDir: string, workDir: string, onProgress: (p: Progress) => void): Promise<GameCheck> {
  if (!existsSync(join(gameDir, 'Titanfall2.exe'))) throw new Error(`no Titanfall2.exe in ${gameDir}`);
  const zip = join(workDir, `Northstar.release.v${NORTHSTAR_VERSION}.zip`);
  const staging = join(workDir, `northstar-${NORTHSTAR_VERSION}`);
  if (!existsSync(zip)) await downloadFile(NORTHSTAR_URL, zip, `Northstar v${NORTHSTAR_VERSION}`, onProgress);
  rmSync(staging, { recursive: true, force: true });
  onProgress({ label: `Northstar v${NORTHSTAR_VERSION}`, done: 0, total: null });
  await unzip(zip, staging);
  copyTree(staging, gameDir);
  rmSync(staging, { recursive: true, force: true });
  rmSync(zip, { force: true });
  return checkGame(gameDir);
}

/** EADesktop.exe as the EA app's installer recorded it, or null when the EA app is not installed. */
export async function eaAppPath(): Promise<string | null> {
  const path = await regValue('HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop', 'DesktopAppPath');
  return path && existsSync(path) ? path : null;
}

export async function eaAppRunning(): Promise<boolean> {
  return (await pidsOf('EADesktop.exe')).length > 0;
}

export function startEaApp(path: string): void {
  spawn(path, [], { detached: true, stdio: 'ignore' }).unref();
}

/** Whether the EA app's LSX server accepts connections on loopback. */
export function eaLsxListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: EA_LSX_PORT });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Steam library folders holding steamapps/common/Titanfall2. */
export async function findGameDirs(): Promise<string[]> {
  const steam = await regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const libraries = new Set<string>();
  if (steam) {
    libraries.add(steam);
    try {
      const vdf = readFileSync(join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(m[1].replace(/\\\\/g, '\\'));
    } catch {
      // single library
    }
  }
  return [...libraries].map((l) => join(l, 'steamapps', 'common', 'Titanfall2')).filter((d) => existsSync(join(d, 'Titanfall2.exe')));
}

/** PIDs of running game processes. */
export async function runningGame(): Promise<number[]> {
  return (await Promise.all(GAME_PROCESSES.map(pidsOf))).flat();
}

async function pidsOf(image: string): Promise<number[]> {
  const out = await output('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
  return [...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
}

/** Starts NorthstarLauncher.exe detached; the game outlives the World. */
export function launchGame(gameDir: string, extraArgs: string, port: number): number {
  const args = [LOCAL_HTTP, ...extraArgs.split(/\s+/).filter(Boolean), '+cortico_tf2_port', String(port)];
  const child = spawn(join(gameDir, 'NorthstarLauncher.exe'), args, { cwd: gameDir, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (!child.pid) throw new Error('NorthstarLauncher.exe did not start');
  return child.pid;
}
