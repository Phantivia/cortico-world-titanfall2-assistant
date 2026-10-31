/**
 * The primary screen's resolution and the display modes it lists, read in the engine child through koffi.
 * The process is per-monitor DPI aware (v2), so sizes are physical pixels.
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const EnumDisplaySettingsW = user32.func('bool __stdcall EnumDisplaySettingsW(const char16_t *device, int mode, void *devmode)');

/** sizeof(DEVMODEW) and the offsets this reads; the struct is filled into a plain buffer. */
const DEVMODE_SIZE = 220;
const OFF_SIZE = 68;
const OFF_WIDTH = 172;
const OFF_HEIGHT = 176;
const ENUM_CURRENT_SETTINGS = -1;

SetProcessDpiAwarenessContext(-4);

export interface ScreenModes {
  width: number;
  height: number;
  /** Distinct `<width>x<height>`, largest area first. */
  modes: string[];
}

function mode(index: number): { width: number; height: number } | null {
  const dm = Buffer.alloc(DEVMODE_SIZE);
  dm.writeUInt16LE(DEVMODE_SIZE, OFF_SIZE);
  if (!EnumDisplaySettingsW(null, index, dm)) return null;
  return { width: dm.readUInt32LE(OFF_WIDTH), height: dm.readUInt32LE(OFF_HEIGHT) };
}

export function primaryScreen(): ScreenModes | null {
  const current = mode(ENUM_CURRENT_SETTINGS);
  if (!current) return null;
  const seen = new Map<string, number>();
  for (let i = 0; i < 1000; i++) {
    const m = mode(i);
    if (!m) break;
    seen.set(`${m.width}x${m.height}`, m.width * m.height);
  }
  const modes = [...seen].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { width: current.width, height: current.height, modes };
}
