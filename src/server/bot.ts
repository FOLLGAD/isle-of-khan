import { ARROW, CLASSES, ORB, type ClassId } from '../shared/classes';
import { Key, PLAYER_HH, PLAYER_HW, TILE } from '../shared/constants';
import { boxBlocked, shotBlocked, walkBlocked, type GameMap } from '../shared/map';
import { maxHp, priceOf, type ItemId } from '../shared/shop';
import type { Player, World } from './world';

export const BOT_NAMES = [
  'Subutai', 'Jebe', 'Mukhali', 'Ogedei', 'Tolui', 'Khasar', 'Chagatai', 'Jochi', 'Borte', 'Toghrul', 'Jamukha',
  'Batu', 'Hulagu', 'Mongke', 'Kublai', 'Belgutei', 'Sorghaghtani', 'Bo\'orchu', 'Qasar', 'Temuge',
];

/** How a bot plays its class. Tuned per class by `npm run train`. */
export interface Tactics {
  /** Preferred distance band to a target (px). Warriors keep min at 0 and close in. */
  min: number;
  max: number;
  /** Attack when the target is closer than this. */
  fire: number;
  /** Milliseconds between strafe direction changes while fighting at range. */
  strafe: number;
  /** Chance to lob a bomb when one is ready and the target is between bombMin and bombMax. */
  bomb: number;
  bombMin: number;
  bombMax: number;
  /** Archer and mage: use the class power to get away from anyone this close. */
  escape: number;
  /** Warrior: whirl when at least this many enemies are within reach. */
  spinNear: number;
  /** Go for hearts below this fraction of max HP. */
  heal: number;
  /** How far ahead to lead moving targets; 1 aims at the exact intercept. */
  lead: number;
  /** How hard to sidestep incoming projectiles; 0 ignores them. */
  evade: number;
  /** Zig-zag amplitude (px) while closing in on a target. */
  weave: number;
  /** Bogs must be this much closer than the nearest player to be preferred as targets. */
  bogBias: number;
}

/** Tuned with scripts/train.ts (self-play hill climbing), checked on held-out rounds. */
export const TACTICS: Record<ClassId, Tactics> = {
  archer: { min: 320, max: 420, fire: 600, strafe: 1250, bomb: 0.5, bombMin: 140, bombMax: 560, escape: 135, spinNear: 0, heal: 0.68, lead: 0.92, evade: 0, weave: 0, bogBias: 30 },
  warrior: { min: 0, max: 70, fire: 120, strafe: 1250, bomb: 0.55, bombMin: 140, bombMax: 505, escape: 0, spinNear: 1, heal: 0.43, lead: 1, evade: 0, weave: 0, bogBias: 200 },
  mage: { min: 225, max: 535, fire: 595, strafe: 1290, bomb: 0.55, bombMin: 175, bombMax: 460, escape: 190, spinNear: 0, heal: 0.59, lead: 1, evade: 0, weave: 0, bogBias: 120 },
};

/** The order each class buys upgrades in; repeats mean the next level. */
const SHOPPING: Record<ClassId, ItemId[]> = {
  warrior: ['armor', 'weapon', 'armor', 'weapon', 'powder', 'armor', 'weapon', 'powder'],
  archer: ['weapon', 'armor', 'weapon', 'powder', 'armor', 'weapon', 'powder', 'armor'],
  mage: ['weapon', 'armor', 'powder', 'weapon', 'armor', 'powder', 'weapon', 'armor'],
};

/** What a bot would buy right now, if it can afford it. */
export function botWish(me: Player): ItemId | null {
  if (me.hp < maxHp(me.cls, me.up) * 0.4 && me.coins >= (priceOf('potion', me.up) ?? Infinity)) return 'potion';
  const seen: Record<string, number> = {};
  for (const id of SHOPPING[me.cls]) {
    seen[id] = (seen[id] ?? 0) + 1;
    if (id !== 'potion' && me.up[id] < seen[id]) {
      const price = priceOf(id, me.up);
      return price !== null && me.coins >= price ? id : null;
    }
  }
  return null;
}

interface Target {
  kind: 'player' | 'mob' | 'heart' | 'spot' | 'coin' | 'shop';
  id: number;
  x: number;
  y: number;
}

const PROJ_SPEED: Record<ClassId, number> = { archer: ARROW.speed, mage: ORB.speed, warrior: Infinity };
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
export function findPath(m: GameMap, x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] | null {
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
  readonly skill: number;
  respawnDelay = 0;
  private target: Target | null = null;
  /** When this bot last greeted someone it spotted, for rate-limiting its greeting line. */
  greetedAt = -Infinity;
  private lastPlayerTarget = 0;
  private retargetAt = 0;
  private acquiredAt = 0;
  private path: { x: number; y: number }[] = [];
  private pathAt = 0;
  private pathGoal = { x: 0, y: 0 };
  private strafe: number;
  private strafeUntil = 0;
  private aimError = 0;
  private aimErrorAt = 0;
  /** Recent positions of everyone we can see, so we can perceive them with a human-like delay. */
  private seen = new Map<number, { t: number; x: number; y: number }[]>();
  /** How far in the past we see others (ms). People see the world ~100-150 ms late too. */
  private readonly delay: number;
  /** When the current target last came into attack range. */
  private inRangeSince = Infinity;
  private stuckSince = 0;
  private lastPos = { x: 0, y: 0 };
  private unstickUntil = 0;
  private unstick = { x: 0, y: 0 };
  private wantBomb = 0;
  private weavePhase: number;

  constructor(readonly id: number, private rand: () => number) {
    this.skill = 0.45 + rand() * 0.45;
    this.delay = 260 - this.skill * 140;
    this.strafe = rand() < 0.5 ? 1 : -1;
    this.weavePhase = rand() * Math.PI * 2;
  }

  /** The player this bot just started going after, if it switched to one this tick. */
  newPlayerTarget(): number | null {
    const id = this.target?.kind === 'player' ? this.target.id : 0;
    if (id === this.lastPlayerTarget) return null;
    this.lastPlayerTarget = id;
    return id || null;
  }

  think(v: World, me: Player, tactics: Tactics): { keys: number; aim: number; dist: number } {
    const now = v.now, b = me.body, cls = me.cls, rand = this.rand;
    this.trackPositions(v);
    if (now >= this.retargetAt || !this.targetValid(v, me)) this.pickTarget(v, me, tactics);
    this.trackRange(now, Math.hypot(this.target!.x - b.x, this.target!.y - b.y) < tactics.fire);
    const t = this.target!;
    let keys = 0;
    let aim = Math.atan2(t.y - CHEST - (b.y - CHEST), t.x - b.x);
    let dist = Math.hypot(t.x - b.x, t.y - b.y);

    // Where to stand.
    let goal = { x: t.x, y: t.y };
    const fighting = t.kind === 'player' || t.kind === 'mob';
    const ax = (b.x - t.x) / (dist || 1), ay = (b.y - t.y) / (dist || 1);
    if (fighting && tactics.min > 0 && dist < tactics.max + 80) {
      if (now > this.strafeUntil) {
        this.strafe = -this.strafe;
        this.strafeUntil = now + tactics.strafe * (0.5 + rand());
      }
      const back = dist < tactics.min ? 1 : dist > tactics.max ? -1 : 0;
      goal = { x: b.x + (ax * back - ay * this.strafe) * 120, y: b.y + (ay * back + ax * this.strafe) * 120 };
    } else if (fighting && dist > 150 && tactics.weave > 0) {
      // Zig-zag on the way in so archers have a harder time.
      const side = Math.sin(now / 260 + this.weavePhase) * tactics.weave;
      goal = { x: t.x - ay * side, y: t.y + ax * side };
    }
    // Sidestep arrows and orbs that are about to hit us.
    if (tactics.evade > 0) {
      for (const q of v.projs) {
        if (q.owner === this.id) continue;
        const rx = b.x - q.x, ry = b.y - CHEST - q.y, speed = Math.hypot(q.vx, q.vy);
        const tHit = (rx * q.vx + ry * q.vy) / (speed * speed);
        // Too close to react to, or too far to worry about yet.
        if (tHit < 140 || tHit > 450) continue;
        const miss = Math.abs(rx * q.vy - ry * q.vx) / speed;
        if (miss > 50) continue;
        const side = rx * q.vy - ry * q.vx >= 0 ? 1 : -1;
        goal = { x: b.x + (q.vy / speed) * side * 150 * tactics.evade, y: b.y - (q.vx / speed) * side * 150 * tactics.evade };
        break;
      }
    }
    // Get away from bombs that are about to go off.
    for (const bomb of v.bombs) {
      const d = Math.hypot(bomb.x - b.x, bomb.y - b.y);
      if (d < 210 && bomb.fuse < 750) goal = { x: b.x + ((b.x - bomb.x) / (d || 1)) * 200, y: b.y + ((b.y - bomb.y) / (d || 1)) * 200 };
    }
    keys |= this.steer(v.map, b, goal, now);

    if (fighting) {
      const p = this.predict(t, b, cls, tactics.lead);
      aim = Math.atan2(p.y - CHEST - (b.y - CHEST), p.x - b.x) + this.noise(now);
      dist = Math.hypot(p.x - b.x, p.y - b.y);
      const reaction = 550 - this.skill * 350;
      const reacted = now - this.acquiredAt > reaction && now - this.inRangeSince > reaction * 0.6;
      const clear = lineClear(b.x, b.y, t.x, t.y, (x, y) => shotBlocked(v.map, x, y));
      if (reacted && clear && dist < tactics.fire) keys |= Key.Primary;
      if (reacted && b.cdS === 0 && dist > tactics.bombMin && dist < tactics.bombMax && now > this.wantBomb) {
        this.wantBomb = now + 1500 + rand() * 4000;
        if (rand() < tactics.bomb) keys |= Key.Secondary;
      }
      keys |= this.special(cls, me, t, dist, v, tactics, (a) => (aim = a), (d) => (dist = d));
    } else if (t.kind === 'heart' && cls === 'archer' && b.cdX === 0 && dist > 300) {
      keys |= Key.Special;
    }
    return { keys, aim, dist };
  }

  private special(
    cls: ClassId, me: Player, t: Target, dist: number, v: World, tactics: Tactics,
    setAim: (a: number) => void, setDist: (d: number) => void,
  ) {
    const b = me.body;
    if (b.cdX > 0) return 0;
    if (cls === 'warrior') {
      let near = 0;
      for (const p of v.players.values()) if (p.alive && p.id !== this.id && Math.hypot(p.body.x - b.x, p.body.y - b.y) < 130) near++;
      for (const m of v.mobs) if (Math.hypot(m.x - b.x, m.y - b.y) < 130) near++;
      return near >= tactics.spinNear ? Key.Special : 0;
    }
    const lowHp = me.hp < CLASSES[cls].hp * 0.35;
    if (dist < tactics.escape || (lowHp && dist < tactics.escape * 2)) {
      // Escape: aim away from the threat (dash goes the way we walk, blink goes where we aim).
      const away = Math.atan2(b.y - t.y, b.x - t.x) + (this.rand() - 0.5) * 0.8;
      setAim(away);
      setDist(400);
      return Key.Special;
    }
    return 0;
  }

  /** Lead the target by its recent velocity so arrows and orbs arrive where it will be. */
  private predict(t: Target, b: { x: number; y: number }, cls: ClassId, lead: number) {
    const speed = PROJ_SPEED[cls];
    if ((t.kind !== 'player' && t.kind !== 'mob') || !Number.isFinite(speed)) return t;
    const key = t.kind === 'player' ? t.id : -t.id;
    const now = this.perceive(key, 0), before = this.perceive(key, 150);
    if (!now || !before) return t;
    const vx = (now.x - before.x) / 150, vy = (now.y - before.y) / 150;
    const time = Math.min(800, Math.hypot(t.x - b.x, t.y - b.y) / speed) * lead * (0.5 + this.skill * 0.6);
    return { x: t.x + vx * time, y: t.y + vy * time };
  }

  /** Where `key` appeared to be `ago` ms before our perception horizon. */
  private perceive(key: number, ago: number) {
    const h = this.seen.get(key);
    if (!h?.length) return null;
    const at = h[h.length - 1].t - this.delay - ago;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= at) {
        const a = h[i - 1], b = h[i], f = (at - a.t) / (b.t - a.t || 1);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return h[0];
  }

  private trackRange(now: number, inRange: boolean) {
    if (!inRange) this.inRangeSince = Infinity;
    else if (this.inRangeSince === Infinity) this.inRangeSince = now;
  }

  private noise(now: number) {
    if (now > this.aimErrorAt) {
      this.aimErrorAt = now + 250 + this.rand() * 300;
      this.aimError = (this.rand() - 0.5) * (0.05 + (1 - this.skill) * 0.4);
    }
    return this.aimError;
  }

  private trackPositions(v: World) {
    const record = (key: number, x: number, y: number) => {
      let h = this.seen.get(key);
      if (!h) this.seen.set(key, (h = []));
      h.push({ t: v.now, x, y });
      while (h.length > 2 && h[1].t < v.now - 600) h.shift();
    };
    for (const p of v.players.values()) if (p.alive && p.id !== this.id) record(p.id, p.body.x, p.body.y);
    for (const m of v.mobs) record(-m.id, m.x, m.y);
    if (this.seen.size > 80) for (const [k, h] of this.seen) if (h[h.length - 1].t < v.now - 2000) this.seen.delete(k);
  }

  private targetValid(v: World, me: Player) {
    const t = this.target;
    if (!t) return false;
    if (t.kind === 'player') {
      for (const p of v.players.values()) if (p.id === t.id && p.alive) return this.locate(t, p.id), true;
      return false;
    }
    if (t.kind === 'mob') {
      const m = v.mobs.find((q) => q.id === t.id);
      return !!m && (this.locate(t, -m.id), true);
    }
    if (t.kind === 'heart') return v.hearts.some((h) => h.x === t.x && h.y === t.y);
    if (t.kind === 'coin') return v.drops.some((c) => c.id === t.id);
    if (t.kind === 'shop') return botWish(me) !== null;
    return Math.hypot(t.x - this.lastPos.x, t.y - this.lastPos.y) > 120;
  }

  private locate(t: Target, key: number) {
    const p = this.perceive(key, 0);
    if (p) (t.x = p.x), (t.y = p.y);
  }

  private pickTarget(v: World, me: Player, tactics: Tactics) {
    const b = me.body, rand = this.rand;
    this.retargetAt = v.now + 700 + rand() * 600;
    const old = this.target;
    let best: Target | null = null, bestScore = Infinity;
    const consider = (t: Target, score: number) => {
      if (score < bestScore) (bestScore = score), (best = t);
    };
    const hurt = me.hp < CLASSES[me.cls].hp * tactics.heal;
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
      if (d < 800) consider({ kind: 'mob', id: m.id, x: m.x, y: m.y }, d + tactics.bogBias - (old?.kind === 'mob' && old.id === m.id ? 150 : 0));
    }
    for (const c of v.drops) {
      const d = Math.hypot(c.x - b.x, c.y - b.y);
      if (d < 600) consider({ kind: 'coin', id: c.id, x: c.x, y: c.y }, d + 100 - c.value * 30);
    }
    // With coins to spend and nobody close, go see the wizard.
    if (botWish(me)) {
      let threat = Infinity;
      for (const p of v.players.values()) if (p.alive && p.id !== this.id) threat = Math.min(threat, Math.hypot(p.body.x - b.x, p.body.y - b.y));
      if (threat > 450) consider({ kind: 'shop', id: 0, x: v.map.wizard.x, y: v.map.wizard.y + 80 }, -1000);
    }
    if (!best) {
      // Nothing nearby: head for the nearest fight, or wander the isle.
      let nearest: Target | null = null, nd = Infinity;
      for (const p of v.players.values()) {
        if (!p.alive || p.id === this.id) continue;
        const d = Math.hypot(p.body.x - b.x, p.body.y - b.y);
        if (d < nd) (nd = d), (nearest = { kind: 'spot', id: 0, x: p.body.x, y: p.body.y });
      }
      if (old?.kind === 'spot' && this.targetValid(v, me)) best = old;
      else if (nearest && rand() < 0.7) best = nearest;
      else {
        for (let i = 0; i < 50 && !best; i++) {
          const tx = Math.floor(rand() * v.map.w), ty = Math.floor(rand() * v.map.h);
          if (!walkBlocked(v.map, tx, ty)) best = { kind: 'spot', id: 0, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
        }
      }
    }
    this.target = best ?? { kind: 'spot', id: 0, x: v.map.wizard.x, y: v.map.wizard.y + TILE };
    if (this.target.kind === 'player') this.locate(this.target, this.target.id);
    else if (this.target.kind === 'mob') this.locate(this.target, -this.target.id);
    if (!old || old.kind !== this.target.kind || old.id !== this.target.id) this.acquiredAt = v.now;
  }

  /** Keys that move us toward `goal`, routing around trees and water. */
  private steer(m: GameMap, b: { x: number; y: number }, goal: { x: number; y: number }, now: number) {
    // Stuck against something for a while: shuffle sideways for a moment.
    if (Math.hypot(b.x - this.lastPos.x, b.y - this.lastPos.y) > 2) this.stuckSince = now;
    this.lastPos = { x: b.x, y: b.y };
    if (now < this.unstickUntil) return dirKeys(this.unstick.x, this.unstick.y);
    if (now - this.stuckSince > 400 && Math.hypot(goal.x - b.x, goal.y - b.y) > 40) {
      const a = this.rand() * Math.PI * 2;
      this.unstick = { x: Math.cos(a), y: Math.sin(a) };
      this.unstickUntil = now + 300;
      this.stuckSince = now;
      this.path = [];
    }
    // Check the whole body (plus a little slack), not just its center, so we don't clip tree corners.
    const walkable = (x: number, y: number) => boxBlocked(m, x - PLAYER_HW - 4, y - PLAYER_HH - 4, x + PLAYER_HW + 4, y + PLAYER_HH + 4);
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
