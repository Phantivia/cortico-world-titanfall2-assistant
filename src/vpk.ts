/**
 * Reads single files out of the installed game's VPKs.
 *
 * Titanfall 2 VPKs are Respawn's v2.3 layout: `<lang>client_<name>.pak000_dir.vpk` holds the tree,
 * entries name an archive `client_<name>.pak000_<NNN>.vpk`, and each part is either stored or
 * LZHAM-compressed (a modified alpha8 with a 2^20 dictionary). Decompression runs in
 * vendor/tf2lzham/tf2lzham.wasm (pg9182/tf2lzham, MIT); its four WASI imports are stubbed because
 * it never does I/O.
 */
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_FILE = fileURLToPath(new URL('../vendor/tf2lzham/tf2lzham.wasm', import.meta.url));
const VPK_MAGIC = 0x55aa1234;

interface Part {
  archive: number;
  offset: number;
  compressed: number;
  size: number;
}

let wasmModule: WebAssembly.Module | null = null;

function instance(): WebAssembly.Instance {
  wasmModule ??= new WebAssembly.Module(readFileSync(WASM_FILE));
  const nosys = (): number => 52;
  return new WebAssembly.Instance(wasmModule, {
    wasi_snapshot_preview1: { fd_close: nosys, fd_fdstat_get: nosys, fd_seek: nosys, fd_write: nosys },
  });
}

/** One LZHAM-compressed VPK part to `size` bytes. A fresh instance per call keeps memory bounded. */
export function lzhamDecompress(src: Uint8Array, size: number): Buffer {
  const inst = instance();
  const ex = inst.exports as {
    memory: WebAssembly.Memory;
    tf2lzham_malloc(n: number): number;
    tf2lzham_decompress(dst: number, dstLen: number, src: number, srcLen: number, adler: number, crc: number): number;
    tf2lzham_decompress_strerror(status: number): number;
  };
  const ptr = ex.tf2lzham_malloc(12 + size + src.length);
  const lenOff = ptr, adlOff = ptr + 4, crcOff = ptr + 8, dstOff = ptr + 12, srcOff = dstOff + size;
  const view = (): DataView => new DataView(ex.memory.buffer);
  view().setUint32(lenOff, size, true);
  new Uint8Array(ex.memory.buffer, srcOff, src.length).set(src);
  const status = ex.tf2lzham_decompress(dstOff, lenOff, srcOff, src.length, adlOff, crcOff);
  const msgPtr = ex.tf2lzham_decompress_strerror(status);
  if (msgPtr !== 0) {
    const bytes = new Uint8Array(ex.memory.buffer, msgPtr, 128);
    throw new Error(`lzham: ${Buffer.from(bytes.subarray(0, bytes.indexOf(0))).toString()}`);
  }
  const n = view().getUint32(lenOff, true);
  return Buffer.from(new Uint8Array(ex.memory.buffer, dstOff, n));
}

function cstr(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(0, at);
  return [buf.toString('latin1', at, end), end + 1];
}

/** path → parts, for every file in a `_dir.vpk`. */
export function readTree(dirVpk: string): Map<string, Part[]> {
  const buf = readFileSync(dirVpk);
  if (buf.readUInt32LE(0) !== VPK_MAGIC) throw new Error(`${dirVpk} is not a VPK directory`);
  const out = new Map<string, Part[]>();
  let at = 16;
  for (;;) {
    let ext: string, dir: string, name: string;
    [ext, at] = cstr(buf, at);
    if (!ext) break;
    for (;;) {
      [dir, at] = cstr(buf, at);
      if (!dir) break;
      for (;;) {
        [name, at] = cstr(buf, at);
        if (!name) break;
        at += 6; // crc32, preload bytes
        const parts: Part[] = [];
        for (;;) {
          const archive = buf.readUInt16LE(at);
          at += 2;
          if (archive === 0xffff) break;
          parts.push({ archive, offset: Number(buf.readBigUInt64LE(at + 6)), compressed: Number(buf.readBigUInt64LE(at + 14)), size: Number(buf.readBigUInt64LE(at + 22)) });
          at += 30;
        }
        out.set(dir === ' ' ? `${name}.${ext}` : `${dir}/${name}.${ext}`, parts);
      }
    }
  }
  return out;
}

/** One file's bytes; null when the VPK has no such path. */
export function readVpkFile(dirVpk: string, path: string): Buffer | null {
  const parts = readTree(dirVpk).get(path);
  if (!parts) return null;
  const archiveBase = join(dirname(dirVpk), basename(dirVpk).replace(/^[a-z]+client_/, 'client_').replace(/_dir\.vpk$/, ''));
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const fd = openSync(`${archiveBase}_${String(p.archive).padStart(3, '0')}.vpk`, 'r');
    try {
      const raw = Buffer.alloc(p.compressed);
      readSync(fd, raw, 0, p.compressed, p.offset);
      chunks.push(p.compressed === p.size ? raw : lzhamDecompress(raw, p.size));
    } finally {
      closeSync(fd);
    }
  }
  return Buffer.concat(chunks);
}

/** The `_dir.vpk` of a map in the game's `vpk/` folder, in the English tree every install has. */
export function dirVpkOf(gameDir: string, map: string): string {
  return join(gameDir, 'vpk', `englishclient_${map}.bsp.pak000_dir.vpk`);
}
