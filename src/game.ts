/**
 * The installed game: finding it, installing the mod into Northstar, and launching through Northstar.
 *
 * NorthstarLauncher.exe runs the game in its own process; a Steam launch with `-northstar` runs it
 * as Titanfall2.exe. Either way the mod only reaches 127.0.0.1 with `-allowlocalhttp`, which the
 * World keeps in `ns_startup_args.txt` so manual launches carry it too.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOD_NAME = 'Cortico.Titanfall2Assistant';
export const MOD_SOURCE = fileURLToPath(new URL(`../mod/${MOD_NAME}`, import.meta.url));
const STARTUP_ARGS_FILE = 'ns_startup_args.txt';
const LOCAL_HTTP = '-allowlocalhttp';
const GAME_PROCESSES = ['NorthstarLauncher.exe', 'Titanfall2.exe'];

export interface GameCheck {
  dir: string;
  game: boolean;
  northstar: boolean;
  /** The installed mod matches the one in this package. */
  modCurrent: boolean;
  localHttp: boolean;
}

export function checkGame(dir: string): GameCheck {
  const game = existsSync(join(dir, 'Titanfall2.exe'));
  const northstar = existsSync(join(dir, 'R2Northstar', 'Northstar.dll')) && existsSync(join(dir, 'NorthstarLauncher.exe'));
  return { dir, game, northstar, modCurrent: northstar && sameTree(MOD_SOURCE, modDir(dir)), localHttp: startupArgs(dir).includes(LOCAL_HTTP) };
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
  if (!check.localHttp) writeFileSync(join(gameDir, STARTUP_ARGS_FILE), [...startupArgs(gameDir), LOCAL_HTTP].join(' '));
  return checkGame(gameDir);
}

/** Steam library folders holding steamapps/common/Titanfall2. */
export function findGameDirs(): string[] {
  let steam = '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    steam = /SteamPath\s+REG_SZ\s+(.+)/.exec(out)?.[1]?.trim() ?? '';
  } catch {
    // no Steam
  }
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
export function runningGame(): number[] {
  const pids: number[] = [];
  for (const image of GAME_PROCESSES) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const m = /^"[^"]+","(\d+)"/.exec(line);
        if (m) pids.push(Number(m[1]));
      }
    } catch {
      // tasklist unavailable
    }
  }
  return pids;
}

/** Starts NorthstarLauncher.exe detached; the game outlives the World. */
export function launchGame(gameDir: string, extraArgs: string, port: number): number {
  const args = [LOCAL_HTTP, ...extraArgs.split(/\s+/).filter(Boolean), '+cortico_tf2_port', String(port)];
  const child = spawn(join(gameDir, 'NorthstarLauncher.exe'), args, { cwd: gameDir, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (!child.pid) throw new Error('NorthstarLauncher.exe did not start');
  return child.pid;
}
