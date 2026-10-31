/**
 * The game's picture, read in the engine child through koffi.
 *
 * The game window is the visible top-level window titled "Titanfall 2" of a NorthstarLauncher.exe
 * or Titanfall2.exe process. The game draws through DirectX 11, which PrintWindow cannot read (it
 * returns black or stale pixels), so the picture is the screen under the window's client area and
 * exists only while the game is the foreground window. Overlays on top of the game show in it. The process is per-monitor DPI aware (v2), so
 * sizes are physical pixels. Frames are scaled to fit `maxWidth` and coded as JPEG.
 */
import koffi from 'koffi';
import jpeg from 'jpeg-js';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const POINT = koffi.struct('TF2_POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('TF2_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const BITMAPINFOHEADER = koffi.struct('TF2_BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t',
  biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
});
const EnumWindowsProc = koffi.proto('bool __stdcall TF2EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(TF2EnumWindowsProc *cb, intptr_t lParam)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ TF2_RECT *rect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ TF2_POINT *p)');
const GetDC = user32.func('void *__stdcall GetDC(intptr_t hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hwnd, void *dc)');
const CreateCompatibleDC = gdi32.func('void *__stdcall CreateCompatibleDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void *__stdcall CreateCompatibleBitmap(void *dc, int w, int h)');
const SelectObject = gdi32.func('void *__stdcall SelectObject(void *dc, void *obj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *obj)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void *dc)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32_t rop)');
const StretchBlt = gdi32.func('bool __stdcall StretchBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, int sw, int sh, uint32_t rop)');
const SetStretchBltMode = gdi32.func('int __stdcall SetStretchBltMode(void *dc, int mode)');
const SetBrushOrgEx = gdi32.func('bool __stdcall SetBrushOrgEx(void *dc, int x, int y, void *prev)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(void *dc, void *bmp, uint32_t start, uint32_t lines, void *bits, _Inout_ TF2_BITMAPINFOHEADER *bmi, uint32_t usage)');
const OpenProcess = kernel32.func('void *__stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');

const SRCCOPY = 0x00cc0020, CAPTUREBLT = 0x40000000, HALFTONE = 4;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GAME_IMAGES = ['northstarlauncher.exe', 'titanfall2.exe'];
const GAME_TITLE = 'Titanfall 2';

SetProcessDpiAwarenessContext(-4);

function imageName(pid: number): string {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return '';
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return '';
    const path = String.fromCharCode(...buf.subarray(0, size[0]));
    return path.slice(path.lastIndexOf('\\') + 1).toLowerCase();
  } finally {
    CloseHandle(h);
  }
}

/** The game window, or null when the game has none open. */
export function findGameWindow(): bigint | null {
  let found: bigint | null = null;
  const text = new Uint16Array(256);
  const cb = koffi.register((hwnd: bigint | number) => {
    if (!IsWindowVisible(hwnd)) return true;
    const n = GetWindowTextW(hwnd, text, text.length);
    if (String.fromCharCode(...text.subarray(0, n)) !== GAME_TITLE) return true;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!GAME_IMAGES.includes(imageName(pid[0]))) return true;
    found = BigInt(hwnd);
    return false;
  }, koffi.pointer(EnumWindowsProc));
  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found;
}

export type Frame = { ok: true; jpeg: Uint8Array; width: number; height: number } | { ok: false; reason: 'no-window' | 'minimized' | 'background' | 'blank' };

function readBits(dc: unknown, bmp: unknown, width: number, height: number): Uint8Array {
  const bmi = { biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
  const out = new Uint8Array(width * height * 4);
  GetDIBits(dc, bmp, 0, height, out, bmi, 0);
  return out;
}

/** Almost every pixel is near black or one level: a loading screen or a window that drew nothing yet. */
function flat(bgra: Uint8Array): boolean {
  const step = Math.max(4, Math.floor(bgra.length / 4 / 8192) * 4);
  let lit = 0, n = 0, min = 255, max = 0;
  for (let i = 0; i < bgra.length; i += step, n++) {
    const g = (bgra[i] + bgra[i + 1] + bgra[i + 2]) / 3;
    if (g > 24) lit++;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  return max - min < 8 || lit / n < 0.01;
}

function toRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2];
    out[i + 1] = bgra[i + 1];
    out[i + 2] = bgra[i];
    out[i + 3] = 255;
  }
  return out;
}

/** One JPEG of the game's client area, scaled to at most `maxWidth` wide. */
export function captureGame(maxWidth: number, quality: number): Frame {
  const hwnd = findGameWindow();
  if (hwnd === null) return { ok: false, reason: 'no-window' };
  if (IsIconic(hwnd)) return { ok: false, reason: 'minimized' };
  if (BigInt(GetForegroundWindow()) !== hwnd) return { ok: false, reason: 'background' };
  const rc = { left: 0, top: 0, right: 0, bottom: 0 };
  GetClientRect(hwnd, rc);
  const w = rc.right - rc.left, h = rc.bottom - rc.top;
  if (w <= 0 || h <= 0) return { ok: false, reason: 'blank' };
  const scale = Math.min(1, maxWidth / w);
  const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));

  const screen = GetDC(0);
  const full = CreateCompatibleDC(screen);
  const fullBmp = CreateCompatibleBitmap(screen, w, h);
  const oldFull = SelectObject(full, fullBmp);
  const small = CreateCompatibleDC(screen);
  const smallBmp = CreateCompatibleBitmap(screen, ow, oh);
  const oldSmall = SelectObject(small, smallBmp);
  try {
    const shrink = (): Uint8Array => {
      SetStretchBltMode(small, HALFTONE);
      SetBrushOrgEx(small, 0, 0, null);
      StretchBlt(small, 0, 0, ow, oh, full, 0, 0, w, h, SRCCOPY);
      return readBits(small, smallBmp, ow, oh);
    };
    const p = { x: 0, y: 0 };
    ClientToScreen(hwnd, p);
    if (!BitBlt(full, 0, 0, w, h, screen, p.x, p.y, SRCCOPY | CAPTUREBLT)) return { ok: false, reason: 'blank' };
    const bgra = shrink();
    if (flat(bgra)) return { ok: false, reason: 'blank' };
    const coded = jpeg.encode({ data: toRgba(bgra), width: ow, height: oh }, quality);
    return { ok: true, jpeg: new Uint8Array(coded.data), width: ow, height: oh };
  } finally {
    SelectObject(small, oldSmall);
    DeleteObject(smallBmp);
    DeleteDC(small);
    SelectObject(full, oldFull);
    DeleteObject(fullBmp);
    DeleteDC(full);
    ReleaseDC(0, screen);
  }
}
