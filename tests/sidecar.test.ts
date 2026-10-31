import { afterEach, describe, expect, it } from 'vitest';
import type { EngineNotice } from '../src/engine-ipc.ts';
import type { ServerPost } from '../src/protocol.ts';
import { Sidecar } from '../src/sidecar.ts';

let sidecar: Sidecar | null = null;
afterEach(() => sidecar?.close());

async function open(): Promise<{ notices: EngineNotice[]; post: (path: string, body: unknown) => Promise<any> }> {
  const notices: EngineNotice[] = [];
  sidecar = new Sidecar((n) => notices.push(n));
  const port = await sidecar.listen(0);
  const post = async (path: string, body: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) });
    return res.json();
  };
  return { notices, post };
}

const serverPost = (extra: Partial<ServerPost> = {}): ServerPost => ({ v: 1, seq: 0, map: 'sp_crashsite', time: 10, events: [], acks: [], ...extra });

describe('Sidecar', () => {
  it('relays a server post as link, frame and events, and hands queued commands to the next post', async () => {
    const { notices, post } = await open();
    const acked = sidecar!.command({ op: 'smoke', cooldownSec: 5 }, 2000);
    const reply = await post('/server', serverPost({ events: [{ kind: 'embark', time: 10 }] }));
    expect(reply.cmds).toEqual([{ op: 'smoke', cooldownSec: 5, id: expect.any(Number) }]);
    expect(notices.map((n) => n.notice)).toEqual(['link', 'frame', 'events']);
    expect((notices[1] as { frame: object }).frame).not.toHaveProperty('events');

    await post('/server', serverPost({ seq: 1, acks: [{ id: reply.cmds[0].id, ok: true }] }));
    await expect(acked).resolves.toEqual({ id: reply.cmds[0].id, ok: true });
    expect((await post('/server', serverPost({ seq: 2 }))).cmds).toEqual([]);
  });

  it('withdraws a command the game never picked up when it times out', async () => {
    const { post } = await open();
    await expect(sidecar!.command({ op: 'pulse' }, 50)).rejects.toThrow('did not pick up');
    expect((await post('/server', serverPost())).cmds).toEqual([]);
  });

  it('delivers a subtitle and localization requests to the client poll once', async () => {
    const { notices, post } = await open();
    const sub = { lines: ['BT: 铁驭。'], sec: 2, pos: [0, 0.36] as [number, number], size: 30, alpha: 1, color: [1, 1, 1] as [number, number, number] };
    const shown = sidecar!.showSubtitle(sub, 2000);
    sidecar!.localize(['#WPN_RSPN101', 'plain']);
    const first = await post('/client', { map: 'sp_crashsite', objective: '', subtitle: false, localized: {} });
    expect(first).toEqual({ subtitle: sub, localize: ['#WPN_RSPN101'] });
    await expect(shown).resolves.toBeUndefined();

    const second = await post('/client', { map: 'sp_crashsite', objective: '找到 BT', subtitle: true, localized: { '#WPN_RSPN101': 'R-201 卡賓槍' } });
    expect(second).toEqual({});
    const client = notices.filter((n) => n.notice === 'client');
    expect(client.at(-1)).toMatchObject({ post: { objective: '找到 BT', localized: { '#WPN_RSPN101': 'R-201 卡賓槍' } } });
  });
});
