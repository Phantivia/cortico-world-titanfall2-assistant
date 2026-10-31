/**
 * BT's voice runtime and VoxCPM2 weights, downloaded when missing.
 *
 * They go where the vtuber World keeps them, so either World uses what the other installed: the
 * runtime at `<runtimes>/llama.cpp-omni/<release>/<key>/` with `cortico-runtime.json`, the weights in
 * the voice model directory (`<models>/vtuber/` unless configured). The runtime is the project's
 * llama.cpp-omni build plus ggml-org's CUDA runtime libraries; the weights are pinned to a revision.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Titanfall2ConfigSection } from './config.ts';
import { downloadFile, unzip, type Progress } from './download.ts';
import { ACOUSTIC, BASE_LM, SERVER_EXE, voiceDirs } from './voice.ts';

type VoiceConfig = Titanfall2ConfigSection['voice'];

const RUNTIME_RELEASE = 'tts-b64d092c-5';
const RUNTIME_KEY = 'win-cuda-13.3-x64';
const RUNTIME_ARCHIVES = [
  `https://github.com/Phantivia/llama.cpp-omni/releases/download/${RUNTIME_RELEASE}/llama-tts-server-${RUNTIME_KEY}.zip`,
  `https://github.com/ggml-org/llama.cpp/releases/download/b10930/cudart-llama-bin-${RUNTIME_KEY}.zip`,
];
const MODEL_BASE = 'https://huggingface.co/DennisHuang648/VoxCPM2-GGUF/resolve/169f64d';
const MODELS = [
  { file: BASE_LM, bytes: 3_247_980_544 },
  { file: ACOUSTIC, bytes: 1_825_096_352 },
];
/** The runtime archives together, for the size shown before downloading. */
const RUNTIME_BYTES = 123_010_295 + 390_970_417;

export interface VoiceAssets {
  /** A running server is configured: nothing to download. */
  external: boolean;
  runtimeDir: string | null;
  modelsDir: string;
  /** Weight files not in the model directory. */
  missingModels: string[];
  /** Approximate bytes still to download. */
  downloadBytes: number;
}

export function voiceAssets(cfg: VoiceConfig, runtimesRoot: string, modelsRoot: string): VoiceAssets {
  const { runtimeDir, modelsDir } = voiceDirs(cfg, runtimesRoot, modelsRoot);
  const external = cfg.serverUrl.trim() !== '';
  const missing = external ? [] : MODELS.filter((m) => !existsSync(join(modelsDir, m.file)));
  const needRuntime = !external && !runtimeDir;
  return {
    external,
    runtimeDir,
    modelsDir,
    missingModels: missing.map((m) => m.file),
    downloadBytes: missing.reduce((n, m) => n + m.bytes, needRuntime ? RUNTIME_BYTES : 0),
  };
}

/** Downloads whatever `voiceAssets` reports missing; a configured runtime directory is never written to. */
export async function downloadVoiceAssets(cfg: VoiceConfig, runtimesRoot: string, modelsRoot: string, onProgress: (p: Progress) => void): Promise<VoiceAssets> {
  const before = voiceAssets(cfg, runtimesRoot, modelsRoot);
  if (before.external) return before;
  if (!before.runtimeDir) {
    if (cfg.runtimeDir.trim()) throw new Error(`运行时目录 ${cfg.runtimeDir} 里没有 ${SERVER_EXE}`);
    const dir = join(runtimesRoot, 'llama.cpp-omni', RUNTIME_RELEASE, RUNTIME_KEY);
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      for (const url of RUNTIME_ARCHIVES) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        const file = join(partial, name);
        await downloadFile(url, file, name, onProgress);
        onProgress({ label: name, done: 0, total: null });
        await unzip(file, partial);
        rmSync(file, { force: true });
      }
      if (!existsSync(join(partial, SERVER_EXE))) throw new Error(`运行时压缩包里没有 ${SERVER_EXE}`);
      writeFileSync(
        join(partial, 'cortico-runtime.json'),
        `${JSON.stringify({ runtime: 'llama.cpp-omni', release: RUNTIME_RELEASE, key: RUNTIME_KEY, archives: RUNTIME_ARCHIVES.map((u) => u.slice(u.lastIndexOf('/') + 1)), installedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      rmSync(dir, { recursive: true, force: true });
      renameSync(partial, dir);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      throw err;
    }
  }
  for (const file of before.missingModels) await downloadFile(`${MODEL_BASE}/${file}`, join(before.modelsDir, file), file, onProgress);
  return voiceAssets(cfg, runtimesRoot, modelsRoot);
}
