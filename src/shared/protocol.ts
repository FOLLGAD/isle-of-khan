import type { ClassId } from './classes';

/** Player snapshot: [id, x, y, aim, hp, flags] */
export type PlayerSnap = [number, number, number, number, number, number];
export const enum PF {
  Alive = 1,
  Shield = 2,
  Moving = 4,
  Dash = 8,
  Khan = 16,
  Hurt = 32,
}
/** Bog snapshot: [id, x, y, hp, flags] */
export type MobSnap = [number, number, number, number, number];
export const enum MF {
  Big = 1,
  Hurt = 2,
  Moving = 4,
  FaceLeft = 8,
}
export const enum ProjKind {
  Arrow = 0,
  Orb = 1,
}
/** Projectile snapshot: [id, kind, x, y, vx, vy, owner, seq] */
export type ProjSnap = [number, ProjKind, number, number, number, number, number, number];
/** Bomb snapshot: [id, x, y, fuse remaining 0..100] */
export type BombSnap = [number, number, number, number];
/** Heart snapshot: [id, x, y] */
export type HeartSnap = [number, number, number];

export const enum Ev {
  /** x, y, amount, isMob, targetId */
  Hit = 0,
  /** x, y */
  Boom = 1,
  /** playerId, aim */
  Swing = 2,
  /** playerId */
  Spin = 3,
  /** playerId, kind */
  Shoot = 4,
  /** playerId, x0, y0, x1, y1 */
  Blink = 5,
  /** playerId */
  Dash = 6,
  /** x, y, playerId */
  Pickup = 7,
  /** x, y, isMob, big */
  Die = 8,
  /** playerId */
  Throw = 9,
  /** x, y */
  Burst = 10,
  /** x, y */
  Spawn = 11,
  /** x, y — a projectile struck something solid */
  Thud = 12,
}
export type EventSnap = [Ev, ...number[]];

/** [id, name, class, score, kills, deaths, bogs, ping] */
export type RosterEntry = [number, string, ClassId, number, number, number, number, number];

export type KillHow = 'arrow' | 'sword' | 'orb' | 'bomb' | 'spin' | 'bog';

export interface RoundResult {
  name: string;
  cls: ClassId;
  score: number;
  kills: number;
  deaths: number;
  bogs: number;
}

export type ServerMsg =
  | { t: 'welcome'; id: number; room: string; private: boolean }
  | { t: 'full' }
  | {
      t: 's';
      /** Server time of this snapshot. */
      st: number;
      /** Last input sequence the server applied for the receiving player. */
      ack: number;
      /** Receiving player's packed `Body` (see sim.ts) when alive. */
      me: number[] | null;
      p: PlayerSnap[];
      m: MobSnap[];
      pr: ProjSnap[];
      b: BombSnap[];
      h: HeartSnap[];
      e: EventSnap[];
    }
  | { t: 'roster'; r: RosterEntry[]; khan: number }
  | { t: 'chat'; from: string | null; m: string }
  | { t: 'kill'; k: string | null; v: string; kid: number; vid: number; how: KillHow }
  | { t: 'dead'; by: string | null; respawnIn: number }
  | { t: 'khan'; id: number; name: string }
  | { t: 'round'; phase: 'play' | 'end'; endsIn: number; results: RoundResult[] }
  | { t: 'pong'; c: number };

/** Input: [seq, keys, aim, dist] */
export type InputSnap = [number, number, number, number];

export type ClientMsg =
  | { t: 'in'; i: InputSnap[] }
  | { t: 'chat'; m: string }
  | { t: 'respawn'; cls: ClassId }
  | { t: 'ping'; c: number; rtt: number };
