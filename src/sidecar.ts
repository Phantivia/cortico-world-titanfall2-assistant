/**
 * The loopback HTTP endpoint the Northstar mod posts to. The server VM posts `/server` every tick
 * and gets queued commands back; the client VM polls `/client` for subtitles and localization
 * requests. Runs in the engine child; everything it learns goes out as notices.
 */
import http from 'node:http';
import type { EngineNotice } from './engine-ipc.ts';
import type { ClientPost, ClientReply, CommandAck, ServerCommand, ServerPost, SubtitleCommand } from './protocol.ts';

/** A VM that has not posted for this long counts as gone (paused, loading, or closed). */
export const LINK_TIMEOUT_MS = 3000;
const MAX_BODY = 1 << 20;

interface Waiter<T> {
  done: (v: T) => void;
  fail: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Sidecar {
  private server: http.Server | null = null;
  private nextCmd = 1;
  private readonly queue: ServerCommand[] = [];
  private readonly waiting = new Map<number, Waiter<CommandAck>>();
  private subtitle: (Waiter<void> & { sub: SubtitleCommand }) | null = null;
  private hide = false;
  private readonly toLocalize = new Set<string>();
  private readonly lastAt = { server: 0, client: 0 };
  private readonly up = { server: false, client: false };
  private linkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly notify: (n: EngineNotice) => void) {}

  listen(port: number): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as { port: number }).port);
    const server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.linkTimer = setInterval(() => this.checkLinks(), 500);
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  command(cmd: Omit<ServerCommand, 'id'>, timeoutMs: number): Promise<CommandAck> {
    const id = this.nextCmd++;
    this.queue.push({ ...cmd, id });
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        const at = this.queue.findIndex((c) => c.id === id);
        if (at >= 0) this.queue.splice(at, 1);
        fail(new Error(at >= 0 ? 'game did not pick up the command' : 'game did not acknowledge the command'));
      }, timeoutMs);
      this.waiting.set(id, { done, fail, timer });
    });
  }

  showSubtitle(sub: SubtitleCommand, timeoutMs: number): Promise<void> {
    if (this.subtitle) {
      clearTimeout(this.subtitle.timer);
      this.subtitle.done();
    }
    this.hide = false;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.subtitle = null;
        fail(new Error('game did not pick up the subtitle'));
      }, timeoutMs);
      this.subtitle = { sub, done, fail, timer };
    });
  }

  hideSubtitle(): void {
    if (this.subtitle) {
      clearTimeout(this.subtitle.timer);
      this.subtitle.done();
      this.subtitle = null;
    }
    this.hide = true;
  }

  localize(tokens: string[]): void {
    for (const t of tokens) if (t.startsWith('#')) this.toLocalize.add(t);
  }

  close(): void {
    if (this.linkTimer) clearInterval(this.linkTimer);
    this.linkTimer = null;
    this.server?.close();
    this.server = null;
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.fail(new Error('sidecar closed'));
      this.waiting.delete(id);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = req.url === '/server' ? 'server' : req.url === '/client' ? 'client' : null;
    if (req.method !== 'POST' || !route) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let reply: unknown;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = route === 'server' ? this.onServer(body as ServerPost) : this.onClient(body as ClientPost);
      } catch (err) {
        this.notify({ notice: 'log', level: 'warn', text: `bad ${route} post: ${String(err)}` });
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(reply));
    });
  }

  private markUp(side: 'server' | 'client'): void {
    this.lastAt[side] = Date.now();
    if (this.up[side]) return;
    this.up[side] = true;
    this.notify({ notice: 'link', side, up: true });
  }

  private checkLinks(): void {
    const now = Date.now();
    for (const side of ['server', 'client'] as const) {
      if (this.up[side] && now - this.lastAt[side] > LINK_TIMEOUT_MS) {
        this.up[side] = false;
        this.notify({ notice: 'link', side, up: false });
      }
    }
  }

  private onServer(post: ServerPost): { cmds: ServerCommand[] } {
    this.markUp('server');
    const { events, acks, ...frame } = post;
    this.notify({ notice: 'frame', frame, receivedAtMs: Date.now() });
    if (events?.length) this.notify({ notice: 'events', events });
    for (const ack of acks ?? []) {
      const w = this.waiting.get(ack.id);
      if (!w) continue;
      clearTimeout(w.timer);
      this.waiting.delete(ack.id);
      w.done(ack);
    }
    return { cmds: this.queue.splice(0) };
  }

  private onClient(post: ClientPost): ClientReply {
    this.markUp('client');
    for (const t of Object.keys(post.localized ?? {})) this.toLocalize.delete(t);
    this.notify({ notice: 'client', post });
    const reply: ClientReply = {};
    if (this.hide) {
      reply.hide = true;
      this.hide = false;
    }
    if (this.subtitle) {
      reply.subtitle = this.subtitle.sub;
      clearTimeout(this.subtitle.timer);
      this.subtitle.done();
      this.subtitle = null;
    }
    if (this.toLocalize.size) reply.localize = [...this.toLocalize];
    return reply;
  }
}
