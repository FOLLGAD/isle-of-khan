import { img, type Img } from './assets';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Vertical lift above the ground, so bits can arc up and land. */
  z: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  color: string | null;
  sprite: Img | null;
  gravity: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  max: number;
  big: boolean;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  max: number;
  color: string;
}

export interface Ghost {
  x: number;
  y: number;
  sheet: Img;
  sx: number;
  sy: number;
  life: number;
  max: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Client-only eye candy: particles, floating numbers, shockwave rings, dash ghosts, screen shake. */
export class Effects {
  particles: Particle[] = [];
  texts: FloatText[] = [];
  rings: Ring[] = [];
  ghosts: Ghost[] = [];
  shake = 0;

  update(dt: number) {
    const s = dt / 1000;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vz -= p.gravity * s;
      p.z = Math.max(0, p.z + p.vz * s);
      p.vx *= Math.pow(0.1, s);
      p.vy *= Math.pow(0.1, s);
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) (t.life -= dt), (t.y -= 50 * s);
    this.texts = this.texts.filter((t) => t.life > 0);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const g of this.ghosts) g.life -= dt;
    this.ghosts = this.ghosts.filter((g) => g.life > 0);
    this.shake = Math.max(0, this.shake - dt * 0.04);
  }

  /** Blocky "pixels" in the art's 8px grid, flying out from a point. */
  burst(x: number, y: number, colors: string[], n: number, speed = 260, opts: { size?: number; z?: number; lift?: number; gravity?: number; life?: number } = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(0.3, 1) * speed;
      const life = (opts.life ?? 600) * rand(0.6, 1.2);
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6, z: opts.z ?? 40, vz: rand(0.3, 1) * (opts.lift ?? 300),
        life, max: life, size: opts.size ?? 8, color: colors[i % colors.length], sprite: null, gravity: opts.gravity ?? 900,
      });
    }
  }

  /** The original explosion: puffs of the cloud sprite drifting outward. */
  puffs(x: number, y: number, n: number, speed = 160, size = 64) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(0.4, 1) * speed;
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, z: rand(0, 30), vz: rand(10, 60), life: 550, max: 550,
        size: size * rand(0.7, 1.2), color: null, sprite: img.particle, gravity: 0,
      });
    }
  }

  sparkle(x: number, y: number, colors: string[], n: number) {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: x + rand(-24, 24), y: y + rand(-6, 6), vx: rand(-20, 20), vy: 0, z: rand(0, 110), vz: rand(60, 160),
        life: rand(400, 800), max: 800, size: 8, color: colors[i % colors.length], sprite: null, gravity: 0,
      });
    }
  }

  text(x: number, y: number, text: string, color: string, big = false) {
    this.texts.push({ x: x + rand(-10, 10), y, text, color, life: 900, max: 900, big });
  }

  ring(x: number, y: number, r0: number, r1: number, color: string, life = 350) {
    this.rings.push({ x, y, r0, r1, color, life, max: life });
  }

  ghost(g: Omit<Ghost, 'life' | 'max'>, life = 220) {
    this.ghosts.push({ ...g, life, max: life });
  }

  drawGround(ctx: CanvasRenderingContext2D) {
    for (const r of this.rings) {
      const f = 1 - r.life / r.max;
      ctx.globalAlpha = (1 - f) * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.r0 + (r.r1 - r.r0) * f, (r.r0 + (r.r1 - r.r0) * f) * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawGhosts(ctx: CanvasRenderingContext2D) {
    for (const g of this.ghosts) {
      ctx.globalAlpha = (g.life / g.max) * 0.45;
      ctx.drawImage(g.sheet, g.sx, g.sy, 16, 32, g.x - 32, g.y - 112, 64, 128);
    }
    ctx.globalAlpha = 1;
  }

  drawAir(ctx: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      const f = p.life / p.max;
      if (p.sprite) {
        ctx.globalAlpha = Math.min(1, f * 1.5) * 0.9;
        const s = p.size * (0.6 + 0.4 * f);
        ctx.drawImage(p.sprite, p.x - s / 2, p.y - p.z - s / 2, s, s);
      } else {
        ctx.globalAlpha = Math.min(1, f * 2);
        ctx.fillStyle = p.color!;
        // Snap to the 8px art grid so particles look like they belong to the sprites.
        ctx.fillRect(Math.round((p.x - p.size / 2) / 4) * 4, Math.round((p.y - p.z - p.size / 2) / 4) * 4, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const t of this.texts) {
      const f = t.life / t.max;
      ctx.globalAlpha = Math.min(1, f * 2.5);
      ctx.font = `${t.big ? 22 : 16}px GameFont`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#000';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }
}
