/** Engine child entry: runs the sidecar the mod posts to and relays it over fork IPC. */
import type { ChildToMain, EngineNotice, MainToChild } from './engine-ipc.ts';
import { Sidecar } from './sidecar.ts';

const send = (msg: ChildToMain): void => {
  process.send?.(msg);
};
const sidecar = new Sidecar((notice: EngineNotice) => send({ id: 0, notice }));

process.on('message', (msg: MainToChild) => {
  const { id, req } = msg;
  const reply = (p: Promise<unknown>): void => {
    p.then((value) => send({ id, ok: true, value }), (err: unknown) => send({ id, ok: false, error: err instanceof Error ? err.message : String(err) }));
  };
  switch (req.op) {
    case 'listen':
      return reply(sidecar.listen(req.port));
    case 'command':
      return reply(sidecar.command(req.cmd, req.timeoutMs));
    case 'subtitle':
      return reply(sidecar.showSubtitle(req.sub, req.timeoutMs));
    case 'hide-subtitle':
      sidecar.hideSubtitle();
      return reply(Promise.resolve(null));
    case 'localize':
      sidecar.localize(req.tokens);
      return reply(Promise.resolve(null));
    case 'close':
      sidecar.close();
      reply(Promise.resolve(null));
      setTimeout(() => process.exit(0), 50);
      return;
  }
});

process.on('disconnect', () => {
  sidecar.close();
  process.exit(0);
});
