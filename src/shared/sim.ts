import { ATTACK_SLOW, BLINK_RANGE, BOMB_CD, CLASSES, DASH_SPEED, DASH_STEPS, type ClassId } from './classes';
import { Key, PLAYER_HH, PLAYER_HW, SIM_DT } from './constants';
import { boxBlocked, isShallow, moveBox, WADE_SPEED, type GameMap } from './map';

/** One fixed simulation step of player intent. `aim` is radians (0 = right, +y = down). */
export interface Input {
  seq: number;
  keys: number;
  aim: number;
  /** Distance from the player to the cursor, in world px. Sets bomb throw strength and blink range. */
  dist: number;
}

/**
 * Everything that affects player movement. The client predicts this locally and the server is
 * authoritative; both run `stepPlayer` with the same inputs so they agree.
 */
export interface Body {
  x: number;
  y: number;
  /** Knockback velocity, px/ms. */
  kx: number;
  ky: number;
  /** Remaining dash steps and dash direction. */
  dash: number;
  dashX: number;
  dashY: number;
  /** Cooldowns in steps: primary, secondary (bomb), special. */
  cdP: number;
  cdS: number;
  cdX: number;
  /** Steps of reduced speed after attacking. */
  slow: number;
  aim: number;
  moving: boolean;
}

export const enum Act {
  Primary = 1,
  Secondary = 2,
  Special = 4,
}

export const newBody = (x: number, y: number): Body => ({
  x, y, kx: 0, ky: 0, dash: 0, dashX: 0, dashY: 0, cdP: 0, cdS: 0, cdX: 0, slow: 0, aim: Math.PI / 2, moving: false,
});

export const BODY_FIELDS = ['x', 'y', 'kx', 'ky', 'dash', 'dashX', 'dashY', 'cdP', 'cdS', 'cdX', 'slow'] as const;
export const packBody = (b: Body) => BODY_FIELDS.map((f) => Math.round(b[f] * 1000) / 1000);
export function unpackBody(b: Body, packed: number[]) {
  BODY_FIELDS.forEach((f, i) => (b[f] = packed[i]));
}

/** Advances a player one fixed step. Returns the abilities that fired this step (`Act` bits). */
export function stepPlayer(m: GameMap, b: Body, cls: ClassId, input: Input): number {
  const def = CLASSES[cls];
  const k = input.keys;
  let acts = 0;
  b.aim = input.aim;
  if (b.cdP > 0) b.cdP--;
  if (b.cdS > 0) b.cdS--;
  if (b.cdX > 0) b.cdX--;
  if (b.slow > 0) b.slow--;

  let mx = (k & Key.Right ? 1 : 0) - (k & Key.Left ? 1 : 0);
  let my = (k & Key.Down ? 1 : 0) - (k & Key.Up ? 1 : 0);
  if (mx && my) (mx *= Math.SQRT1_2), (my *= Math.SQRT1_2);
  b.moving = mx !== 0 || my !== 0;

  if (k & Key.Primary && b.cdP === 0) {
    acts |= Act.Primary;
    b.cdP = def.primary.cd;
    b.slow = ATTACK_SLOW;
  }
  if (k & Key.Secondary && b.cdS === 0) {
    acts |= Act.Secondary;
    b.cdS = BOMB_CD;
  }
  const ax = Math.cos(input.aim), ay = Math.sin(input.aim);
  if (k & Key.Special && b.cdX === 0) {
    if (def.special.kind === 'dash') {
      acts |= Act.Special;
      b.cdX = def.special.cd;
      b.dash = DASH_STEPS;
      [b.dashX, b.dashY] = b.moving ? [mx, my] : [ax, ay];
    } else if (def.special.kind === 'blink') {
      // Land on the farthest free spot along the aim line, up to the cursor.
      for (let d = Math.min(input.dist, BLINK_RANGE); d >= 48; d -= 8) {
        const tx = b.x + ax * d, ty = b.y + ay * d;
        if (!boxBlocked(m, tx - PLAYER_HW, ty - PLAYER_HH, tx + PLAYER_HW, ty + PLAYER_HH)) {
          acts |= Act.Special;
          b.cdX = def.special.cd;
          b.x = tx;
          b.y = ty;
          break;
        }
      }
    } else {
      acts |= Act.Special;
      b.cdX = def.special.cd;
    }
  }

  let vx: number, vy: number;
  if (b.dash > 0) {
    b.dash--;
    vx = b.dashX * DASH_SPEED;
    vy = b.dashY * DASH_SPEED;
  } else {
    const speed = def.speed * (b.slow > 0 ? 0.6 : 1) * (isShallow(m, b.x, b.y) ? WADE_SPEED : 1);
    vx = mx * speed;
    vy = my * speed;
  }
  moveBox(m, b, PLAYER_HW, PLAYER_HH, (vx + b.kx) * SIM_DT, (vy + b.ky) * SIM_DT);
  b.kx *= 0.86;
  b.ky *= 0.86;
  if (Math.abs(b.kx) < 0.005) b.kx = 0;
  if (Math.abs(b.ky) < 0.005) b.ky = 0;
  return acts;
}
