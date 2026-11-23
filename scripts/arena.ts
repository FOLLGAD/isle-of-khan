/**
 * Bot-only simulated rounds, used to judge bot play and class balance.
 *   npx tsx scripts/arena.ts [rounds]
 */
import { CLASS_IDS, type ClassId } from '../src/shared/classes';
import { TICK_DT } from '../src/shared/constants';
import type { ServerMsg } from '../src/shared/protocol';
import { TACTICS, type Tactics } from '../src/server/bot';
import { World } from '../src/server/world';

export interface ClassStats {
  kills: number;
  deaths: number;
  bogDeaths: number;
  suicides: number;
  bogs: number;
  aliveMin: number;
  idleMin: number;
  killed: Record<ClassId, number>;
}

/** Small fast seeded PRNG so runs are repeatable. */
export const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function arena(opts: { seeds: number[]; tactics?: Record<ClassId, Tactics>; bots?: number; roundMs?: number }) {
  const stats = Object.fromEntries(
    CLASS_IDS.map((c) => [c, { kills: 0, deaths: 0, bogDeaths: 0, suicides: 0, bogs: 0, aliveMin: 0, idleMin: 0, killed: { archer: 0, warrior: 0, mage: 0 } }]),
  ) as Record<ClassId, ClassStats>;
  for (const seed of opts.seeds) {
    let now = 1_000_000;
    let world!: World;
    const out = {
      send: () => {},
      broadcast: (m: ServerMsg) => {
        if (m.t !== 'kill') return;
        const v = world.players.get(m.vid);
        if (!v?.bot) return;
        stats[v.cls].deaths++;
        if (m.how === 'bog') return void stats[v.cls].bogDeaths++;
        if (m.kid === m.vid) return void stats[v.cls].suicides++;
        const k = world.players.get(m.kid);
        if (!k?.bot) return;
        stats[k.cls].kills++;
        stats[k.cls].killed[v.cls]++;
      },
    };
    world = new World(out, now, { rand: mulberry32(seed), botFill: (opts.bots ?? 9) + 1, tactics: opts.tactics ?? TACTICS });
    // A permanently dead spectator: bots only play while someone is in the room.
    const spectator = world.join('Spectator', 'warrior');
    spectator.alive = false;
    spectator.respawnAt = Infinity;
    const lastPos = new Map<number, { x: number; y: number }>();
    const roundMs = opts.roundMs ?? 180_000;
    let sinceSample = 0;
    for (let t = 0; t < roundMs; t += TICK_DT) {
      now += TICK_DT;
      const before = new Map([...world.players.values()].filter((p) => p.bot).map((p) => [p.id, p.bogs]));
      world.tick(now);
      world.flushEvents();
      for (const p of world.players.values()) {
        if (!p.bot) continue;
        stats[p.cls].bogs += p.bogs - (before.get(p.id) ?? p.bogs);
        if (p.alive) stats[p.cls].aliveMin += TICK_DT / 60_000;
      }
      sinceSample += TICK_DT;
      if (sinceSample >= 2000) {
        sinceSample = 0;
        for (const p of world.players.values()) {
          if (!p.bot || !p.alive) continue;
          const l = lastPos.get(p.id);
          if (l && Math.hypot(l.x - p.body.x, l.y - p.body.y) < 24) stats[p.cls].idleMin += 2 / 60;
          lastPos.set(p.id, { x: p.body.x, y: p.body.y });
        }
      }
    }
  }
  return stats;
}

export const kd = (s: ClassStats) => s.kills / Math.max(1, s.deaths);

export function report(stats: Record<ClassId, ClassStats>) {
  const rows = CLASS_IDS.map((c) => {
    const s = stats[c];
    const perMin = (n: number) => (n / Math.max(0.01, s.aliveMin)).toFixed(2);
    return `${c.padEnd(8)} K/D ${kd(s).toFixed(2)}  kills ${String(s.kills).padStart(4)}  deaths ${String(s.deaths).padStart(4)} (bogs ${s.bogDeaths}, self ${s.suicides})  ` +
      `bog kills/min ${perMin(s.bogs)}  idle ${((100 * s.idleMin) / Math.max(0.01, s.aliveMin)).toFixed(0)}%  ` +
      `killed A/W/M ${s.killed.archer}/${s.killed.warrior}/${s.killed.mage}`;
  });
  return rows.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rounds = Number(process.argv[2] ?? 10);
  const t0 = performance.now();
  const stats = arena({ seeds: Array.from({ length: rounds }, (_, i) => 1000 + i) });
  console.log(report(stats));
  console.log(`${rounds} rounds in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
