import { ARROW, CLASS_IDS, CLASSES, isClassId, ORB, type ClassId } from '../shared/classes';
import {
  CHAT_MAX, HURT, INTERMISSION_MS, INTERP_DELAY, Key, NAME_MAX, PLAYER_HH, PLAYER_HW, RESPAWN_MS, ROUND_MS, SCORE, SIM_DT,
  SPAWN_SHIELD_MS, TILE,
} from '../shared/constants';
import { isShallow, MAP, moveBox, randomSpot, shotBlocked, WADE_SPEED, type GameMap } from '../shared/map';
import {
  Ev, MF, PF, ProjKind, type BombSnap, type ClientMsg, type EventSnap, type HeartSnap, type KillHow, type MobSnap,
  type PlayerSnap, type ProjSnap, type RosterEntry, type RoundResult, type ServerMsg,
} from '../shared/protocol';
import { Act, newBody, packBody, stepPlayer, type Body, type Input } from '../shared/sim';
import { BOT_NAMES, BotBrain, TACTICS, type Tactics } from './bot';

export interface Player {
  id: number;
  name: string;
  cls: ClassId;
  body: Body;
  hp: number;
  alive: boolean;
  respawnAt: number;
  shieldUntil: number;
  hurtUntil: number;
  score: number;
  kills: number;
  deaths: number;
  bogs: number;
  ping: number;
  queue: Input[];
  /** Input steps this player may still apply; refilled in real time so clients can't speed up. */
  budget: number;
  ack: number;
  lastChat: number;
  /** Set for computer-controlled players. */
  bot: BotBrain | null;
  /** Simulation time a bot has not turned into inputs yet. */
  botAcc: number;
}

export interface Mob {
  id: number;
  x: number;
  y: number;
  kx: number;
  ky: number;
  hp: number;
  big: boolean;
  /** Wander heading and time left on it. */
  wx: number;
  wy: number;
  wt: number;
  atkCd: number;
  hurtUntil: number;
  moving: boolean;
  faceLeft: boolean;
}

export interface Proj {
  id: number;
  kind: ProjKind;
  owner: number;
  seq: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
}

export interface Bomb {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
}

export interface Heart {
  id: number;
  x: number;
  y: number;
}

interface WorldEvent {
  x: number;
  y: number;
  data: EventSnap;
}

export interface Outbox {
  send(id: number, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
}

const SWORD = { range: 118, arc: 1.15, dmg: 35, knock: 1.25 };
const SPIN = { range: 140, dmg: 28, knock: 1.5 };
const BOMB = { fuse: 1000, friction: 0.004, radius: 170, maxDmg: 64, minDmg: 14, maxRange: 540 };
const BOG = {
  small: { hp: 45, speed: 0.2, hw: 22, hh: 12, dmg: 10, knock: 0.9, hurt: { l: -26, r: 26, t: -112, b: 10 } },
  big: { hp: 120, speed: 0.15, hw: 34, hh: 16, dmg: 18, knock: 1.3, hurt: { l: -40, r: 40, t: -170, b: 14 } },
  sight: 620,
  attackCd: 900,
};
const HEAL = 25;
/** Rooms are topped up with bots until there are this many fighters. */
export const BOT_FILL = 6;
const BOT_TAUNTS = ['For the Khan!', 'Back to the sea with you.', 'gg', 'Too slow!', 'The isle is mine.', 'Hah!'];
/** Bots with a catchphrase say it after most kills instead of a random taunt. */
const BOT_CATCHPHRASES: Record<string, string> = { Jamukha: "That's what she said." };
/** Chest height above the feet, where projectiles start and blasts are measured to. */
const CHEST = 44;
/** Snapshots include entities this far (world px) from the receiving player. */
const VIEW_X = 980;
const VIEW_Y = 620;

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const r1 = (n: number) => Math.round(n * 10) / 10;
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** The authoritative game state of one room. Pure logic: the Durable Object owns sockets and timers. */
export class World {
  readonly players = new Map<number, Player>();
  mobs: Mob[] = [];
  projs: Proj[] = [];
  bombs: Bomb[] = [];
  hearts: Heart[] = [];
  events: WorldEvent[] = [];
  phase: 'play' | 'end' = 'play';
  phaseEndsAt: number;
  results: RoundResult[] = [];
  khan = 0;
  now: number;
  private nextId = 1;
  private lastTick: number;
  private mobTimer = 0;
  private heartTimer = 0;
  private rosterDirty = true;
  private rosterTimer = 0;
  private botTimer = 0;
  /** Recent positions of players and bogs, for judging human swings by what they saw. */
  private trail = new Map<number, { t: number; x: number; y: number }[]>();
  readonly map: GameMap = MAP;
  private rand: () => number;
  private botFill: number;
  private tactics: Record<ClassId, Tactics>;

  constructor(private out: Outbox, now: number, opts: { rand?: () => number; botFill?: number; tactics?: Record<ClassId, Tactics> } = {}) {
    this.now = this.lastTick = now;
    this.phaseEndsAt = now + ROUND_MS;
    this.rand = opts.rand ?? Math.random;
    this.botFill = opts.botFill ?? BOT_FILL;
    this.tactics = opts.tactics ?? TACTICS;
  }

  join(rawName: unknown, rawCls: unknown, bot = false): Player {
    let name = clean(rawName, NAME_MAX);
    if (!name) {
      const taken = new Set([...this.players.values()].map((p) => p.name));
      let n = 1;
      while (taken.has(`Guest ${n}`)) n++;
      name = `Guest ${n}`;
    }
    const cls = isClassId(rawCls) ? rawCls : 'archer';
    const p: Player = {
      id: this.nextId++, name, cls, body: newBody(0, 0), hp: 0, alive: false, respawnAt: 0, shieldUntil: 0,
      hurtUntil: 0, score: 0, kills: 0, deaths: 0, bogs: 0, ping: 0, queue: [], budget: 0, ack: 0, lastChat: 0,
      bot: null, botAcc: 0,
    };
    if (bot) p.bot = new BotBrain(p.id, this.rand);
    this.players.set(p.id, p);
    this.spawn(p);
    this.rosterDirty = true;
    this.out.broadcast({ t: 'chat', from: null, m: `${name} washed up on the isle.` });
    return p;
  }

  leave(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.projs = this.projs.filter((pr) => pr.owner !== id);
    this.rosterDirty = true;
    if (this.khan === id) this.khan = 0;
    this.out.broadcast({ t: 'chat', from: null, m: `${p.name} sailed away.` });
  }

  handle(id: number, msg: ClientMsg) {
    const p = this.players.get(id);
    if (!p) return;
    switch (msg.t) {
      case 'in':
        if (!Array.isArray(msg.i)) return;
        for (const i of msg.i.slice(0, 30)) {
          if (!Array.isArray(i) || i.length !== 4 || !i.every(Number.isFinite)) return;
          if (i[0] <= p.ack || (p.queue.length && i[0] <= p.queue[p.queue.length - 1].seq)) continue;
          p.queue.push({ seq: i[0], keys: i[1] & 127, aim: i[2], dist: Math.max(0, i[3]) });
        }
        // A client that stalls and then floods us shouldn't build up seconds of lag.
        if (p.queue.length > 30) p.queue.splice(0, p.queue.length - 30);
        return;
      case 'chat': {
        const m = clean(msg.m, CHAT_MAX);
        if (!m || this.now - p.lastChat < 600) return;
        p.lastChat = this.now;
        this.out.broadcast({ t: 'chat', from: p.name, m });
        return;
      }
      case 'respawn':
        if (p.alive || this.now < p.respawnAt || this.phase !== 'play') return;
        if (isClassId(msg.cls)) p.cls = msg.cls;
        this.spawn(p);
        this.rosterDirty = true;
        return;
      case 'ping':
        if (!Number.isFinite(msg.c)) return;
        if (Number.isFinite(msg.rtt)) p.ping = Math.max(0, Math.min(9999, Math.round(msg.rtt)));
        this.out.send(id, { t: 'pong', c: msg.c });
        return;
    }
  }

  tick(now: number) {
    const dt = Math.min(250, now - this.lastTick);
    this.lastTick = this.now = now;
    if (now >= this.phaseEndsAt) this.phase === 'play' ? this.endRound() : this.startRound();

    this.manageBots(dt);
    for (const p of this.players.values()) this.applyInputs(p, dt);
    if (this.phase === 'play') {
      this.tickProjectiles(dt);
      this.tickBombs(dt);
      this.tickMobs(dt);
      this.tickHearts(dt);
    }
    this.recordTrail();
    this.updateKhan();
    this.rosterTimer -= dt;
    if (this.rosterDirty || this.rosterTimer <= 0) {
      this.out.broadcast(this.rosterMsg());
      this.rosterDirty = false;
      this.rosterTimer = 2000;
    }
  }

  /** Snapshot of everything `id` can see; drains nothing, so call once per player per tick then `flushEvents`. */
  snapshot(id: number): ServerMsg | null {
    const me = this.players.get(id);
    if (!me) return null;
    const cx = me.body.x, cy = me.body.y;
    const near = (x: number, y: number) => Math.abs(x - cx) < VIEW_X && Math.abs(y - cy) < VIEW_Y;
    const p: PlayerSnap[] = [];
    for (const o of this.players.values()) {
      let f = 0;
      if (o.alive) f |= PF.Alive;
      if (this.now < o.shieldUntil) f |= PF.Shield;
      if (o.body.moving) f |= PF.Moving;
      if (o.body.dash > 0) f |= PF.Dash;
      if (this.khan === o.id) f |= PF.Khan;
      if (this.now < o.hurtUntil) f |= PF.Hurt;
      p.push([o.id, r1(o.body.x), r1(o.body.y), Math.round(o.body.aim * 100) / 100, Math.ceil(o.hp), f]);
    }
    const m: MobSnap[] = [];
    for (const b of this.mobs) {
      if (!near(b.x, b.y)) continue;
      const f = (b.big ? MF.Big : 0) | (this.now < b.hurtUntil ? MF.Hurt : 0) | (b.moving ? MF.Moving : 0) | (b.faceLeft ? MF.FaceLeft : 0);
      m.push([b.id, r1(b.x), r1(b.y), Math.ceil(b.hp), f]);
    }
    const pr: ProjSnap[] = this.projs
      .filter((q) => near(q.x, q.y))
      .map((q) => [q.id, q.kind, r1(q.x), r1(q.y), Math.round(q.vx * 1000) / 1000, Math.round(q.vy * 1000) / 1000, q.owner, q.seq]);
    const b: BombSnap[] = this.bombs.filter((q) => near(q.x, q.y)).map((q) => [q.id, r1(q.x), r1(q.y), Math.round((q.fuse / BOMB.fuse) * 100)]);
    const h: HeartSnap[] = this.hearts.filter((q) => near(q.x, q.y)).map((q) => [q.id, q.x, q.y]);
    const e = this.events.filter((ev) => near(ev.x, ev.y)).map((ev) => ev.data);
    return { t: 's', st: this.now, ack: me.ack, me: me.alive ? packBody(me.body) : null, p, m, pr, b, h, e };
  }

  flushEvents() {
    this.events = [];
  }

  // --- players -------------------------------------------------------------------------------

  private spawn(p: Player) {
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    const spot = randomSpot(this.map, this.rand, PLAYER_HW, PLAYER_HH, (x, y) =>
      others.some((o) => Math.hypot(o.body.x - x, o.body.y - y) < 600) ||
      this.mobs.some((b) => Math.hypot(b.x - x, b.y - y) < 350),
    );
    p.body = newBody(spot.x, spot.y);
    p.hp = CLASSES[p.cls].hp;
    p.alive = true;
    p.shieldUntil = this.now + SPAWN_SHIELD_MS;
    this.emit(spot.x, spot.y, [Ev.Spawn, spot.x, spot.y]);
  }

  private applyInputs(p: Player, dt: number) {
    // 3% headroom absorbs client clock drift without letting anyone meaningfully speed up.
    p.budget = Math.min(15, p.budget + (dt / SIM_DT) * 1.03);
    while (p.queue.length && p.budget >= 1) {
      const input = p.queue.shift()!;
      p.budget--;
      p.ack = input.seq;
      if (!p.alive) continue;
      const from = { x: p.body.x, y: p.body.y };
      const acts = stepPlayer(this.map, p.body, p.cls, input);
      if (acts) this.useAbilities(p, acts, input, from);
    }
  }

  private useAbilities(p: Player, acts: number, input: Input, from: { x: number; y: number }) {
    const b = p.body;
    const ax = Math.cos(input.aim), ay = Math.sin(input.aim);
    const cy = b.y - CHEST;
    if (acts & Act.Primary) {
      if (p.cls === 'warrior') {
        this.emit(b.x, b.y, [Ev.Swing, p.id, Math.round(input.aim * 100) / 100]);
        this.melee(p, SWORD.range, SWORD.arc, SWORD.dmg, SWORD.knock, 'sword');
      } else {
        const def = p.cls === 'archer' ? ARROW : ORB;
        const kind = p.cls === 'archer' ? ProjKind.Arrow : ProjKind.Orb;
        // Bows lose a little accuracy on the run.
        const a = input.aim + (p.cls === 'archer' && b.moving ? (this.rand() - 0.5) * 0.08 : 0);
        this.projs.push({
          id: this.nextId++, kind, owner: p.id, seq: input.seq, x: b.x + ax * 24, y: cy + ay * 24,
          vx: Math.cos(a) * def.speed, vy: Math.sin(a) * def.speed, ttl: def.ttl,
        });
        this.emit(b.x, b.y, [Ev.Shoot, p.id, kind]);
      }
    }
    if (acts & Act.Secondary) {
      // Pick the launch speed so the bomb comes to rest near the cursor when the fuse runs out.
      const travel = (1 - Math.exp(-BOMB.friction * BOMB.fuse)) / BOMB.friction;
      const v = Math.min(input.dist, BOMB.maxRange) / travel;
      this.bombs.push({ id: this.nextId++, owner: p.id, x: b.x + ax * 20, y: b.y + ay * 20, vx: ax * v, vy: ay * v, fuse: BOMB.fuse });
      this.emit(b.x, b.y, [Ev.Throw, p.id]);
    }
    if (acts & Act.Special) {
      const kind = CLASSES[p.cls].special.kind;
      if (kind === 'spin') {
        this.emit(b.x, b.y, [Ev.Spin, p.id]);
        this.melee(p, SPIN.range, Math.PI, SPIN.dmg, SPIN.knock, 'spin');
      } else if (kind === 'blink') {
        this.emit(b.x, b.y, [Ev.Blink, p.id, r1(from.x), r1(from.y), r1(b.x), r1(b.y)]);
      } else {
        this.emit(b.x, b.y, [Ev.Dash, p.id]);
      }
    }
  }

  private melee(p: Player, range: number, arc: number, dmg: number, knock: number, how: KillHow) {
    const x = p.body.x, y = p.body.y - CHEST, aim = p.body.aim;
    // People see everyone else INTERP_DELAY plus half their ping in the past, so judge their swings
    // against where targets were on their screen. Bots perceive with their own delay instead.
    const seenAt = this.now - (p.bot ? 0 : Math.min(250, INTERP_DELAY + p.ping / 2));
    const inArc = (tx: number, ty: number, radius: number) => {
      const d = Math.hypot(tx - x, ty - y);
      return d <= range + radius && (arc >= Math.PI || d < radius || angleDiff(Math.atan2(ty - y, tx - x), aim) <= arc);
    };
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const seen = this.positionAt(o.id, seenAt) ?? o.body;
      if (!inArc(seen.x, seen.y - CHEST, 26)) continue;
      const d = Math.hypot(o.body.x - x, o.body.y - CHEST - y) || 1;
      this.damagePlayer(o, dmg, p, (o.body.x - x) / d, (o.body.y - CHEST - y) / d, knock, how);
    }
    for (const b of [...this.mobs]) {
      const seen = this.positionAt(b.id, seenAt) ?? b;
      const lift = b.big ? 70 : 48;
      if (!inArc(seen.x, seen.y - lift, b.big ? 40 : 28)) continue;
      const d = Math.hypot(b.x - x, b.y - lift - y) || 1;
      this.damageMob(b, dmg, p, (b.x - x) / d, (b.y - lift - y) / d, knock);
    }
  }

  /** Where entity `id` stood at time `at`, from the last few hundred ms of history. */
  private positionAt(id: number, at: number) {
    const h = this.trail.get(id);
    if (!h?.length || at >= this.now) return null;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= at) {
        const a = h[i - 1], b = h[i], f = Math.min(1, (at - a.t) / (b.t - a.t || 1));
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return h[0];
  }

  private recordTrail() {
    const keep = (id: number, x: number, y: number) => {
      let h = this.trail.get(id);
      if (!h) this.trail.set(id, (h = []));
      h.push({ t: this.now, x, y });
      while (h.length > 2 && h[1].t < this.now - 300) h.shift();
    };
    const live = new Set<number>();
    for (const p of this.players.values()) if (p.alive) (keep(p.id, p.body.x, p.body.y), live.add(p.id));
    for (const b of this.mobs) (keep(b.id, b.x, b.y), live.add(b.id));
    for (const id of this.trail.keys()) if (!live.has(id)) this.trail.delete(id);
  }

  private damagePlayer(t: Player, amount: number, by: Player | null, dx: number, dy: number, knock: number, how: KillHow) {
    if (!t.alive || this.now < t.shieldUntil || this.phase !== 'play') return;
    if (by === t) amount = Math.round(amount * 0.5);
    t.hp -= amount;
    t.hurtUntil = this.now + 140;
    t.body.kx += dx * knock;
    t.body.ky += dy * knock;
    this.emit(t.body.x, t.body.y, [Ev.Hit, r1(t.body.x), r1(t.body.y - 90), amount, 0, t.id]);
    if (t.hp > 0) return;
    t.alive = false;
    t.hp = 0;
    t.deaths++;
    t.respawnAt = this.now + RESPAWN_MS;
    t.queue.length = 0;
    this.emit(t.body.x, t.body.y, [Ev.Die, r1(t.body.x), r1(t.body.y), 0, 0]);
    this.hearts.push({ id: this.nextId++, x: Math.round(t.body.x), y: Math.round(t.body.y) });
    const wasKhan = this.khan === t.id;
    if (by && by !== t) {
      by.kills++;
      by.score += SCORE.kill + (wasKhan ? SCORE.khanBonus : 0);
    } else if (by === t) {
      t.score = Math.max(0, t.score + SCORE.suicide);
    }
    const killer = how === 'bog' ? 'a Bog' : by && by !== t ? by.name : null;
    this.out.broadcast({ t: 'kill', k: killer, v: t.name, kid: by?.id ?? 0, vid: t.id, how });
    if (by?.bot && by !== t) {
      const catchphrase = BOT_CATCHPHRASES[by.name];
      if (catchphrase && this.rand() < 0.7) this.out.broadcast({ t: 'chat', from: by.name, m: catchphrase });
      else if (this.rand() < (wasKhan ? 0.6 : 0.12)) this.out.broadcast({ t: 'chat', from: by.name, m: BOT_TAUNTS[Math.floor(this.rand() * BOT_TAUNTS.length)] });
    }
    this.out.send(t.id, { t: 'dead', by: killer, respawnIn: RESPAWN_MS });
    this.rosterDirty = true;
  }

  private damageMob(b: Mob, amount: number, by: Player | null, dx: number, dy: number, knock: number) {
    if (!this.mobs.includes(b) || this.phase !== 'play') return;
    b.hp -= amount;
    b.hurtUntil = this.now + 140;
    const weight = b.big ? 0.55 : 1;
    b.kx += dx * knock * weight;
    b.ky += dy * knock * weight;
    this.emit(b.x, b.y, [Ev.Hit, r1(b.x), r1(b.y - (b.big ? 180 : 120)), amount, 1, b.id]);
    if (b.hp > 0) return;
    this.mobs.splice(this.mobs.indexOf(b), 1);
    this.emit(b.x, b.y, [Ev.Die, r1(b.x), r1(b.y), 1, b.big ? 1 : 0]);
    if (this.rand() < 0.35) this.hearts.push({ id: this.nextId++, x: Math.round(b.x), y: Math.round(b.y) });
    if (by) {
      by.bogs++;
      by.score += b.big ? SCORE.bigBog : SCORE.bog;
      this.rosterDirty = true;
    }
  }

  // --- projectiles & bombs -------------------------------------------------------------------

  private tickProjectiles(dt: number) {
    const keep: Proj[] = [];
    for (const q of this.projs) {
      const owner = this.players.get(q.owner) ?? null;
      const def = q.kind === ProjKind.Arrow ? ARROW : ORB;
      q.ttl -= dt;
      let alive = q.ttl > 0;
      const dist = Math.hypot(q.vx, q.vy) * dt;
      const n = Math.max(1, Math.ceil(dist / 12));
      for (let i = 0; i < n && alive; i++) {
        q.x += (q.vx * dt) / n;
        q.y += (q.vy * dt) / n;
        const speed = Math.hypot(q.vx, q.vy);
        const dx = q.vx / speed, dy = q.vy / speed;
        if (shotBlocked(this.map, q.x, q.y + CHEST)) {
          alive = false;
          this.emit(q.x, q.y, [Ev.Thud, r1(q.x), r1(q.y)]);
          if (q.kind === ProjKind.Orb) this.orbBurst(q, owner, null);
          break;
        }
        for (const o of this.players.values()) {
          if (o.id === q.owner || !o.alive) continue;
          const rx = q.x - o.body.x, ry = q.y - o.body.y;
          if (rx < HURT.left || rx > HURT.right || ry < HURT.top || ry > HURT.bottom) continue;
          alive = false;
          this.damagePlayer(o, def.dmg, owner, dx, dy, def.knock, q.kind === ProjKind.Arrow ? 'arrow' : 'orb');
          if (q.kind === ProjKind.Orb) this.orbBurst(q, owner, o);
          break;
        }
        if (!alive) break;
        for (const b of this.mobs) {
          const box = b.big ? BOG.big.hurt : BOG.small.hurt;
          const rx = q.x - b.x, ry = q.y - b.y;
          if (rx < box.l || rx > box.r || ry < box.t || ry > box.b) continue;
          alive = false;
          this.damageMob(b, def.dmg, owner, dx, dy, def.knock);
          if (q.kind === ProjKind.Orb) this.orbBurst(q, owner, b);
          break;
        }
      }
      if (alive && q.x > -TILE && q.y > -TILE && q.x < this.map.w * TILE + TILE && q.y < this.map.h * TILE + TILE) keep.push(q);
    }
    this.projs = keep;
  }

  private orbBurst(q: Proj, owner: Player | null, direct: unknown) {
    this.emit(q.x, q.y, [Ev.Burst, r1(q.x), r1(q.y)]);
    for (const o of this.players.values()) {
      if (o === direct || o.id === q.owner || !o.alive) continue;
      const d = Math.hypot(o.body.x - q.x, o.body.y - CHEST - q.y);
      if (d < ORB.splash) this.damagePlayer(o, ORB.splashDmg, owner, (o.body.x - q.x) / (d || 1), (o.body.y - CHEST - q.y) / (d || 1), 0.5, 'orb');
    }
    for (const b of [...this.mobs]) {
      if (b === direct) continue;
      const my = b.y - (b.big ? 70 : 48);
      const d = Math.hypot(b.x - q.x, my - q.y);
      if (d < ORB.splash + (b.big ? 20 : 0)) this.damageMob(b, ORB.splashDmg, owner, (b.x - q.x) / (d || 1), (my - q.y) / (d || 1), 0.5);
    }
  }

  private tickBombs(dt: number) {
    const keep: Bomb[] = [];
    const decay = Math.exp(-BOMB.friction * dt);
    for (const q of this.bombs) {
      q.fuse -= dt;
      const hit = moveBox(this.map, q, 8, 8, q.vx * dt, q.vy * dt);
      if (hit.hitX) q.vx = -q.vx * 0.6;
      if (hit.hitY) q.vy = -q.vy * 0.6;
      q.vx *= decay;
      q.vy *= decay;
      if (q.fuse > 0) keep.push(q);
      else this.explode(q);
    }
    this.bombs = keep;
  }

  private explode(q: Bomb) {
    const owner = this.players.get(q.owner) ?? null;
    this.emit(q.x, q.y, [Ev.Boom, r1(q.x), r1(q.y)]);
    const hit = (tx: number, ty: number) => {
      const d = Math.hypot(tx - q.x, ty - q.y);
      if (d >= BOMB.radius) return null;
      const f = 1 - d / BOMB.radius;
      return { dmg: Math.round(BOMB.minDmg + (BOMB.maxDmg - BOMB.minDmg) * f), knock: 0.4 + 1.4 * f, dx: (tx - q.x) / (d || 1), dy: (ty - q.y) / (d || 1) };
    };
    for (const o of this.players.values()) {
      if (!o.alive) continue;
      const h = hit(o.body.x, o.body.y - 20);
      if (h) this.damagePlayer(o, h.dmg, owner, h.dx, h.dy, h.knock, 'bomb');
    }
    for (const b of [...this.mobs]) {
      const h = hit(b.x, b.y - 20);
      if (h) this.damageMob(b, h.dmg, owner, h.dx, h.dy, h.knock);
    }
  }

  // --- bogs ----------------------------------------------------------------------------------

  private tickMobs(dt: number) {
    const alive = [...this.players.values()].filter((p) => p.alive);
    const target = Math.min(22, 5 + 2 * alive.length);
    this.mobTimer -= dt;
    if (this.mobs.length < target && this.mobTimer <= 0) {
      this.mobTimer = 1200;
      this.spawnMob(alive);
    }
    const decay = Math.pow(0.86, dt / SIM_DT);
    for (const b of this.mobs) {
      const def = b.big ? BOG.big : BOG.small;
      let prey: Player | null = null, best = BOG.sight, nearest: Player | null = null, nearestD = Infinity;
      for (const p of alive) {
        const d = Math.hypot(p.body.x - b.x, p.body.y - b.y);
        if (d < best) (best = d), (prey = p);
        if (d < nearestD) (nearestD = d), (nearest = p);
      }
      let vx = 0, vy = 0;
      b.wt -= dt;
      if (prey && b.wt <= 0) {
        const dx = prey.body.x - b.x, dy = prey.body.y - b.y, d = Math.hypot(dx, dy) || 1;
        if (d > def.hw + PLAYER_HW) (vx = (dx / d) * def.speed), (vy = (dy / d) * def.speed);
      } else {
        if (b.wt <= 0) {
          // Out of sight, bogs drift toward the closest player more often than not.
          const toward = nearest && this.rand() < 0.6 ? Math.atan2(nearest.body.y - b.y, nearest.body.x - b.x) : null;
          const a = toward ?? this.rand() * Math.PI * 2, idle = toward === null && this.rand() < 0.35;
          b.wx = idle ? 0 : Math.cos(a);
          b.wy = idle ? 0 : Math.sin(a);
          b.wt = 1200 + this.rand() * 1800;
        }
        vx = b.wx * def.speed * 0.45;
        vy = b.wy * def.speed * 0.45;
      }
      // Keep bogs from stacking on one spot.
      for (const o of this.mobs) {
        if (o === b) continue;
        const dx = b.x - o.x, dy = b.y - o.y, d = Math.hypot(dx, dy);
        if (d > 0 && d < 56) (vx += (dx / d) * 0.08), (vy += (dy / d) * 0.08);
      }
      if (isShallow(this.map, b.x, b.y)) (vx *= WADE_SPEED), (vy *= WADE_SPEED);
      const hit = moveBox(this.map, b, def.hw, def.hh, (vx + b.kx) * dt, (vy + b.ky) * dt);
      if (prey && (hit.hitX || hit.hitY) && b.wt <= 0) {
        // Stuck on a tree or shoreline: wander sideways for a moment to get around it.
        const a = Math.atan2(vy, vx) + (this.rand() < 0.5 ? 1 : -1) * Math.PI / 2;
        (b.wx = Math.cos(a)), (b.wy = Math.sin(a)), (b.wt = 450);
      }
      b.kx *= decay;
      b.ky *= decay;
      b.moving = Math.abs(vx) + Math.abs(vy) > 0.02;
      if (Math.abs(vx) > 0.02) b.faceLeft = vx < 0;
      b.atkCd -= dt;
      if (prey && b.atkCd <= 0 && Math.abs(prey.body.x - b.x) < def.hw + PLAYER_HW + 12 && Math.abs(prey.body.y - b.y) < def.hh + PLAYER_HH + 18) {
        b.atkCd = BOG.attackCd;
        const dx = prey.body.x - b.x, dy = prey.body.y - b.y, d = Math.hypot(dx, dy) || 1;
        this.damagePlayer(prey, def.dmg, null, dx / d, dy / d, def.knock, 'bog');
      }
    }
  }

  private spawnMob(players: Player[]) {
    const big = this.rand() < 0.18;
    const def = big ? BOG.big : BOG.small;
    // Just out of sight of everyone, but close enough to someone that they'll meet soon.
    const spot = randomSpot(this.map, this.rand, def.hw, def.hh, (x, y) => {
      const d = players.map((p) => Math.hypot(p.body.x - x, p.body.y - y));
      return d.some((v) => v < 800) || (d.length > 0 && !d.some((v) => v < 1400));
    });
    this.mobs.push({
      id: this.nextId++, x: spot.x, y: spot.y, kx: 0, ky: 0, hp: def.hp, big, wx: 0, wy: 0, wt: 0, atkCd: 0,
      hurtUntil: 0, moving: false, faceLeft: false,
    });
  }

  private tickHearts(dt: number) {
    this.heartTimer -= dt;
    if (this.heartTimer <= 0 && this.hearts.length < 8 + this.players.size) {
      this.heartTimer = 2500;
      const s = randomSpot(this.map, this.rand, 16, 16);
      this.hearts.push({ id: this.nextId++, x: s.x, y: s.y });
    }
    for (const p of this.players.values()) {
      const max = CLASSES[p.cls].hp;
      if (!p.alive || p.hp >= max) continue;
      const i = this.hearts.findIndex((h) => Math.abs(h.x - p.body.x) < 36 && Math.abs(h.y - p.body.y) < 36);
      if (i < 0) continue;
      const [h] = this.hearts.splice(i, 1);
      p.hp = Math.min(max, p.hp + HEAL);
      this.emit(h.x, h.y, [Ev.Pickup, h.x, h.y, p.id]);
    }
  }

  // --- rounds & the Khan ---------------------------------------------------------------------

  private updateKhan() {
    let best: Player | null = this.players.get(this.khan) ?? null;
    for (const p of this.players.values()) if (p.score > (best?.score ?? 0)) best = p;
    const id = best && best.score > 0 ? best.id : 0;
    if (id === this.khan) return;
    this.khan = id;
    this.rosterDirty = true;
    if (best && id) this.out.broadcast({ t: 'khan', id, name: best.name });
  }

  private endRound() {
    this.phase = 'end';
    this.phaseEndsAt = this.now + INTERMISSION_MS;
    this.results = [...this.players.values()]
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .map((p) => ({ name: p.name, cls: p.cls, score: p.score, kills: p.kills, deaths: p.deaths, bogs: p.bogs }));
    this.projs = [];
    this.bombs = [];
    this.out.broadcast(this.roundMsg());
  }

  private startRound() {
    this.phase = 'play';
    this.phaseEndsAt = this.now + ROUND_MS;
    this.results = [];
    this.mobs = [];
    this.hearts = [];
    this.khan = 0;
    for (const p of this.players.values()) {
      p.score = p.kills = p.deaths = p.bogs = 0;
      this.spawn(p);
    }
    this.rosterDirty = true;
    this.out.broadcast(this.roundMsg());
  }

  roundMsg(): ServerMsg {
    return { t: 'round', phase: this.phase, endsIn: this.phaseEndsAt - this.now, results: this.results };
  }

  // --- bots ----------------------------------------------------------------------------------

  /** Keeps the room topped up with bots while humans are here, and lets bots act and respawn. */
  private manageBots(dt: number) {
    const all = [...this.players.values()];
    const humans = all.filter((p) => !p.bot).length;
    const bots = all.filter((p) => p.bot);
    const want = humans > 0 ? Math.max(0, this.botFill - humans) : 0;
    this.botTimer -= dt;
    if (bots.length > want) {
      // Make room for people: the weakest bot leaves first.
      const leaving = bots.sort((a, b) => Number(a.alive) - Number(b.alive) || a.score - b.score)[0];
      this.leave(leaving.id);
    } else if (bots.length < want && this.botTimer <= 0) {
      this.botTimer = 1500;
      const taken = new Set(all.map((p) => p.name));
      const free = BOT_NAMES.filter((n) => !taken.has(n));
      const name = free[Math.floor(this.rand() * free.length)] ?? `Bot ${bots.length + 1}`;
      this.join(name, this.botClass(), true);
    }
    for (const p of this.players.values()) {
      const bot = p.bot;
      if (!bot) continue;
      if (!p.alive) {
        p.botAcc = 0;
        if (!bot.respawnDelay) bot.respawnDelay = 400 + this.rand() * 2000;
        if (this.phase === 'play' && this.now >= p.respawnAt + bot.respawnDelay) {
          bot.respawnDelay = 0;
          if (this.rand() < 0.3) p.cls = this.botClass(p);
          this.spawn(p);
          this.rosterDirty = true;
        }
        continue;
      }
      const intent = bot.think(this, p, this.tactics[p.cls]);
      p.botAcc += dt;
      let first = true;
      while (p.botAcc >= SIM_DT) {
        p.botAcc -= SIM_DT;
        // One-shot actions go in the first step only; held attacks repeat.
        const keys = first ? intent.keys : intent.keys & ~(Key.Special | Key.Secondary);
        first = false;
        p.queue.push({ seq: p.ack + p.queue.length + 1, keys, aim: intent.aim, dist: intent.dist });
      }
    }
  }

  /** The class fewest bots are playing, so bot lineups stay varied. */
  private botClass(except?: Player): ClassId {
    const count = Object.fromEntries(CLASS_IDS.map((c) => [c, 0])) as Record<ClassId, number>;
    for (const p of this.players.values()) if (p.bot && p !== except) count[p.cls]++;
    const fewest = Math.min(...CLASS_IDS.map((c) => count[c]));
    const options = CLASS_IDS.filter((c) => count[c] === fewest);
    return options[Math.floor(this.rand() * options.length)];
  }

  private rosterMsg(): ServerMsg {
    const r: RosterEntry[] = [...this.players.values()].map((p) => [p.id, p.name, p.cls, p.score, p.kills, p.deaths, p.bogs, p.ping, p.bot ? 1 : 0]);
    return { t: 'roster', r, khan: this.khan };
  }

  private emit(x: number, y: number, data: EventSnap) {
    this.events.push({ x, y, data });
  }
}
