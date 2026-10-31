/**
 * BT's voice through GPT-SoVITS: V5 turbo on NVIDIA GPUs, v2ProPlus on the CPU.
 *
 * The runtime and weights are the ones cortico-world-gpt-sovits-for-coopanion installs (sovits/, same pins and
 * directories), downloaded from ModelScope first. This World starts its own api_v2 process on them and sends
 * the sample cut from the game as the reference audio with its transcript. api_v2 runs one pipeline, so
 * requests go out one at a time.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { OUTPUT_GAIN, TIER_MODEL, type ModelVersion, type Tier } from './sovits/catalog.ts';
import { RuntimeJob, WeightsJob } from './sovits/install.ts';
import { SovitsServer } from './sovits/server.ts';
import { synthesize } from './sovits/synth.ts';
import { decodeWav, ensureSample, WARMUP_TEXT, type Pcm, type SampleSource, type VoiceEngine, type VoicePhase } from './voice.ts';

const SYNTH_TIMEOUT_MS = 60_000;

export interface SovitsOptions extends SampleSource {
  runtimesRoot: string;
  modelsRoot: string;
  /** Where api_v2's generated config goes. */
  dataDir: string;
  onPhase: (phase: VoicePhase, detail: string | null) => void;
}

/** nvidia-smi listing at least one GPU counts as an NVIDIA GPU. */
function detectCuda(): Promise<boolean> {
  return new Promise((done) => {
    execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000 }, (err, stdout) => done(!err && /GPU \d+:/.test(stdout)));
  });
}

function withGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  return out;
}

export class SovitsVoice implements VoiceEngine {
  phase: VoicePhase = 'off';
  detail: string | null = null;
  readonly runtime: RuntimeJob;
  readonly weights: WeightsJob;
  private readonly server: SovitsServer;
  private readonly detecting: Promise<void>;
  private cuda: boolean | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SovitsOptions) {
    this.runtime = new RuntimeJob(() => opts.runtimesRoot, () => this.tier());
    this.weights = new WeightsJob(() => opts.modelsRoot, () => this.version());
    this.server = new SovitsServer(opts.log, (detail) => this.setPhase('error', detail));
    this.detecting = detectCuda().then((cuda) => {
      this.cuda = cuda;
    });
  }

  /** The tier in effect; `auto` follows nvidia-smi, and counts as the GPU tier until it has answered. */
  tier(): Tier {
    const set = this.opts.cfg().sovitsTier;
    if (set !== 'auto') return set;
    return this.cuda === false ? 'cpu' : 'cuda';
  }

  version(): ModelVersion {
    return TIER_MODEL[this.tier()];
  }

  /** Waits for the GPU check, so `tier()` is final. */
  detected(): Promise<void> {
    return this.detecting;
  }

  installed(): boolean {
    return this.runtime.status().phase === 'ready' && this.weights.status().phase === 'ready';
  }

  start(): Promise<void> {
    if (this.phase === 'ready') return Promise.resolve();
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop(): void {
    void this.server.stop();
    this.setPhase('off', null);
  }

  async synth(text: string, signal?: AbortSignal): Promise<Pcm> {
    await this.start();
    return this.serial(() => this.collect(text, signal));
  }

  async refreshSample(): Promise<{ file: string; durationMs: number }> {
    await ensureSample(this.opts, true);
    return { file: this.opts.sampleFile, durationMs: decodeWav(readFileSync(this.opts.sampleFile)).durationMs };
  }

  private setPhase(phase: VoicePhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    this.opts.onPhase(phase, detail);
  }

  private async doStart(): Promise<void> {
    this.setPhase('starting', null);
    try {
      await this.detecting;
      await ensureSample(this.opts, false);
      if (!this.installed()) throw new Error('GPT-SoVITS 运行时或权重还没下载：在快速启动页签的 BT 语音里下载');
      await this.server.start({ runtimeDir: this.runtime.dir(), weightsDir: this.weights.dir(), tier: this.tier(), version: this.version(), dataDir: this.opts.dataDir });
      const st = this.server.state();
      if (st.phase !== 'ready') throw new Error(st.detail ?? 'GPT-SoVITS 推理服务没有就绪');
      await this.serial(() => this.collect(WARMUP_TEXT));
      this.setPhase('ready', null);
      this.opts.log.info('GPT-SoVITS 语音就绪', { tier: this.tier(), version: this.version() });
    } catch (err) {
      await this.server.stop();
      this.setPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async collect(text: string, signal?: AbortSignal): Promise<Pcm> {
    const url = this.server.state().url;
    if (!url) throw new Error('GPT-SoVITS 推理服务没在运行');
    const cfg = this.opts.cfg();
    const timeout = AbortSignal.timeout(SYNTH_TIMEOUT_MS);
    const parts: Buffer[] = [];
    let sampleRate = 0;
    const req = { text, refAudio: this.opts.sampleFile, refText: cfg.sampleText, speed: 1 };
    for await (const c of synthesize(url, req, signal ? AbortSignal.any([signal, timeout]) : timeout)) {
      sampleRate = c.sampleRate;
      parts.push(c.pcm);
    }
    if (!sampleRate) throw new Error('GPT-SoVITS 没有返回音频');
    const pcm = withGain(Buffer.concat(parts), OUTPUT_GAIN[this.version()]);
    return { pcm, sampleRate, durationMs: Math.round((pcm.length / 2 / sampleRate) * 1000) };
  }
}
