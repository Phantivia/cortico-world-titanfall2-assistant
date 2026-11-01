/**
 * BT speaking: text → subtitle pages → (voice) → subtitle in the game while the audio plays.
 *
 * VoxCPM2 synthesizes the whole line in one piece and it plays without gaps; its subtitle pages turn over in step
 * with the audio. GPT-SoVITS streams the line's audio, which starts playing with the first chunk (sayStreaming).
 * Without a voice each page stays for a reading time.
 */
import type { Logger } from 'cortico/core/types.ts';
import type { Titanfall2ConfigSection } from './config.ts';
import { liftOf, type Player } from './player.ts';
import type { Pcm, VoiceEngine } from './voice.ts';

export const SPEAKER = 'BT: ';
const PAGE_LINES = 2;
/** Speaking time per unit of subtitle width while a streamed line's total length is still unknown (measured on GPT-SoVITS). */
const STREAM_MS_PER_WIDTH = 200;
/** How long the last page of a streamed line may stay before the client hides it on its own; it is hidden when the audio ends. */
const LAST_PAGE_HOLD_SEC = 60;
/** Reading time per character without a voice. */
const READ_MS_PER_CHAR = 220;
const TAIL_MS = 400;

/** Display width: CJK and full-width characters count 1, the rest ½. */
export function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 1 : 0.5;
  return w;
}

const BREAK_AFTER = /[。！？!?；;，,、：:…\s]/;

/** Wraps text into lines of at most `perLine` width, preferring breaks after punctuation. */
export function wrap(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest) {
    if (width(rest) <= perLine) {
      lines.push(rest);
      break;
    }
    const chars = [...rest];
    let w = 0;
    let cut = 0;
    let soft = -1;
    for (let i = 0; i < chars.length; i++) {
      w += width(chars[i]);
      if (w > perLine) break;
      cut = i + 1;
      if (BREAK_AFTER.test(chars[i])) soft = i + 1;
    }
    const at = soft > cut * 0.5 ? soft : Math.max(cut, 1);
    lines.push(chars.slice(0, at).join('').trim());
    rest = chars.slice(at).join('').trim();
  }
  return lines;
}

/** Subtitle pages of at most PAGE_LINES lines; the first line carries the speaker. */
export function pages(text: string, perLine: number): string[][] {
  const lines = wrap(`${SPEAKER}${text}`, perLine);
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += PAGE_LINES) out.push(lines.slice(i, i + PAGE_LINES));
  return out;
}

/**
 * How long each page stays: with a voice, the audio's length shared by the pages' widths (the last page also
 * keeps the tail), so the subtitle turns while one continuous voice reads on; without, a reading time per page.
 */
export function pageSeconds(list: string[][], durationMs: number | null, minSec: number): number[] {
  const widths = list.map((page) => width(page.join('')));
  if (durationMs === null) return widths.map((w) => Math.max(minSec, (w * READ_MS_PER_CHAR) / 1000));
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  return widths.map((w, i) => (durationMs * (w / total) + (i === list.length - 1 ? TAIL_MS : 0)) / 1000);
}

export interface SubtitleSink {
  show(lines: string[], sec: number): Promise<void>;
  hide(): Promise<void>;
}

export interface SpeechOptions {
  cfg: () => Pick<Titanfall2ConfigSection, 'voice' | 'subtitle'>;
  voice: VoiceEngine;
  /** The voice can synthesize now; otherwise the line goes out as subtitles only. */
  voiceReady: () => boolean;
  player: Player;
  sink: SubtitleSink;
  log: Logger;
}

export interface SayResult {
  /** The first page is on screen (and audible when voiced). */
  shown: boolean;
  voiced: boolean;
  /** Why the voice was skipped or the subtitle failed. */
  problem: string | null;
}

export class Speech {
  private gen = 0;
  private tail: Promise<void> = Promise.resolve();
  /** Ends the wait for the page on screen. */
  private wake: (() => void) | null = null;

  constructor(private readonly opts: SpeechOptions) {}

  /** Queues the line after whatever BT is saying; resolves when its first page starts. */
  say(text: string): Promise<SayResult> {
    const { subtitle, voice } = this.opts.cfg();
    const voiced = voice.enabled && this.opts.voiceReady();
    if (voiced && this.opts.voice.stream) return this.sayStreaming(text, this.opts.voice.stream(text));
    const gen = this.gen;
    const list = pages(text, subtitle.charsPerLine);
    // synthesis starts now, while an earlier line may still be playing
    const synth = voiced ? this.opts.voice.synth(text) : null;
    synth?.catch(() => undefined);
    let firstDone!: (r: SayResult) => void;
    const first = new Promise<SayResult>((r) => (firstDone = r));
    this.tail = this.tail.then(async () => {
      let problem: string | null = null;
      let audio: Pcm | null = null;
      if (synth) {
        try {
          audio = await synth;
        } catch (err) {
          problem = `语音合成失败:${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (gen !== this.gen) {
        firstDone({ shown: false, voiced: false, problem: '被打断' });
        return;
      }
      const secs = pageSeconds(list, audio?.durationMs ?? null, subtitle.minSec);
      if (audio) {
        await this.opts.player.write(audio.sampleRate, audio.pcm, liftOf(audio.pcm));
        this.opts.player.flush();
      }
      for (let i = 0; i < list.length; i++) {
        if (gen !== this.gen) break;
        let shown = true;
        await this.opts.sink.show(list[i], secs[i]).catch((err: unknown) => {
          shown = false;
          problem = `字幕没送进游戏:${err instanceof Error ? err.message : String(err)}`;
        });
        if (i === 0) firstDone({ shown, voiced: audio !== null, problem });
        await new Promise<void>((r) => {
          const timer = setTimeout(r, secs[i] * 1000);
          this.wake = () => { clearTimeout(timer); r(); };
        });
        this.wake = null;
      }
      firstDone({ shown: false, voiced: audio !== null, problem: problem ?? '被打断' });
    });
    return first;
  }

  /**
   * A line whose audio streams in: it starts playing with its first chunk and each chunk is written as it arrives,
   * so playback can pause where synthesis falls behind. The total length is unknown until the end, so pages turn
   * on an estimate from their widths and the last stays until the audio has played.
   */
  private sayStreaming(text: string, audio: AsyncIterable<Pcm>): Promise<SayResult> {
    const gen = this.gen;
    const list = pages(text, this.opts.cfg().subtitle.charsPerLine);
    // collecting starts now, while an earlier line may still be playing
    const chunks: Pcm[] = [];
    let ended = false;
    let failure: string | null = null;
    let notify: (() => void) | null = null;
    const wake = (): void => { notify?.(); notify = null; };
    void (async () => {
      try {
        for await (const c of audio) {
          chunks.push(c);
          wake();
          if (gen !== this.gen) break;
        }
      } catch (err) {
        failure = `语音合成失败:${err instanceof Error ? err.message : String(err)}`;
      } finally {
        ended = true;
        wake();
      }
    })();
    const next = async (i: number): Promise<Pcm | null> => {
      while (i >= chunks.length && !ended) await new Promise<void>((r) => (notify = r));
      return chunks[i] ?? null;
    };
    let firstDone!: (r: SayResult) => void;
    const first = new Promise<SayResult>((r) => (firstDone = r));
    this.tail = this.tail.then(async () => {
      const head = await next(0);
      if (gen !== this.gen) {
        firstDone({ shown: false, voiced: false, problem: '被打断' });
        return;
      }
      if (!head) {
        // no audio at all: the subtitles alone, at reading speed
        let shownAny = false;
        const secs = pageSeconds(list, null, this.opts.cfg().subtitle.minSec);
        for (let i = 0; i < list.length && gen === this.gen; i++) {
          let shown = true;
          await this.opts.sink.show(list[i], secs[i]).catch(() => { shown = false; });
          if (i === 0) firstDone({ shown, voiced: false, problem: failure });
          shownAny ||= shown;
          await this.pause(secs[i]);
        }
        firstDone({ shown: shownAny, voiced: false, problem: failure ?? '被打断' });
        return;
      }
      const lift = liftOf(head.pcm);
      const writing = (async () => {
        for (let i = 0; gen === this.gen; i++) {
          const c = i === 0 ? head : await next(i);
          if (!c || gen !== this.gen) break;
          await this.opts.player.write(c.sampleRate, c.pcm, lift);
        }
        this.opts.player.flush();
        await this.opts.player.drain();
      })();
      const secs = pageSeconds(list, list.reduce((n, page) => n + width(page.join('')), 0) * STREAM_MS_PER_WIDTH, 0);
      let problem: string | null = null;
      for (let i = 0; i < list.length && gen === this.gen; i++) {
        const last = i === list.length - 1;
        let shown = true;
        await this.opts.sink.show(list[i], last ? LAST_PAGE_HOLD_SEC : secs[i]).catch((err: unknown) => {
          shown = false;
          problem = `字幕没送进游戏:${err instanceof Error ? err.message : String(err)}`;
        });
        if (i === 0) firstDone({ shown, voiced: true, problem });
        if (last) {
          await Promise.race([writing, new Promise<void>((r) => { this.wake = r; })]);
          this.wake = null;
          await new Promise((r) => setTimeout(r, TAIL_MS));
          if (gen === this.gen) await this.opts.sink.hide().catch(() => undefined);
        } else {
          await this.pause(secs[i]);
        }
      }
      await writing;
      firstDone({ shown: false, voiced: true, problem: problem ?? '被打断' });
    });
    return first;
  }

  private async pause(sec: number): Promise<void> {
    await new Promise<void>((r) => {
      const timer = setTimeout(r, sec * 1000);
      this.wake = () => { clearTimeout(timer); r(); };
    });
    this.wake = null;
  }

  /** Stops the current line and drops queued ones. */
  async hush(): Promise<void> {
    this.gen++;
    this.wake?.();
    this.opts.player.cut();
    await this.opts.sink.hide().catch(() => undefined);
  }

}
