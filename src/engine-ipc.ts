/** Messages between Titanfall2World and the engine child (the sidecar the mod posts to); fork IPC. */
import type { ClientPost, CommandAck, GameEvent, ServerCommand, ServerPost, SubtitleCommand } from './protocol.ts';

export type EngineRequest =
  /** Binds 127.0.0.1:port; the reply is the bound port. */
  | { op: 'listen'; port: number }
  /** Hands a command to the next server post and resolves with its ack. */
  | { op: 'command'; cmd: Omit<ServerCommand, 'id'>; timeoutMs: number }
  /** Hands a subtitle to the next client poll; resolves when the client took it. */
  | { op: 'subtitle'; sub: SubtitleCommand; timeoutMs: number }
  | { op: 'hide-subtitle' }
  /** Asks the client VM to localize these tokens; answers arrive as `client` notices. */
  | { op: 'localize'; tokens: string[] }
  | { op: 'close' };

/** The server post without its one-shot parts. */
export type Frame = Omit<ServerPost, 'events' | 'acks'>;

export type EngineNotice =
  | { notice: 'frame'; frame: Frame; receivedAtMs: number }
  | { notice: 'events'; events: GameEvent[] }
  | { notice: 'client'; post: ClientPost }
  /** A VM started or stopped posting; `down` after no post for the link timeout. */
  | { notice: 'link'; side: 'server' | 'client'; up: boolean }
  | { notice: 'log'; level: 'info' | 'warn'; text: string };

export type CommandResult = CommandAck;

export type MainToChild = { id: number; req: EngineRequest };
export type ChildToMain =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
  | { id: 0; notice: EngineNotice };
