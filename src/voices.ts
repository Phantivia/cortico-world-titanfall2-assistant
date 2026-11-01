/**
 * The voice BT speaks with: the engine `voice.engine` selects, GPT-SoVITS (voice-sovits.ts) or VoxCPM2 (voice.ts),
 * with what each still needs downloaded. Starting one stops the other, so a switch in the settings takes effect
 * on the next start.
 */
import type { Progress } from './download.ts';
import { RUNTIME_ASSETS } from './sovits/catalog.ts';
import { downloadVoiceAssets, voiceAssets } from './voice-assets.ts';
import { SovitsVoice } from './voice-sovits.ts';
import { Voice, type Pcm, type VoiceEngine, type VoiceOptions, type VoicePhase } from './voice.ts';

export interface VoicesOptions extends VoiceOptions {
  dataDir: string;
}

export interface VoiceFiles {
  /** A configured VoxCPM2 server stands in for local files. */
  external: boolean;
  /** Files still to download, for people. */
  missing: string[];
  downloadBytes: number;
}

export interface DownloadState {
  running: boolean;
  progress: Progress | null;
  error: string | null;
}

export class Voices implements VoiceEngine {
  readonly voxcpm: Voice;
  readonly sovits: SovitsVoice;
  private download: DownloadState = { running: false, progress: null, error: null };

  constructor(private readonly opts: VoicesOptions) {
    this.voxcpm = new Voice(opts);
    this.sovits = new SovitsVoice(opts);
  }

  private get current(): VoiceEngine {
    return this.opts.cfg().engine === 'voxcpm2' ? this.voxcpm : this.sovits;
  }

  private get other(): VoiceEngine {
    return this.current === this.sovits ? this.voxcpm : this.sovits;
  }

  get phase(): VoicePhase {
    return this.current.phase;
  }

  get detail(): string | null {
    return this.current.detail;
  }

  start(): Promise<void> {
    if (this.other.phase !== 'off') this.other.stop();
    return this.current.start();
  }

  stop(): void {
    this.voxcpm.stop();
    this.sovits.stop();
  }

  synth(text: string, signal?: AbortSignal): Promise<Pcm> {
    return this.current.synth(text, signal);
  }

  /** The selected engine's streaming, when it has one (GPT-SoVITS). */
  get stream(): ((text: string, signal?: AbortSignal) => AsyncIterable<Pcm>) | undefined {
    const engine = this.current;
    return engine.stream ? (text, signal) => engine.stream!(text, signal) : undefined;
  }

  refreshSample(): Promise<{ file: string; durationMs: number }> {
    return this.current.refreshSample();
  }

  /** The GPT-SoVITS tier and model in effect; null with VoxCPM2. */
  tier(): { tier: string; version: string } | null {
    return this.current === this.sovits ? { tier: this.sovits.tier(), version: this.sovits.version() } : null;
  }

  files(): VoiceFiles {
    const cfg = this.opts.cfg();
    if (cfg.engine === 'voxcpm2') {
      const a = voiceAssets(cfg, this.opts.runtimesRoot, this.opts.modelsRoot);
      return { external: a.external, missing: [...(a.runtimeDir || a.external ? [] : ['llama.cpp-omni']), ...a.missingModels], downloadBytes: a.downloadBytes };
    }
    const runtime = this.sovits.runtime.status().phase === 'ready';
    const weights = this.sovits.weights.missing();
    return {
      external: false,
      missing: [...(runtime ? [] : [RUNTIME_ASSETS[this.sovits.tier()].file]), ...weights.map((f) => f.path)],
      downloadBytes: (runtime ? 0 : this.sovits.runtime.bytes()) + this.sovits.weights.bytes(),
    };
  }

  downloadState(): DownloadState {
    if (!this.download.running || this.opts.cfg().engine === 'voxcpm2') return { ...this.download };
    const job = this.sovits.runtime.status().phase === 'working' ? this.sovits.runtime.status() : this.sovits.weights.status();
    return { ...this.download, progress: { label: job.detail ?? '…', done: job.done, total: job.total || null } };
  }

  /** Downloads what the selected engine still needs, in the background; `then` runs once it is all there. */
  startDownload(then: () => void): void {
    if (this.download.running) return;
    this.download = { running: true, progress: null, error: null };
    const cfg = this.opts.cfg();
    const work = cfg.engine === 'voxcpm2'
      ? downloadVoiceAssets(cfg, this.opts.runtimesRoot, this.opts.modelsRoot, (p) => {
        this.download.progress = p;
      }).then(() => undefined)
      : this.downloadSovits();
    void work
      .then(() => {
        this.download = { running: false, progress: null, error: null };
        this.opts.log.info('BT 语音组件已下载', { engine: cfg.engine });
        then();
      })
      .catch((err: unknown) => {
        this.download = { running: false, progress: null, error: err instanceof Error ? err.message : String(err) };
        this.opts.log.warn('BT 语音组件下载失败', { err: this.download.error });
      });
  }

  private async downloadSovits(): Promise<void> {
    await this.sovits.detected();
    for (const job of [this.sovits.runtime, this.sovits.weights]) {
      await job.install();
      const st = job.status();
      if (st.phase !== 'ready') throw new Error(st.detail ?? 'GPT-SoVITS 组件下载失败');
    }
  }
}
