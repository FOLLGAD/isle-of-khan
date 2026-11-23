import { CLASSES, type ClassId } from '../shared/classes';
import { Key, TILE } from '../shared/constants';
import { shotBlocked, walkBlocked, type GameMap } from '../shared/map';
import type { Player, World } from './world';

export const BOT_NAMES = [
  'Subutai', 'Jebe', 'Mukhali', 'Ogedei', 'Tolui', 'Khasar', 'Chagatai', 'Jochi', 'Borte', 'Toghrul', 'Jamukha',
  'Batu', 'Hulagu', 'Mongke', 'Kublai', 'Belgutei', 'Sorghaghtani', 'Bo\'orchu', 'Qasar', 'Temuge',
];

interface Target {
  kind: 'player' | 'mob' | 'heart' | 'spot';
  id: number;
  x: number;
  y: number;
}

/** Ideal fighting distance per class: warriors close in, ranged classes kite. */
const RANGE: Record<ClassId, { min: number; max: number; fire: number }> = {
  warrior: { min: 0, max: 70, fire: 125 },
  archer: { min: 240, max: 420, fire: 620 },
  mage: { min: 220, max: 380, fire: 520 },
};
const PROJ_SPEED: Record<ClassId, number> = { archer: 1.6, mage: 0.78, warrior: Infinity };
const CHEST = 44;

const dirKeys = (dx: number, dy: number) => {
  const d = Math.hypot(dx, dy);
  if (d < 6) return 0;
  const nx = dx / d, ny = dy / d;
  let k = 0;
  if (nx > 0.38) k |= Key.Right;
  if (nx < -0.38) k |= Key.Left;
  if (ny > 0.38) k |= Key.Down;
  if (ny < -0.38) k |= Key.Up;
  return k;
};

/** Samples a straight line against a tile grid predicate. */
function lineClear(x0: number, y0: number, x1: number, y1: number, blocked: (x: number, y: number) => boolean) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 16);
  for (let i = 1; i < n; i++) if (blocked(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)) return false;
  return true;
}

/** A path of tile centers from (x0,y0) to (x1,y1), by breadth-first search over walkable tiles. */
function findPath(m: GameMap, x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] | null {
  const sx = Math.floor(x0 / TILE), sy = Math.floor(y0 / TILE), tx = Math.floor(x1 / TILE), ty = Math.floor(y1 / TILE);
  if (walkBlocked(m, tx, ty)) return null;
  const prev = new Int32Array(m.w * m.h).fill(-1);
  const start = sy * m.w + sx, goal = ty * m.w + tx;
  const queue = new Int32Array(m.w * m.h);
  let head = 0, tail = 0;
  queue[tail++] = start;
  prev[start] = start;
  while (head < tail) {
    const c = queue[head++];
    if (c === goal) break;
    const cx = c % m.w, cy = (c / m.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (walkBlocked(m, nx, ny)) continue;
      const n = ny * m.w + nx;
      if (prev[n] !== -1) continue;
      prev[n] = c;
      queue[tail++] = n;
    }
  }
  if (prev[goal] === -1) return null;
  const path: { x: number; y: number }[] = [];
  for (let c = goal; c !== start; c = prev[c]) path.push({ x: (c % m.w + 0.5) * TILE, y: (((c / m.w) | 0) + 0.5) * TILE });
  return path.reverse();
}

/**
 * Drives one bot. Each server tick it looks at the world and decides which keys to hold and where
 * to aim, exactly like a human client would; the world then feeds that through the normal input path.
 */
export class BotBrain {
  /** 0..1; better bots react faster and aim straighter. */
  readonly skill = 0.45 + Math.random() * 0.45;
  respawnDelay = 0;
  private target: Target | null = null;
  private retargetAt = 0;
  private acquiredAt = 0;
  private path: { x: number; y: number }[] = [];
  private pathAt = 0;
  private pathGoal = { x: 0, y: 0 };
  private strafe = Math.random() < 0.5 ? 1 : -1;
  private strafeUntil = 0;
  private aimError = 0;
  private aimErrorAt = 0;
  private last = new Map<number, { x: number; y: number; t: number; vx: number; vy: number }>();
  private stuckSince = 0;
  private lastPos = { x: 0, y: 0 };
  private unstickUntil = 0;
  private unstick = { x: 0, y: 0 };
  private wantBomb = 0;

  constructor(readonly id: number) {}

  think(v: World, me: Player): { keys: number; aim: number; dist: number } {
    const now = v.now, b = me.body, cls = me.cls;
    this.trackVelocities(v);
    if (now >= this.retargetAt || !this.targetValid(v)) this.pickTarget(v, me);
    const t = this.target!;
    let keys = 0;
    let aim = Math.atan2(t.y - CHEST - (b.y - CHEST), t.x - b.x);
    let dist = Math.hypot(t.x - b.x, t.y - b.y);

    // Where to stand.
    let goal = { x: t.x, y: t.y };
    const range = RANGE[cls];
    const fighting = t.kind === 'player' || t.kind === 'mob';
    if (fighting && cls !== 'warrior' && dist < range.max + 80) {
      if (now > this.strafeUntil) {
        this.strafe = -this.strafe;
        this.strafeUntil = now + 700 + Math.random() * 1100;
      }
      const ax = (b.x - t.x) / (dist || 1), ay = (b.y - t.y) / (dist || 1);
      const back = dist < range.min ? 1 : dist > range.max ? -1 : 0;
      goal = { x: b.x + (ax * back - ay * this.strafe) * 120, y: b.y + (ay * back + ax * this.strafe) * 120 };
    }
    // Get away from bombs that are about to go off.
    for (const bomb of v.bombs) {
      const d = Math.hypot(bomb.x - b.x, bomb.y - b.y);
      if (d < 210 && bomb.fuse < 750) goal = { x: b.x + ((b.x - bomb.x) / (d || 1)) * 200, y: b.y + ((b.y - bomb.y) / (d || 1)) * 200 };
    }
    keys |= this.steer(v.map, b, goal, now);

    if (fighting) {
      const p = this.predict(t, b, cls);
      aim = Math.atan2(p.y - CHEST - (b.y - CHEST), p.x - b.x) + this.noise(now);
      dist = Math.hypot(p.x - b.x, p.y - b.y);
      const reacted = now - this.acquiredAt > 550 - this.skill * 350;
      const clear = lineClear(b.x, b.y, t.x, t.y, (x, y) => shotBlocked(v.map, x, y));
      if (reacted && clear && dist < range.fire) keys |= Key.Primary;
      // Bombs: lob one now and then at someone at medium range.
      if (reacted && b.cdS === 0 && dist > 140 && dist < 460 && now > this.wantBomb) {
        this.wantBomb = now + 1500 + Math.random() * 4000;
        if (Math.random() < 0.55) keys |= Key.Secondary;
      }
      keys |= this.special(cls, me, b, t, dist, v, (a) => (aim = a), (d) => (dist = d));
    } else if (t.kind === 'heart' && cls === 'archer' && b.cdX === 0 && dist > 300) {
      keys |= Key.Special;
    }
    return { keys, aim, dist };
  }

  private special(
    cls: ClassId, me: { hp: number }, b: { x: number; y: number; cdX: number }, t: Target, dist: number, v: World,
    setAim: (a: number) => void, setDist: (d: number) => void,
  ) {
    if (b.cdX > 0) return 0;
    const lowHp = me.hp < CLASSES[cls].hp * 0.35;
    if (cls === 'warrior') {
      let near = 0;
      for (const p of v.players.values()) if (p.alive && p.id !== this.id && Math.hypot(p.body.x - b.x, p.body.y - b.y) < 130) near++;
      for (const m of v.mobs) if (Math.hypot(m.x - b.x, m.y - b.y) < 130) near++;
      return near >= 2 || (near >= 1 && Math.random() < 0.02) ? Key.Special : 0;
    }
    if (dist < 150 || (lowHp && dist < 300)) {
      // Escape: aim away from the threat (dash goes the way we walk, blink goes where we aim).
      const away = Math.atan2(b.y - t.y, b.x - t.x) + (Math.random() - 0.5) * 0.8;
      setAim(away);
      setDist(400);
      return Key.Special;
    }
    return 0;
  }

  /** Lead the target by its recent velocity so arrows and orbs arrive where it will be. */
  private predict(t: Target, b: { x: number; y: number }, cls: ClassId) {
    const vel = this.last.get(t.kind === 'player' ? t.id : -t.id);
    const speed = PROJ_SPEED[cls];
    if (!vel || !Number.isFinite(speed)) return t;
    const time = Math.min(800, Math.hypot(t.x - b.x, t.y - b.y) / speed) * this.skill;
    return { x: t.x + vel.vx * time, y: t.y + vel.vy * time };
  }

  private noise(now: number) {
    if (now > this.aimErrorAt) {
      this.aimErrorAt = now + 250 + Math.random() * 300;
      this.aimError = (Math.random() - 0.5) * (0.05 + (1 - this.skill) * 0.4);
    }
    return this.aimError;
  }

  private trackVelocities(v: World) {
    const seen = (key: number, x: number, y: number) => {
      const l = this.last.get(key);
      if (l && v.now > l.t) {
        const dt = v.now - l.t;
        l.vx = l.vx * 0.5 + ((x - l.x) / dt) * 0.5;
        l.vy = l.vy * 0.5 + ((y - l.y) / dt) * 0.5;
        (l.x = x), (l.y = y), (l.t = v.now);
      } else if (!l) this.last.set(key, { x, y, t: v.now, vx: 0, vy: 0 });
    };
    for (const p of v.players.values()) if (p.alive) seen(p.id, p.body.x, p.body.y);
    for (const m of v.mobs) seen(-m.id, m.x, m.y);
  }

  private targetValid(v: World) {
    const t = this.target;
    if (!t) return false;
    if (t.kind === 'player') {
      for (const p of v.players.values()) if (p.id === t.id && p.alive) return ((t.x = p.body.x), (t.y = p.body.y), true);
      return false;
    }
    if (t.kind === 'mob') {
      const m = v.mobs.find((q) => q.id === t.id);
      return !!m && ((t.x = m.x), (t.y = m.y), true);
    }
    if (t.kind === 'heart') return v.hearts.some((h) => h.x === t.x && h.y === t.y);
    return Math.hypot(t.x - this.lastPos.x, t.y - this.lastPos.y) > 120;
  }

  private pickTarget(v: World, me: Player) {
    const b = me.body;
    this.retargetAt = v.now + 700 + Math.random() * 600;
    const old = this.target;
    let best: Target | null = null, bestScore = Infinity;
    const consider = (t: Target, score: number) => {
      if (score < bestScore) (bestScore = score), (best = t);
    };
    const hurt = me.hp < CLASSES[me.cls].hp * 0.5;
    for (const h of v.hearts) {
      const d = Math.hypot(h.x - b.x, h.y - b.y);
      if (hurt && d < 900) consider({ kind: 'heart', id: 0, x: h.x, y: h.y }, d - 400);
    }
    for (const p of v.players.values()) {
      if (!p.alive || p.id === this.id) continue;
      const d = Math.hypot(p.body.x - b.x, p.body.y - b.y);
      if (d > 1100) continue;
      // Everyone loves to topple the Khan; stick with the current target to avoid dithering.
      const score = d - (v.khan === p.id ? 250 : 0) - (old?.kind === 'player' && old.id === p.id ? 150 : 0) + (v.now < p.shieldUntil ? 400 : 0);
      consider({ kind: 'player', id: p.id, x: p.body.x, y: p.body.y }, score);
    }
    for (const m of v.mobs) {
      const d = Math.hypot(m.x - b.x, m.y - b.y);
      if (d < 800) consider({ kind: 'mob', id: m.id, x: m.x, y: m.y }, d + 120 - (old?.kind === 'mob' && old.id === m.id ? 150 : 0));
    }
    if (!best) {
      // Nothing nearby: head for the nearest fight, or wander the isle.
      let nearest: Target | null = null, nd = Infinity;
      for (const p of v.players.values()) {
        if (!p.alive || p.id === this.id) continue;
        const d = Math.hypot(p.body.x - b.x, p.body.y - b.y);
        if (d < nd) (nd = d), (nearest = { kind: 'spot', id: 0, x: p.body.x, y: p.body.y });
      }
      if (old?.kind === 'spot' && this.targetValid(v)) best = old;
      else if (nearest && Math.random() < 0.7) best = nearest;
      else {
        for (let i = 0; i < 50 && !best; i++) {
          const tx = Math.floor(Math.random() * v.map.w), ty = Math.floor(Math.random() * v.map.h);
          if (!walkBlocked(v.map, tx, ty)) best = { kind: 'spot', id: 0, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
        }
      }
    }
    this.target = best ?? { kind: 'spot', id: 0, x: v.map.wizard.x, y: v.map.wizard.y + TILE };
    if (!old || old.kind !== this.target.kind || old.id !== this.target.id) this.acquiredAt = v.now;
  }

  /** Keys that move us toward `goal`, routing around trees and water. */
  private steer(m: GameMap, b: { x: number; y: number }, goal: { x: number; y: number }, now: number) {
    // Stuck against something for a while: shuffle sideways for a moment.
    if (Math.hypot(b.x - this.lastPos.x, b.y - this.lastPos.y) > 2) this.stuckSince = now;
    this.lastPos = { x: b.x, y: b.y };
    if (now < this.unstickUntil) return dirKeys(this.unstick.x, this.unstick.y);
    if (now - this.stuckSince > 400 && Math.hypot(goal.x - b.x, goal.y - b.y) > 40) {
      const a = Math.random() * Math.PI * 2;
      this.unstick = { x: Math.cos(a), y: Math.sin(a) };
      this.unstickUntil = now + 300;
      this.stuckSince = now;
      this.path = [];
    }
    const walkable = (x: number, y: number) => walkBlocked(m, Math.floor(x / TILE), Math.floor(y / TILE));
    if (lineClear(b.x, b.y, goal.x, goal.y, walkable) && !walkable(goal.x, goal.y)) {
      this.path = [];
      return dirKeys(goal.x - b.x, goal.y - b.y);
    }
    if (!this.path.length || now - this.pathAt > 600 || Math.hypot(goal.x - this.pathGoal.x, goal.y - this.pathGoal.y) > 128) {
      this.path = findPath(m, b.x, b.y, goal.x, goal.y) ?? [];
      this.pathAt = now;
      this.pathGoal = { ...goal };
    }
    // Skip waypoints we can already walk straight to.
    while (this.path.length > 1 && lineClear(b.x, b.y, this.path[1].x, this.path[1].y, walkable)) this.path.shift();
    const next = this.path[0];
    if (!next) return dirKeys(goal.x - b.x, goal.y - b.y);
    if (Math.hypot(next.x - b.x, next.y - b.y) < 20) this.path.shift();
    return dirKeys(next.x - b.x, next.y - b.y);
  }
}
