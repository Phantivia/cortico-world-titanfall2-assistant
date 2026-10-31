/**
 * Downloads for the one-time setup: Northstar and BT's voice runtime and models.
 *
 * A file is written to `<dest>.partial` and renamed when complete, so an interrupted download never
 * passes for a finished one. ZIP archives are unpacked by the tar.exe that ships with Windows 10 and
 * later; it refuses entries with absolute paths or `..`.
 */
import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

export interface Progress {
  /** What is being fetched or unpacked, for people. */
  label: string;
  done: number;
  total: number | null;
}

export async function downloadFile(url: string, dest: string, label: string, onProgress: (p: Progress) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载 ${url} 失败:HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  let done = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      onProgress({ label, done, total });
      callback(null, chunk);
    },
  });
  const partial = `${dest}.partial`;
  mkdirSync(dirname(dest), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), counter, createWriteStream(partial));
    rmSync(dest, { force: true });
    renameSync(partial, dest);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

export function unzip(file: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', file, '-C', destDir], { windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(`解压 ${file} 失败:${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}
