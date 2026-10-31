/**
 * BT's voice: VoxCPM2 Hi-Fi cloning from a line cut out of the installed game.
 *
 * The server is `voice.serverUrl` when set; otherwise the World starts llama-tts-server.exe from a
 * llama.cpp-omni runtime on a free loopback port and stops it with the World. Each request sends the
 * sample as `reference_audio` with its transcript as `prompt_text`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { Titanfall2ConfigSection } from './config.ts';
import { extractSample } from './sample.ts';

type VoiceConfig = Titanfall2ConfigSection['voice'];

export const SERVER_EXE = 'llama-tts-server.exe';
export const BASE_LM = 'VoxCPM2-BaseLM-F16.gguf';
export const ACOUSTIC = 'VoxCPM2-Acoustic-F16.gguf';
const HEALTH_TIMEOUT_MS = 180_000;
const SYNTH_TIMEOUT_MS = 60_000;

export type VoicePhase = 'off' | 'starting' | 'ready' | 'error';

/** A voice BT speaks with: VoxCPM2 (`Voice`) or GPT-SoVITS (`SovitsVoice`); both clone the sample cut from the game. */
export interface VoiceEngine {
  readonly phase: VoicePhase;
  readonly detail: string | null;
  /** Starts the server and prepares the sample; resolves when a line can be synthesized. */
  start(): Promise<void>;
  stop(): void;
  synth(text: string, signal?: AbortSignal): Promise<Pcm>;
  /** Cuts the sample again from the game even when one is kept. */
  refreshSample(): Promise<{ file: string; durationMs: number }>;
}

export interface SampleSource {
  cfg: () => VoiceConfig;
  /** The game directory the sample is cut from; null when unknown. */
  gameDir: () => string | null;
  /** Where the cut sample is kept; a `.json` beside it records alias and language. */
  sampleFile: string;
  log: Logger;
}

/** Cuts the configured line from the game into `sampleFile` unless the kept one is the same line; true when it cut. */
export async function ensureSample(o: SampleSource, force: boolean): Promise<boolean> {
  const cfg = o.cfg();
  const key = `${cfg.sampleAlias}|${cfg.sampleLanguage}`;
  const metaFile = `${o.sampleFile}.json`;
  let kept = '';
  try {
    kept = (JSON.parse(readFileSync(metaFile, 'utf8')) as { key?: string }).key ?? '';
  } catch {
    // no sample cut yet
  }
  if (!force && kept === key && existsSync(o.sampleFile)) return false;
  const gameDir = o.gameDir();
  if (!gameDir) throw new Error('game directory unknown: the voice sample is cut from the installed game');
  await extractSample(gameDir, cfg.sampleAlias, cfg.sampleLanguage, o.sampleFile);
  writeFileSync(metaFile, JSON.stringify({ key }));
  o.log.info('BT 语音样片已从游戏截取', { alias: cfg.sampleAlias, file: o.sampleFile });
  return true;
}

export interface Pcm {
  pcm: Buffer;
  sampleRate: number;
  durationMs: number;
}

/** PCM16 mono out of a WAV: PCM16 or float32, any channel count (averaged). */
export function decodeWav(wav: Buffer): Pcm {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let data: Buffer | null = null;
  for (let off = 12; off + 8 <= wav.length; ) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      format = wav.readUInt16LE(off + 8);
      channels = wav.readUInt16LE(off + 10);
      sampleRate = wav.readUInt32LE(off + 12);
      bits = wav.readUInt16LE(off + 22);
      if (format === 0xfffe) format = wav.readUInt16LE(off + 32);
    } else if (id === 'data') {
      data = wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error('WAV without fmt or data');
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const out = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = (f * channels + c) * width;
      if (format === 1 && bits === 16) sum += data.readInt16LE(at);
      else if (format === 3 && bits === 32) sum += data.readFloatLE(at) * 32767;
      else throw new Error(`unsupported WAV format ${format}/${bits}bit`);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), f * 2);
  }
  return { pcm: out, sampleRate, durationMs: Math.round((frames / sampleRate) * 1000) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** The newest installed llama.cpp-omni runtime directory holding the server, or null. */
export function findRuntime(runtimesRoot: string): string | null {
  const root = join(runtimesRoot, 'llama.cpp-omni');
  if (!existsSync(root)) return null;
  const found: Array<{ dir: string; at: number }> = [];
  for (const release of readdirSync(root)) {
    const releaseDir = join(root, release);
    if (!statSync(releaseDir).isDirectory()) continue;
    for (const key of readdirSync(releaseDir)) {
      const dir = join(releaseDir, key);
      if (existsSync(join(dir, SERVER_EXE))) found.push({ dir, at: statSync(dir).mtimeMs });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.dir ?? null;
}

/** Where the server and weights are taken from: the configured directories, else the shared defaults. */
export function voiceDirs(cfg: VoiceConfig, runtimesRoot: string, modelsRoot: string): { runtimeDir: string | null; modelsDir: string } {
  return { runtimeDir: cfg.runtimeDir.trim() || findRuntime(runtimesRoot), modelsDir: cfg.modelsDir.trim() || join(modelsRoot, 'vtuber') };
}

export interface VoiceOptions extends SampleSource {
  runtimesRoot: string;
  modelsRoot: string;
  onPhase: (phase: VoicePhase, detail: string | null) => void;
}

/** VoxCPM2 through llama-tts-server. */
export class Voice implements VoiceEngine {
  phase: VoicePhase = 'off';
  detail: string | null = null;
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<void> | null = null;
  private sample: { key: string; b64: string } | null = null;

  constructor(private readonly opts: VoiceOptions) {}

  /** Starts the server (or checks the configured one) and prepares the sample. */
  start(): Promise<void> {
    if (this.phase === 'ready') return Promise.resolve();
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    if (proc && proc.exitCode === null) proc.kill();
    this.setPhase('off', null);
  }

  /** Cuts the sample again from the game even when one is kept. */
  async refreshSample(): Promise<{ file: string; durationMs: number }> {
    this.sample = null;
    await this.ensureSample(true);
    return { file: this.opts.sampleFile, durationMs: decodeWav(readFileSync(this.opts.sampleFile)).durationMs };
  }

  async synth(text: string, signal?: AbortSignal): Promise<Pcm> {
    await this.start();
    const cfg = this.opts.cfg();
    const body = {
      model: 'voxcpm2',
      input: text,
      voice: 'default',
      response_format: 'wav',
      inference_timesteps: cfg.inferenceTimesteps,
      reference_audio: await this.sampleB64(),
      prompt_text: cfg.sampleText,
    };
    const timeout = AbortSignal.timeout(SYNTH_TIMEOUT_MS);
    const res = await fetch(`${this.url}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`VoxCPM2 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return decodeWav(Buffer.from(await res.arrayBuffer()));
  }

  private setPhase(phase: VoicePhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    this.opts.onPhase(phase, detail);
  }

  private async doStart(): Promise<void> {
    this.setPhase('starting', null);
    try {
      await this.ensureSample(false);
      const cfg = this.opts.cfg();
      if (cfg.serverUrl.trim()) {
        this.url = cfg.serverUrl.trim().replace(/\/$/, '');
        if (!(await this.healthy())) throw new Error(`no VoxCPM2 server answers at ${this.url}`);
      } else {
        await this.spawnServer(cfg);
      }
      this.setPhase('ready', null);
    } catch (err) {
      this.stop();
      this.setPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async ensureSample(force: boolean): Promise<void> {
    if (await ensureSample(this.opts, force)) this.sample = null;
  }

  private async sampleB64(): Promise<string> {
    const cfg = this.opts.cfg();
    const key = `${cfg.sampleAlias}|${cfg.sampleLanguage}`;
    if (this.sample?.key !== key) {
      await this.ensureSample(false);
      this.sample = { key, b64: readFileSync(this.opts.sampleFile).toString('base64') };
    }
    return this.sample.b64;
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async spawnServer(cfg: VoiceConfig): Promise<void> {
    const { runtimeDir, modelsDir } = voiceDirs(cfg, this.opts.runtimesRoot, this.opts.modelsRoot);
    if (!runtimeDir || !existsSync(join(runtimeDir, SERVER_EXE))) throw new Error(`${SERVER_EXE} not found${runtimeDir ? ` in ${runtimeDir}` : `: no llama.cpp-omni runtime under ${this.opts.runtimesRoot}`}`);
    for (const f of [BASE_LM, ACOUSTIC]) if (!existsSync(join(modelsDir, f))) throw new Error(`missing ${join(modelsDir, f)}`);
    const port = await freePort();
    const args = ['--host', '127.0.0.1', '--port', String(port), '--voxcpm2-base-lm', join(modelsDir, BASE_LM), '--voxcpm2-acoustic', join(modelsDir, ACOUSTIC), '--voxcpm2-n-gpu-layers', '-1'];
    const tail: string[] = [];
    const proc = spawn(join(runtimeDir, SERVER_EXE), args, {
      cwd: runtimeDir,
      env: { ...process.env, PATH: `${runtimeDir};${process.env.PATH ?? ''}` },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (d: Buffer): void => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) tail.push(line);
      tail.splice(0, Math.max(0, tail.length - 20));
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    this.proc = proc;
    this.url = `http://127.0.0.1:${port}`;
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.url = null;
      this.setPhase('error', `llama-tts-server exited (${code}): ${tail.slice(-3).join(' | ')}`);
    });
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.proc !== proc) throw new Error(this.detail ?? 'llama-tts-server exited');
      if (await this.healthy()) {
        this.opts.log.info('VoxCPM2 服务已就绪', { url: this.url, runtimeDir });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('llama-tts-server did not become healthy in time');
  }
}
