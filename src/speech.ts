/**
 * BT speaking: text → subtitle pages → (voice) → subtitle in the game while the audio plays.
 *
 * A line is split into pages of at most two subtitle lines; each page is synthesized while the
 * previous one plays, and its subtitle goes up when its audio starts. Without a voice the subtitle
 * stays for a reading time.
 */
import type { Logger } from 'cortico/core/types.ts';
import type { Titanfall2ConfigSection } from './config.ts';
import type { Player } from './player.ts';
import type { Pcm, Voice } from './voice.ts';

export const SPEAKER = 'BT: ';
const PAGE_LINES = 2;
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

/** Sentence-sized pages of at most PAGE_LINES lines; the first line of the first page carries the speaker. */
export function pages(text: string, perLine: number): string[][] {
  const lines = wrap(`${SPEAKER}${text}`, perLine);
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += PAGE_LINES) out.push(lines.slice(i, i + PAGE_LINES));
  return out;
}

export interface SubtitleSink {
  show(lines: string[], sec: number): Promise<void>;
  hide(): Promise<void>;
}

export interface SpeechOptions {
  cfg: () => Pick<Titanfall2ConfigSection, 'voice' | 'subtitle'>;
  voice: Voice;
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
    const gen = this.gen;
    const { subtitle, voice } = this.opts.cfg();
    const list = pages(text, subtitle.charsPerLine);
    const useVoice = voice.enabled && this.opts.voiceReady();
    const synths = useVoice ? list.map((p) => this.synthLater(p)) : [];
    let firstDone!: (r: SayResult) => void;
    const first = new Promise<SayResult>((r) => (firstDone = r));
    this.tail = this.tail.then(async () => {
      let problem: string | null = null;
      let voicedAny = false;
      for (let i = 0; i < list.length; i++) {
        if (gen !== this.gen) break;
        let audio: Pcm | null = null;
        if (useVoice) {
          try {
            audio = await synths[i]();
          } catch (err) {
            problem = `语音合成失败:${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (gen !== this.gen) break;
        const sec = audio ? (audio.durationMs + TAIL_MS) / 1000 : Math.max(this.opts.cfg().subtitle.minSec, (width(list[i].join('')) * READ_MS_PER_CHAR) / 1000);
        if (audio) {
          await this.opts.player.write(audio.sampleRate, audio.pcm);
          this.opts.player.flush();
          voicedAny = true;
        }
        let shown = true;
        await this.opts.sink.show(list[i], sec).catch((err: unknown) => {
          shown = false;
          problem = `字幕没送进游戏:${err instanceof Error ? err.message : String(err)}`;
        });
        if (i === 0) firstDone({ shown, voiced: voicedAny, problem });
        await new Promise<void>((r) => {
          const t = setTimeout(r, sec * 1000);
          this.wake = () => { clearTimeout(t); r(); };
        });
        this.wake = null;
      }
      firstDone({ shown: false, voiced: voicedAny, problem: problem ?? '被打断' });
    });
    return first;
  }

  /** Stops the current line and drops queued ones. */
  async hush(): Promise<void> {
    this.gen++;
    this.wake?.();
    this.opts.player.cut();
    await this.opts.sink.hide().catch(() => undefined);
  }

  /** Starts synthesis now; the returned function awaits it. */
  private synthLater(page: string[]): () => Promise<Pcm> {
    const text = page.join('').replace(SPEAKER, '');
    const p = this.opts.voice.synth(text);
    p.catch(() => undefined);
    return () => p;
  }
}
