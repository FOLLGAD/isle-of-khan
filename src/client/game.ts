import { ARROW, CLASSES, ORB, type ClassId } from '../shared/classes';
import { HURT, INTERP_DELAY, SIM_DT } from '../shared/constants';
import { MAP, shotBlocked } from '../shared/map';
import {
  Ev, MF, PF, ProjKind, type BombSnap, type CoinSnap, type EventSnap, type HeartSnap, type MobSnap, type PlayerSnap,
  type ProjSnap, type RosterEntry, type ServerMsg,
} from '../shared/protocol';
import { ITEMS, MOB_HP, noUpgrades, SHOP_RANGE, type ItemId, type MobKind } from '../shared/shop';
import { Act, newBody, stepPlayer, unpackBody, type Input } from '../shared/sim';
import { img } from './assets';
import { audio, type Sfx } from './audio';
import { Effects } from './fx';
import type { Hud } from './hud';
import { isTouch, type Controls } from './input';
import type { Connection } from './net';
import { playerFrame, type DrawMob, type DrawPlayer, type Renderer, type Scene } from './renderer';

const CHEST = 44;
const WIZARD_LINES = [
  'Welcome to the Isle of Khan, traveler.',
  'Whoever has the most glory wears the crown. Topple the Khan for bonus glory!',
  'Hold the left mouse button to attack. Right-click lobs a bomb toward the cursor.',
  'SPACE unleashes your class power. Dash, Whirlwind or Blink!',
  'Hearts mend wounds. Bogs sometimes drop them when they pop.',
  'Mind your own bombs. The isle has no mercy for the careless.',
  'Hold TAB to see who rules the isle.',
  'Bring me coins and I will make you stronger. Stand close and press 1 to 4.',
  'Beware Samuel. He steals coins, then runs. Catch him and the coins are yours.',
  'Fall in battle and half your purse spills on the ground.',
];
const LOCAL_PROJ = { [ProjKind.Arrow]: ARROW, [ProjKind.Orb]: ORB };

interface Snap {
  st: number;
  players: Map<number, PlayerSnap>;
  mobs: Map<number, MobSnap>;
  projs: Map<number, ProjSnap>;
  bombs: Map<number, BombSnap>;
  hearts: HeartSnap[];
  coins: CoinSnap[];
}

interface LocalProj {
  seq: number;
  kind: ProjKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  /** Whether the server's copy has shown up; once it disappears again so does ours. */
  seen: boolean;
}

interface Anim {
  swingAt: number;
  swingAim: number;
  spinAt: number;
  castAt: number;
  walkT: number;
  ghostAt: number;
}

export interface RosterInfo {
  id: number;
  name: string;
  cls: ClassId;
  score: number;
  kills: number;
  deaths: number;
  bogs: number;
  ping: number;
  bot: boolean;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpAngle = (a: number, b: number, f: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

/** Runs one connected session: prediction, interpolation, effects, and feeding the renderer and HUD. */
export class Game {
  readonly fx = new Effects();
  cls: ClassId;
  alive = false;
  body = newBody(0, 0);
  /** Body position before the latest simulation step, for smooth rendering between steps. */
  private prev = { x: 0, y: 0 };
  /** Visual offset left over from a server correction; decays to zero. */
  private corr = { x: 0, y: 0 };
  private acc = 0;
  private seq = 0;
  private pending: Input[] = [];
  private outbox: [number, number, number, number][] = [];
  private lastSend = 0;
  private snaps: Snap[] = [];
  private timeOffset: number | null = null;
  private events: { at: number; e: EventSnap }[] = [];
  private localProjs: LocalProj[] = [];
  private anims = new Map<number, Anim>();
  roster = new Map<number, RosterInfo>();
  khan = 0;
  myHp = 0;
  myMaxHp = 0;
  /** Samuel's position while he's loose, for the minimap. */
  sam: [number, number] | null = null;
  myFlags = 0;
  coins = 0;
  up = noUpgrades();
  /** Last known position of the local player, used as the camera focus while dead. */
  lastPos = { x: MAP.wizard.x, y: MAP.wizard.y };
  private lastFrame = performance.now();
  private raf = 0;
  private lastAim = 0;
  private lastDist = 0;
  chatOpen = false;

  constructor(
    readonly myId: number,
    cls: ClassId,
    readonly room: string,
    readonly isPrivate: boolean,
    private conn: Connection,
    private renderer: Renderer,
    private controls: Controls,
    private hud: Hud,
  ) {
    this.cls = cls;
    conn.listen((m) => this.onMessage(m));
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  get rtt() {
    return this.conn.rtt;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.conn.close();
  }

  respawn(cls: ClassId) {
    this.conn.send({ t: 'respawn', cls });
  }

  chat(m: string) {
    this.conn.send({ t: 'chat', m });
  }

  buy(item: ItemId) {
    this.conn.send({ t: 'buy', item });
  }

  /** Close enough to the wizard to trade. */
  get atShop() {
    return this.alive && Math.hypot(this.body.x - MAP.wizard.x, this.body.y - MAP.wizard.y) <= SHOP_RANGE;
  }

  /** Server clock estimate. */
  private serverNow(now: number) {
    return now + (this.timeOffset ?? 0);
  }

  // --- messages ------------------------------------------------------------------------------

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 's':
        return this.onSnapshot(msg);
      case 'roster':
        return this.onRoster(msg.r, msg.khan);
      case 'chat':
        return this.hud.chat(msg.from, msg.m);
      case 'kill': {
        const mine = msg.kid === this.myId || msg.vid === this.myId;
        this.hud.kill(msg.k, msg.v, msg.how, mine, msg.kid === this.myId);
        return;
      }
      case 'dead':
        this.alive = false;
        this.hud.showDeath(msg.by, performance.now() + msg.respawnIn, this.cls);
        return;
      case 'khan':
        this.hud.big(`<img src="/assets/sprites/crown.png" class="px-icon"> <b class="gold">${escapeHtml(msg.name)}</b> is the Khan!`);
        audio.play('crown', msg.id === this.myId ? 0.9 : 0.5);
        return;
      case 'purse':
        this.coins = msg.coins;
        this.up = msg.up;
        return;
      case 'announce':
        this.hud.big(escapeHtml(msg.m));
        audio.play('steal', 0.5);
        return;
      case 'round':
        this.hud.round(msg.phase, performance.now() + msg.endsIn, msg.results, this.myId);
        if (msg.phase === 'end') audio.play('crown', 0.8);
        return;
    }
  }

  private onRoster(r: RosterEntry[], khan: number) {
    this.roster = new Map(r.map(([id, name, cls, score, kills, deaths, bogs, ping, bot]) => [id, { id, name, cls, score, kills, deaths, bogs, ping, bot: !!bot }]));
    this.khan = khan;
    const me = this.roster.get(this.myId);
    if (me) this.cls = me.cls;
    this.hud.roster([...this.roster.values()], khan, this.myId);
  }

  private onSnapshot(s: Extract<ServerMsg, { t: 's' }>) {
    const now = performance.now();
    const sample = s.st - now;
    // Track the server clock; jump forward quickly (late packets make us look behind) but drift back slowly.
    if (this.timeOffset === null || sample > this.timeOffset + 250 || sample < this.timeOffset - 250) this.timeOffset = sample;
    else this.timeOffset += (sample - this.timeOffset) * (sample > this.timeOffset ? 0.2 : 0.02);

    const snap: Snap = {
      st: s.st,
      players: new Map(s.p.map((p) => [p[0], p])),
      mobs: new Map(s.m.map((m) => [m[0], m])),
      projs: new Map(s.pr.map((p) => [p[0], p])),
      bombs: new Map(s.b.map((b) => [b[0], b])),
      hearts: s.h,
      coins: s.c,
    };
    this.snaps.push(snap);
    this.sam = s.sam;
    while (this.snaps.length > 2 && this.snaps[1].st < s.st - 1000) this.snaps.shift();
    for (const e of s.e) this.events.push({ at: s.st, e });

    const mine = snap.players.get(this.myId);
    if (mine) {
      this.myHp = mine[4];
      this.myFlags = mine[5];
      this.myMaxHp = mine[6];
      if (!(mine[5] & PF.Alive)) this.lastPos = { x: mine[1], y: mine[2] };
    }

    const ownSeqs = new Set(s.pr.filter((p) => p[6] === this.myId).map((p) => p[7]));
    this.localProjs = this.localProjs.filter((lp) => {
      if (ownSeqs.has(lp.seq)) lp.seen = true;
      else if (lp.seen) return false;
      return true;
    });

    this.reconcile(s.me, s.ack);
  }

  private reconcile(me: number[] | null, ack: number) {
    this.pending = this.pending.filter((i) => i.seq > ack);
    if (!me) {
      if (this.alive) this.alive = false;
      return;
    }
    const before = { x: this.body.x, y: this.body.y };
    unpackBody(this.body, me);
    for (const input of this.pending) stepPlayer(MAP, this.body, this.cls, input);
    if (!this.alive) {
      // Fresh spawn: jump straight there.
      this.alive = true;
      this.acc = 0;
      this.prev = { x: this.body.x, y: this.body.y };
      this.corr = { x: 0, y: 0 };
      this.hud.hideDeath();
      return;
    }
    const ex = before.x - this.body.x, ey = before.y - this.body.y;
    if (Math.hypot(ex, ey) > 160) this.corr = { x: 0, y: 0 };
    else (this.corr.x += ex), (this.corr.y += ey);
    this.prev.x -= ex;
    this.prev.y -= ey;
  }

  // --- frame ---------------------------------------------------------------------------------

  private frame(now: number) {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.simulate(dt);
    if (this.outbox.length >= 2 || (this.outbox.length && now - this.lastSend > 40)) {
      this.conn.send({ t: 'in', i: this.outbox });
      this.outbox = [];
      this.lastSend = now;
    }
    const rt = this.serverNow(now) - INTERP_DELAY;
    const scene = this.buildScene(rt, now, dt);
    while (this.events.length && this.events[0].at <= rt + 1) this.playEvent(this.events.shift()!.e, now, scene);
    this.updateLocalProjectiles(dt, scene);
    this.fx.update(dt);
    this.renderer.draw(scene, this.fx);
    this.hud.frame(this, now);
  }

  private simulate(dt: number) {
    if (!this.alive) {
      this.acc = 0;
      return;
    }
    this.acc += dt;
    while (this.acc >= SIM_DT) {
      this.acc -= SIM_DT;
      this.prev = { x: this.body.x, y: this.body.y };
      const input = this.sampleInput();
      const acts = stepPlayer(MAP, this.body, this.cls, input);
      this.pending.push(input);
      this.outbox.push([input.seq, input.keys, Math.round(input.aim * 1000) / 1000, Math.round(input.dist)]);
      if (acts) this.localActs(acts, input);
    }
    this.corr.x *= Math.pow(0.85, dt / SIM_DT);
    this.corr.y *= Math.pow(0.85, dt / SIM_DT);
    if (this.pending.length > 240) this.pending.splice(0, this.pending.length - 240);
  }

  private sampleInput(): Input {
    const c = this.controls;
    if (c.touchAim) {
      this.lastAim = Math.atan2(c.touchAim.y, c.touchAim.x);
      this.lastDist = 140 + 320 * Math.min(1, Math.hypot(c.touchAim.x, c.touchAim.y));
    } else if (!isTouch) {
      const w = this.renderer.screenToWorld(c.mouseX, c.mouseY);
      this.lastAim = Math.atan2(w.y - (this.body.y - CHEST), w.x - this.body.x);
      this.lastDist = Math.hypot(w.x - this.body.x, w.y - this.body.y);
    }
    return { seq: ++this.seq, keys: this.chatOpen ? 0 : c.sample(), aim: this.lastAim, dist: this.lastDist };
  }

  /** Immediate feedback for our own actions; the server's events for them are skipped. */
  private localActs(acts: number, input: Input) {
    const now = performance.now();
    const a = this.anim(this.myId);
    const ax = Math.cos(input.aim), ay = Math.sin(input.aim);
    if (acts & Act.Primary) {
      if (this.cls === 'warrior') {
        a.swingAt = now;
        a.swingAim = input.aim;
        audio.play('sword', 0.8);
      } else {
        a.castAt = now;
        const kind = this.cls === 'archer' ? ProjKind.Arrow : ProjKind.Orb;
        const def = LOCAL_PROJ[kind];
        this.localProjs.push({
          seq: input.seq, kind, x: this.body.x + ax * 24, y: this.body.y - CHEST + ay * 24, vx: ax * def.speed, vy: ay * def.speed,
          ttl: def.ttl, seen: false,
        });
        audio.play(kind === ProjKind.Arrow ? 'bow' : 'orb', 0.7);
      }
    }
    if (acts & Act.Secondary) audio.play('throw', 0.8);
    if (acts & Act.Special) {
      const kind = CLASSES[this.cls].special.kind;
      if (kind === 'spin') {
        a.spinAt = now;
        audio.play('swoosh', 0.9);
      } else if (kind === 'dash') audio.play('swoosh', 0.8);
      else {
        this.fx.sparkle(this.prev.x, this.prev.y, ['#c08cff', '#8ce6ff', '#fff'], 16);
        this.fx.sparkle(this.body.x, this.body.y, ['#c08cff', '#8ce6ff', '#fff'], 16);
        this.prev = { x: this.body.x, y: this.body.y };
        audio.play('blink', 0.8);
      }
    }
  }

  private anim(id: number) {
    let a = this.anims.get(id);
    if (!a) this.anims.set(id, (a = { swingAt: -1e9, swingAim: 0, spinAt: -1e9, castAt: -1e9, walkT: 0, ghostAt: 0 }));
    return a;
  }

  private bracket(rt: number): [Snap, Snap, number] | null {
    const s = this.snaps;
    if (!s.length) return null;
    if (rt <= s[0].st) return [s[0], s[0], 0];
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].st <= rt) {
        if (rt >= s[i].st) return [s[i], s[i], 0];
        return [s[i - 1], s[i], (rt - s[i - 1].st) / (s[i].st - s[i - 1].st)];
      }
    }
    return [s[0], s[0], 0];
  }

  private buildScene(rt: number, now: number, dt: number): Scene {
    const scene: Scene = { focus: this.lastPos, time: now, players: [], mobs: [], projs: [], bombs: [], hearts: [], coins: [], me: null, wizardLine: null };
    const br = this.bracket(rt);
    const latest = this.snaps[this.snaps.length - 1];
    const progress = (at: number, ms: number) => (now - at < ms ? (now - at) / ms : null);

    if (br) {
      const [a, b, f] = br;
      for (const pb of b.players.values()) {
        const id = pb[0];
        if (id === this.myId || !(pb[5] & PF.Alive)) continue;
        const pa = a.players.get(id);
        const fa = pa && pa[5] & PF.Alive ? pa : pb;
        const info = this.roster.get(id);
        const anim = this.anim(id);
        anim.walkT = pb[5] & PF.Moving ? anim.walkT + dt : 0;
        const cls = info?.cls ?? 'archer';
        const p: DrawPlayer = {
          id, x: lerp(fa[1], pb[1], f), y: lerp(fa[2], pb[2], f), aim: lerpAngle(fa[3], pb[3], f), cls, name: info?.name ?? '?',
          hp: pb[4], maxHp: pb[6], isMe: false, isKhan: !!(pb[5] & PF.Khan), hurt: !!(pb[5] & PF.Hurt),
          shield: !!(pb[5] & PF.Shield), walkT: anim.walkT, swing: progress(anim.swingAt, 220), swingAim: anim.swingAim,
          spin: progress(anim.spinAt, 350), cast: progress(anim.castAt, 250),
        };
        if (pb[5] & PF.Dash) this.dashGhost(p, now);
        scene.players.push(p);
      }
      for (const mb of b.mobs.values()) {
        const ma = a.mobs.get(mb[0]) ?? mb;
        const kind: MobKind = mb[4] & MF.Big ? 'big' : mb[4] & MF.Sam ? 'sam' : 'bog';
        const m: DrawMob = {
          id: mb[0], x: lerp(ma[1], mb[1], f), y: lerp(ma[2], mb[2], f), kind, hp: mb[3], maxHp: MOB_HP[kind],
          hurt: !!(mb[4] & MF.Hurt), moving: !!(mb[4] & MF.Moving), faceLeft: !!(mb[4] & MF.FaceLeft),
        };
        scene.mobs.push(m);
      }
      for (const qb of b.projs.values()) {
        if (qb[6] === this.myId) continue;
        const qa = a.projs.get(qb[0]) ?? qb;
        scene.projs.push({ kind: qb[1], x: lerp(qa[2], qb[2], f), y: lerp(qa[3], qb[3], f), vx: qb[4], vy: qb[5] });
      }
      for (const bb of b.bombs.values()) {
        const ba = a.bombs.get(bb[0]) ?? bb;
        scene.bombs.push({ x: lerp(ba[1], bb[1], f), y: lerp(ba[2], bb[2], f), fuse: bb[3] });
      }
      scene.hearts = latest.hearts.map(([id, x, y]) => ({ id, x, y }));
      scene.coins = latest.coins.map(([id, x, y, value]) => ({ id, x, y, value }));
    }
    for (const lp of this.localProjs) scene.projs.push(lp);

    if (this.alive) {
      const f = this.acc / SIM_DT;
      const x = lerp(this.prev.x, this.body.x, f) + this.corr.x, y = lerp(this.prev.y, this.body.y, f) + this.corr.y;
      const anim = this.anim(this.myId);
      anim.walkT = this.body.moving ? anim.walkT + dt : 0;
      const me: DrawPlayer = {
        id: this.myId, x, y, aim: this.lastAim, cls: this.cls, name: this.roster.get(this.myId)?.name ?? '', hp: this.myHp,
        maxHp: this.myMaxHp || CLASSES[this.cls].hp, isMe: true, isKhan: this.khan === this.myId, hurt: !!(this.myFlags & PF.Hurt),
        shield: !!(this.myFlags & PF.Shield), walkT: anim.walkT, swing: progress(anim.swingAt, 220), swingAim: anim.swingAim,
        spin: progress(anim.spinAt, 350), cast: progress(anim.castAt, 250),
      };
      if (this.body.dash > 0) this.dashGhost(me, now);
      scene.players.push(me);
      scene.me = { x, y };
      this.lastPos = { x, y };
      scene.focus = { x, y: y - CHEST };
      if (Math.hypot(x - MAP.wizard.x, y - MAP.wizard.y) < 300) scene.wizardLine = WIZARD_LINES[Math.floor(now / 5000) % WIZARD_LINES.length];
    } else scene.focus = { x: this.lastPos.x, y: this.lastPos.y - CHEST };
    return scene;
  }

  minimapPlayers() {
    const out: { x: number; y: number; me: boolean; khan: boolean }[] = [];
    const latest = this.snaps[this.snaps.length - 1];
    if (latest) for (const p of latest.players.values()) {
      if (p[0] !== this.myId && p[5] & PF.Alive) out.push({ x: p[1], y: p[2], me: false, khan: !!(p[5] & PF.Khan) });
    }
    if (this.alive) out.push({ x: this.body.x, y: this.body.y, me: true, khan: false });
    return out;
  }

  private dashGhost(p: DrawPlayer, now: number) {
    const a = this.anim(p.id);
    if (now - a.ghostAt < 30) return;
    a.ghostAt = now;
    const { sx, sy } = playerFrame(p);
    this.fx.ghost({ x: p.x, y: p.y, sheet: img[p.cls], sx, sy });
  }

  private updateLocalProjectiles(dt: number, scene: Scene) {
    this.localProjs = this.localProjs.filter((q) => {
      q.ttl -= dt;
      if (q.ttl <= 0) return false;
      const steps = Math.max(1, Math.ceil((Math.hypot(q.vx, q.vy) * dt) / 12));
      for (let i = 0; i < steps; i++) {
        q.x += (q.vx * dt) / steps;
        q.y += (q.vy * dt) / steps;
        if (shotBlocked(MAP, q.x, q.y + CHEST)) return false;
        // Cosmetic hit test so our arrow doesn't sail through someone while the server catches up.
        for (const p of scene.players) {
          if (p.isMe) continue;
          const rx = q.x - p.x, ry = q.y - p.y;
          if (rx >= HURT.left && rx <= HURT.right && ry >= HURT.top && ry <= HURT.bottom) return false;
        }
        for (const m of scene.mobs) {
          const rx = q.x - m.x, ry = q.y - m.y, w = m.kind === 'big' ? 40 : m.kind === 'sam' ? 22 : 26, h = m.kind === 'big' ? 170 : m.kind === 'sam' ? 62 : 112;
          if (Math.abs(rx) <= w && ry >= -h && ry <= 12) return false;
        }
      }
      return true;
    });
  }

  // --- events --------------------------------------------------------------------------------

  private playEvent(e: EventSnap, now: number, scene: Scene) {
    const me = scene.me ?? this.lastPos;
    const vol = (x: number, y: number, base = 1) => base * Math.max(0, 1 - Math.hypot(x - me.x, y - me.y) / 1400);
    const sfx = (name: Sfx, x: number, y: number, base = 1) => audio.play(name, vol(x, y, base));
    const posOf = (id: number) => scene.players.find((p) => p.id === id) ?? null;
    const fx = this.fx;
    switch (e[0]) {
      case Ev.Hit: {
        const [, x, y, amount, isMob, target] = e;
        const onMe = !isMob && target === this.myId;
        fx.text(x, y, `-${amount}`, onMe ? '#ff5050' : isMob ? '#fff' : '#ffd24a', amount >= 40);
        fx.burst(x, y + 50, isMob ? ['#3fbf3f', '#2a8f2a', '#a6f08a'] : ['#c0392b', '#e74c3c', '#7b1f1f'], 6, 220, { z: 50 });
        if (onMe) {
          fx.shake = Math.max(fx.shake, 10);
          audio.play('hurt', 0.9);
          this.hud.hurt();
        } else sfx('hit', x, y, 0.6);
        return;
      }
      case Ev.Boom: {
        const [, x, y, mul = 100] = e;
        const size = mul / 100;
        fx.puffs(x, y, Math.round(10 * size), 200 * size, 80);
        fx.burst(x, y, ['#ffb52e', '#ff6a00', '#ffe066', '#555'], Math.round(26 * size), 420 * size, { z: 10, lift: 420 });
        fx.ring(x, y, 20, 170 * size, '#ffd27a');
        fx.shake = Math.max(fx.shake, 22 * Math.max(0, 1 - Math.hypot(x - me.x, y - me.y) / 900));
        sfx('boom', x, y, 0.9);
        return;
      }
      case Ev.Swing: {
        const [, id, aim] = e;
        if (id === this.myId) return;
        const a = this.anim(id);
        a.swingAt = now;
        a.swingAim = aim;
        const p = posOf(id);
        if (p) sfx('sword', p.x, p.y, 0.7);
        return;
      }
      case Ev.Spin: {
        if (e[1] === this.myId) return;
        this.anim(e[1]).spinAt = now;
        const p = posOf(e[1]);
        if (p) sfx('swoosh', p.x, p.y, 0.8);
        return;
      }
      case Ev.Shoot: {
        const [, id, kind] = e;
        if (id === this.myId) return;
        this.anim(id).castAt = now;
        const p = posOf(id);
        if (p) sfx(kind === ProjKind.Arrow ? 'bow' : 'orb', p.x, p.y, 0.5);
        return;
      }
      case Ev.Blink: {
        const [, id, x0, y0, x1, y1] = e;
        if (id === this.myId) return;
        fx.sparkle(x0, y0, ['#c08cff', '#8ce6ff', '#fff'], 16);
        fx.sparkle(x1, y1, ['#c08cff', '#8ce6ff', '#fff'], 16);
        sfx('blink', x1, y1, 0.6);
        return;
      }
      case Ev.Dash: {
        if (e[1] === this.myId) return;
        const p = posOf(e[1]);
        if (p) sfx('swoosh', p.x, p.y, 0.6);
        return;
      }
      case Ev.Pickup: {
        const [, x, y, id] = e;
        fx.sparkle(x, y, ['#ff4d6d', '#ffb3c1', '#fff'], 10);
        fx.text(x, y - 60, '+25', '#5cff7a');
        if (id === this.myId) audio.play('pickup', 0.8);
        else sfx('pickup', x, y, 0.3);
        return;
      }
      case Ev.Die: {
        const [, x, y, isMob, big] = e;
        fx.puffs(x, y - 40, isMob ? (big ? 10 : 6) : 8, 140, big ? 90 : 64);
        fx.burst(x, y, isMob ? ['#3fbf3f', '#2a8f2a', '#a6f08a', '#000'] : ['#c0392b', '#e74c3c', '#f5f5f5'], big ? 30 : 18, 300, { z: 60 });
        sfx(isMob ? 'squish' : 'death', x, y, 0.8);
        return;
      }
      case Ev.Throw: {
        if (e[1] === this.myId) return;
        const p = posOf(e[1]);
        if (p) sfx('throw', p.x, p.y, 0.5);
        return;
      }
      case Ev.Burst: {
        const [, x, y] = e;
        fx.burst(x, y + CHEST, ['#c08cff', '#8ce6ff', '#ffffff', '#6a3cff'], 16, 260, { z: CHEST, gravity: 200, lift: 150 });
        fx.ring(x, y + CHEST, 10, 80, '#b48cff', 250);
        sfx('burst', x, y, 0.7);
        return;
      }
      case Ev.Spawn: {
        const [, x, y] = e;
        fx.sparkle(x, y, ['#fff', '#fff7b0', '#9fe8ff'], 18);
        sfx('spawn', x, y, 0.4);
        return;
      }
      case Ev.Coin: {
        const [, x, y, id, value] = e;
        fx.sparkle(x, y, ['#fff651', '#ffd903', '#fff'], 6 + value);
        fx.text(x, y - 50, `+${value}`, '#ffd903');
        if (id === this.myId) audio.play('coin', 0.7);
        else sfx('coin', x, y, 0.25);
        return;
      }
      case Ev.Buy: {
        const [, id, item] = e;
        const p = posOf(id);
        if (p) {
          fx.sparkle(p.x, p.y, ['#c08cff', '#fff651', '#fff'], 18);
          fx.text(p.x, p.y - 150, ITEMS[item]?.name ?? '', '#e0a0ff');
        }
        if (id === this.myId) audio.play('buy', 0.8);
        return;
      }
      case Ev.Steal: {
        const [, x, y, id, n] = e;
        fx.text(x, y - 150, `-${n} coins`, '#ffd903', true);
        fx.burst(x, y - 40, ['#fff651', '#ffd903'], 8, 250, { z: 60 });
        sfx('steal', x, y, id === this.myId ? 1 : 0.5);
        return;
      }
      case Ev.Thud: {
        const [, x, y] = e;
        fx.burst(x, y + CHEST, ['#7a4f1a', '#5a3a12', '#bbb'], 5, 160, { z: CHEST, size: 4 });
        sfx('thud', x, y, 0.4);
        return;
      }
    }
  }
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
