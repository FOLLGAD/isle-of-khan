import type { ClassId } from '../shared/classes';
import { TILE } from '../shared/constants';
import { isShallow, MAP, WATER } from '../shared/map';
import type { MobKind } from '../shared/shop';
import { flash, img, redFlash } from './assets';
import type { Effects } from './fx';

export interface DrawPlayer {
  id: number;
  x: number;
  y: number;
  aim: number;
  cls: ClassId;
  name: string;
  hp: number;
  maxHp: number;
  isMe: boolean;
  isKhan: boolean;
  hurt: boolean;
  shield: boolean;
  /** Time spent walking, drives the walk cycle; 0 when standing. */
  walkT: number;
  /** 0..1 progress of a sword swing, whirlwind or spell cast; null when not acting. */
  swing: number | null;
  swingAim: number;
  spin: number | null;
  cast: number | null;
}

export interface DrawMob {
  id: number;
  x: number;
  y: number;
  kind: MobKind;
  hp: number;
  maxHp: number;
  hurt: boolean;
  moving: boolean;
  faceLeft: boolean;
}

export interface Scene {
  /** World point the camera centers on. */
  focus: { x: number; y: number };
  time: number;
  players: DrawPlayer[];
  mobs: DrawMob[];
  projs: { kind: number; x: number; y: number; vx: number; vy: number }[];
  bombs: { x: number; y: number; fuse: number }[];
  hearts: { id: number; x: number; y: number }[];
  coins: { id: number; x: number; y: number; value: number }[];
  /** Local player's feet, for fading trees in front of you and the wizard's chatter. */
  me: { x: number; y: number } | null;
  wizardLine: string | null;
}

const WORLD_W = MAP.w * TILE, WORLD_H = MAP.h * TILE;
/** Every screen shows about this much of the world, so big monitors don't see further. */
const VIEW_W = 1600, VIEW_H = 900;
const CHEST = 44;

/** Sprite sheet rows, by facing. Matches the original sheets: up, left, down, right. */
const ROW = { up: 0, left: 1, down: 2, right: 3 };
const facing = (aim: number) => {
  const a = Math.atan2(Math.sin(aim), Math.cos(aim));
  if (a > -Math.PI / 4 && a <= Math.PI / 4) return ROW.right;
  if (a > Math.PI / 4 && a <= (3 * Math.PI) / 4) return ROW.down;
  if (a > (-3 * Math.PI) / 4 && a <= -Math.PI / 4) return ROW.up;
  return ROW.left;
};
/** Sheet column for a walk-cycle time; front/back views have a 4-step cycle, side views 2. */
const walkFrame = (row: number, walkT: number) => {
  if (walkT <= 0) return 0;
  const step = Math.floor(walkT / 150);
  return row === ROW.up || row === ROW.down ? [0, 1, 0, 2][step % 4] : step % 2;
};

export function playerFrame(p: { aim: number; walkT: number }) {
  const row = facing(p.aim);
  return { sx: walkFrame(row, p.walkT) * 16, sy: row * 32 };
}

function buildLayers() {
  const tiles = img['tile-map'];
  const land = document.createElement('canvas');
  land.width = MAP.w * 8;
  land.height = MAP.h * 8;
  const g = land.getContext('2d')!;
  const foam = document.createElement('canvas');
  foam.width = land.width;
  foam.height = land.height;
  const f = foam.getContext('2d')!;
  f.fillStyle = '#fff';
  const isWater = (tx: number, ty: number) => tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h || MAP.tiles[ty * MAP.w + tx] === WATER;
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      const gid = MAP.tiles[ty * MAP.w + tx];
      if (gid === WATER) {
        // Surf: a broken white line on the water side of every shore edge.
        const x = tx * 8, y = ty * 8, dashed = (i: number) => (i + tx + ty) % 3 !== 0;
        for (let i = 0; i < 8; i++) {
          if (!isWater(tx, ty - 1) && dashed(i)) f.fillRect(x + i, y, 1, 1);
          if (!isWater(tx, ty + 1) && dashed(i)) f.fillRect(x + i, y + 7, 1, 1);
          if (!isWater(tx - 1, ty) && dashed(i)) f.fillRect(x, y + i, 1, 1);
          if (!isWater(tx + 1, ty) && dashed(i)) f.fillRect(x + 7, y + i, 1, 1);
        }
        continue;
      }
      g.drawImage(tiles, ((gid - 1) % 8) * 8, Math.floor((gid - 1) / 8) * 8, 8, 8, tx * 8, ty * 8, 8, 8);
    }
  }
  const water = document.createElement('canvas');
  water.width = water.height = TILE;
  const w = water.getContext('2d')!;
  w.imageSmoothingEnabled = false;
  w.drawImage(tiles, ((WATER - 1) % 8) * 8, 0, 8, 8, 0, 0, TILE, TILE);
  const shadow = document.createElement('canvas');
  shadow.width = 7;
  shadow.height = 3;
  const s = shadow.getContext('2d')!;
  s.fillStyle = '#000';
  s.fillRect(1, 0, 5, 3);
  s.fillRect(0, 1, 7, 1);
  return { land, foam, water, shadow };
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private layers = buildLayers();
  private waterPattern: CanvasPattern;
  /** CSS px per world px. */
  zoom = 1;
  private dpr = 1;
  cam = { x: 0, y: 0 };
  private cssW = 0;
  private cssH = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.waterPattern = this.ctx.createPattern(this.layers.water, 'repeat')!;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.cssW = innerWidth;
    this.cssH = innerHeight;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.zoom = Math.max(this.cssW / VIEW_W, this.cssH / VIEW_H);
  }

  screenToWorld(x: number, y: number) {
    return { x: this.cam.x + x / this.zoom, y: this.cam.y + y / this.zoom };
  }

  draw(scene: Scene, fx: Effects | null) {
    const { ctx } = this;
    const scale = this.zoom * this.dpr;
    const viewW = this.cssW / this.zoom, viewH = this.cssH / this.zoom;
    const clamp = (v: number, max: number) => (max <= 0 ? max / 2 : Math.max(0, Math.min(max, v)));
    let cx = clamp(scene.focus.x - viewW / 2, WORLD_W - viewW);
    let cy = clamp(scene.focus.y - viewH / 2, WORLD_H - viewH);
    if (fx && fx.shake > 0) (cx += (Math.random() - 0.5) * fx.shake), (cy += (Math.random() - 0.5) * fx.shake);
    // Snap to whole device pixels so the pixel art doesn't shimmer while scrolling.
    cx = Math.round(cx * scale) / scale;
    cy = Math.round(cy * scale) / scale;
    this.cam = { x: cx, y: cy };

    ctx.setTransform(scale, 0, 0, scale, -cx * scale, -cy * scale);
    ctx.imageSmoothingEnabled = false;
    const t = scene.time;

    // Water, drifting one art-pixel at a time.
    this.waterPattern.setTransform(new DOMMatrix().translate((Math.floor(t / 450) % 8) * 8, (Math.floor(t / 900) % 8) * 8));
    ctx.fillStyle = this.waterPattern;
    ctx.fillRect(cx - TILE, cy - TILE, viewW + TILE * 2, viewH + TILE * 2);
    const sx = Math.max(0, Math.floor(cx / 8) - 1), sy = Math.max(0, Math.floor(cy / 8) - 1);
    const sw = Math.min(MAP.w * 8 - sx, Math.ceil(viewW / 8) + 3), sh = Math.min(MAP.h * 8 - sy, Math.ceil(viewH / 8) + 3);
    ctx.globalAlpha = 0.22 + 0.12 * Math.sin(t / 700);
    ctx.drawImage(this.layers.foam, sx, sy, sw, sh, sx * 8, sy * 8, sw * 8, sh * 8);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.layers.land, sx, sy, sw, sh, sx * 8, sy * 8, sw * 8, sh * 8);

    const inView = (x: number, y: number, m = 200) => x > cx - m && x < cx + viewW + m && y > cy - m && y < cy + viewH + m * 1.5;

    // Ground layer: shadows, hearts, bombs, shockwaves.
    ctx.globalAlpha = 0.22;
    for (const p of scene.players) if (inView(p.x, p.y)) ctx.drawImage(this.layers.shadow, p.x - 28, p.y + 4, 56, 24);
    for (const m of scene.mobs) {
      if (!inView(m.x, m.y)) continue;
      const w = m.kind === 'big' ? 84 : m.kind === 'sam' ? 40 : 56;
      ctx.drawImage(this.layers.shadow, m.x - w / 2, m.y + 2, w, m.kind === 'big' ? 30 : 20);
    }
    ctx.drawImage(this.layers.shadow, MAP.wizard.x - 28, MAP.wizard.y + 4, 56, 24);
    ctx.globalAlpha = 1;
    for (const h of scene.hearts) {
      if (!inView(h.x, h.y)) continue;
      const bob = Math.round(Math.sin(t / 250 + h.id) * 1.5) * 4;
      ctx.globalAlpha = 0.2;
      ctx.drawImage(this.layers.shadow, h.x - 16, h.y + 8, 32, 12);
      ctx.globalAlpha = 1;
      ctx.drawImage(img.heart, h.x - 18, h.y - 28 + bob, 36, 36);
    }
    for (const c of scene.coins) {
      if (!inView(c.x, c.y)) continue;
      // A single coin is small; a dropped purse is a big one.
      const s = c.value > 1 ? 32 : 20;
      const bob = Math.round(Math.sin(t / 300 + c.id) * 1.5) * 4;
      ctx.globalAlpha = 0.2;
      ctx.drawImage(this.layers.shadow, c.x - s / 2, c.y + 6, s, 10);
      ctx.globalAlpha = 1;
      ctx.drawImage(img.coin, c.x - s / 2, c.y - s - 4 + bob, s, s);
      if (Math.floor(t / 120 + c.id) % 12 === 0) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(c.x - s / 2 + 4, c.y - s + bob, 4, 4);
      }
    }
    for (const b of scene.bombs) {
      if (!inView(b.x, b.y)) continue;
      ctx.drawImage(img.bomb, b.x - 24, b.y - 40, 48, 48);
      // Flashes faster as the fuse burns down.
      const rate = 60 + b.fuse * 3;
      if (Math.floor(t / rate) % 2 === 0) {
        ctx.globalAlpha = 0.6;
        ctx.drawImage(redFlash.bomb, b.x - 24, b.y - 40, 48, 48);
        ctx.globalAlpha = 1;
      }
    }
    fx?.drawGround(ctx);
    fx?.drawGhosts(ctx);

    // Everything that stands up gets sorted by where it touches the ground.
    const items: { y: number; draw: () => void }[] = [];
    for (const tr of MAP.trees) {
      const x = tr.tx * TILE, y = (tr.ty - 1) * TILE;
      if (!inView(x, y + TILE)) continue;
      const me = scene.me;
      const hides = me && me.x > x - 16 && me.x < x + TILE + 16 && me.y < y + TILE * 2 && me.y > y - 16;
      items.push({
        y: y + TILE * 2,
        draw: () => {
          if (hides) ctx.globalAlpha = 0.45;
          ctx.drawImage(img.tree, x, y, TILE, TILE * 2);
          ctx.globalAlpha = 1;
        },
      });
    }
    const wiz = MAP.wizard;
    items.push({ y: wiz.y, draw: () => ctx.drawImage(img.wizard, wiz.x - 32, wiz.y - 112 + (Math.floor(t / 700) % 2) * 4, 64, 128) });
    for (const p of scene.players) if (inView(p.x, p.y)) items.push({ y: p.y, draw: () => this.drawPlayer(p, t) });
    for (const m of scene.mobs) if (inView(m.x, m.y)) items.push({ y: m.y, draw: () => this.drawMob(m, t) });
    for (const q of scene.projs) {
      if (!inView(q.x, q.y)) continue;
      items.push({ y: q.y + CHEST, draw: () => this.drawProjectile(q, t) });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    fx?.drawAir(ctx);

    // Labels last so trees never hide who is who.
    for (const p of scene.players) if (inView(p.x, p.y)) this.drawLabel(p);
    for (const m of scene.mobs) {
      if (!inView(m.x, m.y)) continue;
      if (m.kind === 'sam') {
        ctx.font = '13px GameFont';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000';
        ctx.strokeText('Samuel', m.x, m.y - 86);
        ctx.fillStyle = '#e0a0ff';
        ctx.fillText('Samuel', m.x, m.y - 86);
      }
      if (m.hp >= m.maxHp) continue;
      const top = m.y - (m.kind === 'big' ? 200 : m.kind === 'sam' ? 80 : 136), w = m.kind === 'big' ? 70 : 50;
      ctx.fillStyle = '#000';
      ctx.fillRect(m.x - w / 2, top, w, 8);
      ctx.fillStyle = '#c33';
      ctx.fillRect(m.x - w / 2, top, (w * Math.max(0, m.hp)) / m.maxHp, 8);
    }
    if (scene.wizardLine) this.drawBubble(wiz.x, wiz.y - 136, scene.wizardLine);
  }

  private drawPlayer(p: DrawPlayer, t: number) {
    const { ctx } = this;
    const sheet = img[p.cls];
    const { sx, sy } = playerFrame(p);
    const ax = Math.cos(p.aim), ay = Math.sin(p.aim);
    const behind = ay < -0.35;
    if (p.shield && Math.floor(t / 90) % 2 === 0) ctx.globalAlpha = 0.45;
    if (behind) this.drawWeapon(p, ax, ay, t);
    ctx.drawImage(sheet, sx, sy, 16, 32, p.x - 32, p.y - 112, 64, 128);
    if (p.hurt) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(flash[p.cls], sx, sy, 16, 32, p.x - 32, p.y - 112, 64, 128);
      ctx.globalAlpha = p.shield && Math.floor(t / 90) % 2 === 0 ? 0.45 : 1;
    }
    if (!behind) this.drawWeapon(p, ax, ay, t);
    ctx.globalAlpha = 1;
    if (isShallow(MAP, p.x, p.y)) this.wade(p.x, p.y, 48, t);
  }

  /** Water lapping around the legs of anyone standing in the shallows. */
  private wade(x: number, y: number, w: number, t: number) {
    const { ctx } = this;
    const bob = Math.floor(t / 300) % 2 ? 4 : 0;
    ctx.fillStyle = 'rgba(58, 150, 255, 0.75)';
    ctx.fillRect(x - w / 2, y - 12 + bob, w, 28 - bob);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(x - w / 2 - 4, y - 12 + bob, 12, 4);
    ctx.fillRect(x + w / 2 - 8, y - 12 + bob, 12, 4);
  }

  private drawWeapon(p: DrawPlayer, ax: number, ay: number, t: number) {
    const { ctx } = this;
    const hx = p.x + ax * 22, hy = p.y - CHEST + ay * 18;
    if (p.cls === 'warrior') {
      let angle = p.aim;
      if (p.spin !== null) angle = p.aim + p.spin * Math.PI * 2;
      else if (p.swing !== null) {
        const e = 1 - Math.pow(1 - p.swing, 3);
        angle = p.swingAim - 1.3 + 2.6 * e;
      }
      const r = p.spin !== null || p.swing !== null ? 30 : 0;
      ctx.save();
      ctx.translate(p.x + Math.cos(angle) * r + (r ? 0 : ax * 22), p.y - CHEST + Math.sin(angle) * r * 0.8 + (r ? 0 : ay * 18));
      // The sword art points up-left from the grip in its bottom-right corner.
      ctx.rotate(angle + (3 * Math.PI) / 4);
      ctx.drawImage(img['short-sword'], -46, -46, 56, 56);
      ctx.restore();
      if (p.swing !== null || p.spin !== null) {
        const prog = p.spin ?? p.swing!;
        ctx.globalAlpha = (1 - prog) * 0.6;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 8;
        ctx.beginPath();
        if (p.spin !== null) ctx.ellipse(p.x, p.y - CHEST, 100, 80, 0, 0, Math.PI * 2);
        else ctx.ellipse(p.x, p.y - CHEST, 95, 78, 0, p.swingAim - 1.2, p.swingAim - 1.2 + 2.4 * (1 - Math.pow(1 - prog, 3)));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (p.cls === 'archer') {
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(p.aim);
      const pull = p.cast !== null ? (1 - p.cast) * 6 : 0;
      ctx.drawImage(img['bow-simple'], -12 + pull, -32, 24, 64);
      ctx.restore();
    } else {
      // The staff is held upright on the side the mage faces; its orb flares when casting.
      const side = ax >= 0 ? 1 : -1;
      const x = p.x + side * 30, y = p.y - 96;
      ctx.drawImage(img.staff, x - 8, y, 15, 70);
      const glow = p.cast !== null ? 1 - p.cast : 0.15 + 0.1 * Math.sin(t / 200);
      ctx.globalAlpha = glow;
      ctx.fillStyle = '#9fe8ff';
      ctx.fillRect(x - 12, y - 4, 24, 24);
      ctx.globalAlpha = 1;
    }
  }

  private drawLabel(p: DrawPlayer) {
    const { ctx } = this;
    const top = p.y - 132;
    ctx.font = '14px GameFont';
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.strokeText(p.name, p.x, top - 8);
    ctx.fillStyle = p.isMe ? '#fff7b0' : '#fff';
    ctx.fillText(p.name, p.x, top - 8);
    ctx.fillStyle = '#000';
    ctx.fillRect(p.x - 50, top, 100, 10);
    const f = Math.max(0, p.hp) / p.maxHp;
    ctx.fillStyle = f > 0.5 ? '#2ecc40' : f > 0.25 ? '#f1c40f' : '#e74c3c';
    ctx.fillRect(p.x - 48, top + 2, 96 * f, 6);
    if (p.isKhan) ctx.drawImage(img.crown, p.x - 22, top - 54, 45, 25);
  }

  private drawMob(m: DrawMob, t: number) {
    const { ctx } = this;
    if (m.kind === 'sam') return this.drawSam(m, t);
    const w = m.kind === 'big' ? 96 : 64, h = m.kind === 'big' ? 192 : 128;
    // A little wobble so bogs look alive.
    const squash = m.moving ? Math.round(Math.sin(t / 90 + m.id) * 2) * 4 : Math.round(Math.sin(t / 400 + m.id)) * 4;
    ctx.save();
    ctx.translate(m.x, m.y + 12);
    if (m.faceLeft) ctx.scale(-1, 1);
    ctx.drawImage(m.hurt ? flash.enemy : img.enemy, -w / 2 - squash / 2, -h + squash, w + squash, h - squash);
    ctx.restore();
    if (isShallow(MAP, m.x, m.y)) this.wade(m.x, m.y, m.kind === 'big' ? 80 : 56, t);
  }

  /** Samuel: the little 8x8 man from the original art, scuttling about. */
  private drawSam(m: DrawMob, t: number) {
    const { ctx } = this;
    const hop = m.moving ? (Math.floor(t / 70) % 2) * 4 : 0;
    ctx.save();
    ctx.translate(m.x, m.y + 10 - hop);
    if (m.faceLeft) ctx.scale(-1, 1);
    ctx.drawImage(m.hurt ? flash.sam : img.sam, -32, -64, 64, 64);
    ctx.restore();
    if (isShallow(MAP, m.x, m.y)) this.wade(m.x, m.y, 44, t);
  }

  private drawProjectile(q: { kind: number; x: number; y: number; vx: number; vy: number }, t: number) {
    const { ctx } = this;
    if (q.kind === 0) {
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(Math.atan2(q.vy, q.vx) + Math.PI / 2);
      ctx.drawImage(img.arrow, -10, -16, 20, 32);
      ctx.restore();
    } else {
      const s = 28 + Math.round(Math.sin(t / 60)) * 4;
      ctx.drawImage(img.bolt, q.x - s / 2, q.y - s / 2, s, s);
    }
  }

  private drawBubble(x: number, y: number, text: string) {
    const { ctx } = this;
    ctx.font = '13px GameFont';
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > 300 && line) (lines.push(line), (line = w));
      else line = next;
    }
    lines.push(line);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 28, h = lines.length * 20 + 18;
    const bx = Math.round(x - w / 2), by = Math.round(y - h);
    ctx.fillStyle = '#000';
    ctx.fillRect(bx - 4, by, w + 8, h);
    ctx.fillRect(bx, by - 4, w, h + 8);
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(x - 8, by + h + 4, 16, 8);
    ctx.fillRect(x - 4, by + h + 12, 8, 8);
    ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + 14, by + 26 + i * 20));
  }
}
