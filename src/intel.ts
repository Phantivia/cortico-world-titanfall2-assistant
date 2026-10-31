/**
 * Mod frames → text for the model. Pure functions: directions are clock positions relative to the
 * pilot's view, distances metres, health percentages. Game strings (weapon names, NPC titles, boss
 * titles, the objective) come localized from the client VM through `Lookup`; class and map names
 * without a game string use the tables here.
 */
import type { Frame } from './engine-ipc.ts';
import { UNITS_PER_METER, type EnemyFrame, type TitanFrame, type Vec3, type WeaponFrame } from './protocol.ts';

export const MISSILE_WEAPON = 'mp_titanweapon_shoulder_rockets';
/** smart_ammo_max_targeted_burst of the multi-target missile system. */
export const MISSILE_BURST = 12;

const MAP_NAMES: Record<string, string> = {
  sp_training: '第1章 铁驭训练场(The Pilot\'s Gauntlet)',
  sp_crashsite: '第2章 BT-7274',
  sp_sewers1: '第3章 血与锈(Blood and Rust)',
  sp_boomtown_start: '第4章 坠入深渊(Into the Abyss)',
  sp_boomtown: '第4章 坠入深渊(Into the Abyss)',
  sp_boomtown_end: '第4章 坠入深渊(Into the Abyss)',
  sp_hub_timeshift: '第5章 因果效应(Effect and Cause)',
  sp_timeshift_spoke02: '第5章 因果效应(Effect and Cause)',
  sp_beacon: '第6章 信标(The Beacon)',
  sp_beacon_spoke0: '第6章 信标(The Beacon)',
  sp_tday: '第7章 烈火试炼(Trial by Fire)',
  sp_s2s: '第8章 方舟(The Ark)',
  sp_skyway_v1: '第9章 折叠武器(The Fold Weapon)',
};

const CLASS_NAMES: Record<string, string> = {
  npc_soldier: '步兵',
  npc_spectre: '幽灵机器人',
  npc_stalker: '潜行者',
  npc_super_spectre: '死神',
  npc_titan: '泰坦',
  npc_drone: '无人机',
  npc_frag_drone: '自爆蜘蛛',
  npc_prowler: '掠食兽',
  npc_turret_sentry: '哨戒炮塔',
  npc_turret_mega: '重型炮塔',
  npc_dropship: '运输机',
  npc_gunship: '炮艇',
  npc_marvin: '马文',
  npc_pilot_elite: '精英铁驭',
};

/** Localized game strings by token; null until the client VM answered. */
export interface Lookup {
  text(token: string | undefined): string | null;
}

export function mapName(map: string): string {
  return MAP_NAMES[map] ? `${MAP_NAMES[map]} [${map}]` : map;
}

export function meters(units: number): number {
  return units / UNITS_PER_METER;
}

export interface Relative {
  /** 1–12, 12 straight ahead of the pilot's view. */
  clock: number;
  meters: number;
  /** Height above the pilot in metres. */
  rise: number;
}

/** Yaw 0 looks along +x and grows counter-clockwise seen from above (Source convention). */
export function relative(from: Vec3, yaw: number, to: Vec3): Relative {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
  let rel = bearing - yaw;
  rel = ((((rel + 180) % 360) + 360) % 360) - 180;
  const clock = ((Math.round(-rel / 30) % 12) + 12) % 12 || 12;
  return { clock, meters: meters(Math.hypot(dx, dy)), rise: meters(to[2] - from[2]) };
}

export function whereText(r: Relative): string {
  const m = Math.round(r.meters);
  const rise = Math.round(r.rise);
  const height = Math.abs(rise) >= 4 ? (rise > 0 ? `,高 ${rise} 米` : `,低 ${-rise} 米`) : '';
  return `${r.clock}点钟 ${m} 米${height}`;
}

export function pct(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
}

/** Short labels (E1, E2…) for enemy handles; a label sticks to its entity until pruned. */
export class Labels {
  private readonly byId = new Map<number, { label: string; seenAt: number }>();
  private next = 1;

  label(id: number, now: number): string {
    const hit = this.byId.get(id);
    if (hit) {
      hit.seenAt = now;
      return hit.label;
    }
    const label = `E${this.next++}`;
    this.byId.set(id, { label, seenAt: now });
    return label;
  }

  idOf(label: string): number | null {
    const want = label.trim().toUpperCase();
    for (const [id, v] of this.byId) if (v.label === want) return id;
    return null;
  }

  /** Forgets entities unseen for `maxAgeMs`. */
  prune(now: number, maxAgeMs: number): void {
    for (const [id, v] of this.byId) if (now - v.seenAt > maxAgeMs) this.byId.delete(id);
  }

  reset(): void {
    this.byId.clear();
    this.next = 1;
  }
}

/** The table name of an NPC class. */
export function className(cls: string): string {
  return CLASS_NAMES[cls] ?? cls.replace(/^npc_/, '');
}

export function enemyName(e: EnemyFrame, lookup: Lookup): string {
  if (e.boss) return lookup.text(e.bossTitle) ?? e.boss;
  const title = lookup.text(e.title);
  if (title && e.cls !== 'npc_soldier') return title;
  return CLASS_NAMES[e.cls] ?? title ?? e.cls.replace(/^npc_/, '');
}

export function weaponName(w: WeaponFrame, lookup: Lookup): string {
  return lookup.text(w.title) ?? w.name.replace(/^mp_(titan)?weapon_/, '');
}

/** Tokens in a frame that the client VM should localize. */
export function frameTokens(frame: Frame): string[] {
  const out = new Set<string>();
  const add = (t: string | undefined): void => {
    if (t && t.startsWith('#')) out.add(t);
  };
  for (const w of [...(frame.player?.weapons ?? []), ...(frame.player?.offhands ?? []), ...(frame.bt?.weapons ?? []), ...(frame.bt?.offhands ?? [])]) add(w.title);
  for (const e of frame.enemies ?? []) {
    add(e.title);
    add(e.bossTitle);
  }
  return [...out];
}

function ammoText(w: WeaponFrame): string {
  if (w.clipMax <= 0) return '';
  return ` 弹匣 ${w.clip}/${w.clipMax}${w.stock >= 0 ? ` 备弹 ${w.stock}` : ''}`;
}

export function pilotLine(frame: Frame, lookup: Lookup): string {
  const p = frame.player;
  if (!p) return '铁驭:没有读数';
  if (!p.alive) return '铁驭:阵亡';
  if (p.titan) return `铁驭:在 BT 驾驶舱里`;
  const active = p.weapons.find((w) => w.name === p.active);
  const gun = active ? `,手持 ${weaponName(active, lookup)}${ammoText(active)}` : '';
  return `铁驭:生命 ${pct(p.hp, p.hpMax)}%${gun}`;
}

export interface Readiness {
  /** Missiles BT can fire now; null without the multi-target missile system. */
  missiles: number | null;
  /** Seconds until the World cooldown of an action ends; 0 is ready. */
  smokeSec: number;
  pulseSec: number;
  missilesSec: number;
}

export function readiness(frame: Frame): Readiness {
  const bt = frame.bt;
  const launcher = bt?.offhands.find((w) => w.name === MISSILE_WEAPON);
  const ready = frame.ready ?? {};
  let missiles: number | null = null;
  if (launcher) missiles = bt!.embarked ? Math.floor((1 - launcher.charge) * MISSILE_BURST + 0.001) : (ready.missiles ?? 0) > 0 ? 0 : MISSILE_BURST;
  return { missiles, smokeSec: Math.ceil(ready.smoke ?? 0), pulseSec: Math.ceil(ready.pulse ?? 0), missilesSec: Math.ceil(ready.missiles ?? 0) };
}

export function coreText(bt: TitanFrame, now: number): string | null {
  if (bt.coreValue === undefined) return null;
  if (bt.coreFromDamage) return bt.coreValue >= 1 ? '核心就绪' : `核心 ${Math.round(bt.coreValue * 100)}%`;
  const left = Math.ceil(bt.coreValue - now);
  return left <= 0 ? '核心就绪' : `核心还要 ${left} 秒`;
}

export function btLine(frame: Frame): string {
  const bt = frame.bt;
  if (!bt) return 'BT:不在这一关';
  if (!bt.alive) return 'BT:已被摧毁';
  const parts = [`生命 ${pct(bt.hp, bt.hpMax)}%`];
  if (bt.shieldMax) parts.push(`护盾 ${pct(bt.shield ?? 0, bt.shieldMax)}%`);
  if (bt.doomed) parts.push('濒死');
  const core = coreText(bt, frame.time);
  if (core) parts.push(core);
  const r = readiness(frame);
  if (r.missiles !== null) parts.push(r.missiles > 0 ? `飞弹可发 ${r.missiles} 枚` : r.missilesSec > 0 ? `飞弹冷却 ${r.missilesSec} 秒` : '飞弹充能中');
  if (bt.rodeo) parts.push('有敌方铁驭骑在 BT 身上');
  const p = frame.player;
  if (!bt.embarked && p) parts.push(`在你 ${whereText(relative(p.pos, p.yaw, bt.pos))}`);
  return `BT:${bt.embarked ? '你在驾驶;' : ''}${parts.join(',')}`;
}

export interface SeenEnemy {
  label: string;
  name: string;
  e: EnemyFrame;
  rel: Relative;
}

export function seenEnemies(frame: Frame, labels: Labels, lookup: Lookup, now: number): SeenEnemy[] {
  const p = frame.player;
  if (!p) return [];
  return (frame.enemies ?? []).map((e) => ({ label: labels.label(e.id, now), name: enemyName(e, lookup), e, rel: relative(p.pos, p.yaw, e.pos) }));
}

const TARGET_TEXT = { pilot: '在打你', bt: '在打 BT', '': '' } as const;

export function enemyText(s: SeenEnemy): string {
  const bits = [`${s.label} ${s.name}`, whereText(s.rel)];
  if (s.e.cls === 'npc_titan' || s.e.boss || s.e.cls === 'npc_super_spectre') {
    bits.push(`生命 ${pct(s.e.hp, s.e.hpMax)}%`);
    if (s.e.doomed) bits.push('濒死');
  }
  if (s.e.target) bits.push(TARGET_TEXT[s.e.target]);
  if (!s.e.los) bits.push('看不见');
  return bits.join(' ');
}

/** Counts by name, nearest first: 步兵×5、潜行者×2. */
export function countText(list: SeenEnemy[]): string {
  const counts = new Map<string, number>();
  for (const s of list) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return [...counts].map(([n, c]) => `${n}×${c}`).join('、');
}

/** The hostile picture for snapshots: counts, then the nearest few with labels. */
export function enemiesBlock(list: SeenEnemy[], maxListed: number): string {
  if (list.length === 0) return '敌人:附近没有';
  const engaging = list.filter((s) => s.e.target).length;
  const head = `敌人 ${list.length} 个(${countText(list)})${engaging ? `,${engaging} 个正在交火` : ''}`;
  const important = list.filter((s) => s.e.cls === 'npc_titan' || s.e.boss || s.e.cls === 'npc_super_spectre');
  const near = list.slice(0, maxListed);
  const shown = [...near, ...important.filter((s) => !near.includes(s))];
  return [head, ...shown.map((s) => `- ${enemyText(s)}`)].join('\n');
}

export function objectiveLine(frame: Frame, objective: string): string {
  const p = frame.player;
  const pos = frame.objective?.pos;
  const at = pos && p ? `,${whereText(relative(p.pos, p.yaw, pos))}` : '';
  return objective ? `目标:${objective}${at}` : pos && p ? `目标点${at}` : '目标:暂无';
}
