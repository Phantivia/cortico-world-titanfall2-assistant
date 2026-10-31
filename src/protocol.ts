/**
 * What the Northstar mod posts to the sidecar and what the sidecar answers
 * (mod/Cortico.Titanfall2Assistant/.../cortico_tf2/*.gnut). Positions are game units, angles degrees.
 */

export type Vec3 = [number, number, number];

export interface WeaponFrame {
  name: string;
  /** printname localization token. */
  title: string;
  clip: number;
  clipMax: number;
  stock: number;
  /** Used fraction of a charge weapon: 0 is full, 1 is empty. */
  charge: number;
}

export interface PilotFrame {
  alive: boolean;
  hp: number;
  hpMax: number;
  /** Embarked: the player is BT. */
  titan: boolean;
  pos: Vec3;
  yaw: number;
  team: number;
  weapons: WeaponFrame[];
  offhands: WeaponFrame[];
  active: string;
}

export interface TitanFrame {
  embarked: boolean;
  alive: boolean;
  hp: number;
  hpMax: number;
  pos: Vec3;
  shield?: number;
  shieldMax?: number;
  doomed?: boolean;
  /** A 0–1 meter when coreFromDamage, else the game time the core becomes available. */
  coreValue?: number;
  coreFromDamage?: boolean;
  /** A hostile pilot is riding BT. */
  rodeo: boolean;
  weapons: WeaponFrame[];
  offhands: WeaponFrame[];
}

export interface EnemyFrame {
  /** Encoded entity handle; stable while the entity lives. */
  id: number;
  cls: string;
  pos: Vec3;
  hp: number;
  hpMax: number;
  /** Whom it is attacking. */
  target: '' | 'pilot' | 'bt';
  /** Clear line of sight from the pilot's eyes. */
  los: boolean;
  shield?: number;
  doomed?: boolean;
  /** NPC title localization token. */
  title?: string;
  /** Internal boss name of a mercenary titan. */
  boss?: string;
  /** The boss title localization token. */
  bossTitle?: string;
}

export interface ObjectiveFrame {
  index: number;
  pos?: Vec3;
}

export type GameEvent =
  | { kind: 'level'; time: number }
  | { kind: 'save_loaded'; time: number }
  | { kind: 'pilot_died'; by: string; source: number; time: number }
  | { kind: 'kill'; cls: string; by: string; boss?: string; time: number }
  | { kind: 'bt_doomed'; by: string; time: number }
  | { kind: 'titan_doomed'; id: number; by: string; boss?: string; time: number }
  | { kind: 'embark'; time: number }
  | { kind: 'disembark'; time: number };

export type CommandOp = 'missiles' | 'smoke' | 'pulse';

export interface CommandAck {
  id: number;
  ok: boolean;
  reason?: 'no_pilot' | 'no_titan' | 'no_missiles' | 'no_targets' | 'cooldown' | 'charging' | 'no_weapon' | 'unknown_op';
  fired?: number;
  targets?: number;
  burst?: number;
  charge?: number;
}

/** POST /server body. */
export interface ServerPost {
  v: 1;
  seq: number;
  map: string;
  time: number;
  player?: PilotFrame;
  bt?: TitanFrame;
  enemies?: EnemyFrame[];
  objective?: ObjectiveFrame;
  /** Seconds until the World-cooled support actions are ready again. */
  ready?: Partial<Record<CommandOp, number>>;
  events: GameEvent[];
  acks: CommandAck[];
}

export interface ServerCommand {
  id: number;
  op: CommandOp;
  targets?: number[];
  count?: number;
  cooldownSec?: number;
}

/** POST /client body. */
export interface ClientPost {
  map: string;
  /** The current objective in the game's language; empty without one. */
  objective: string;
  /** A subtitle is on screen. */
  subtitle: boolean;
  localized: Record<string, string>;
}

export interface SubtitleCommand {
  lines: string[];
  sec: number;
  /** cockpit_console_text_center msgPos. */
  pos: [number, number];
  size: number;
  alpha: number;
  color: [number, number, number];
}

export interface ClientReply {
  subtitle?: SubtitleCommand;
  hide?: true;
  localize?: string[];
}

export const UNITS_PER_METER = 39.37;
