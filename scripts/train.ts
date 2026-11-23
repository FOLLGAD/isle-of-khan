/**
 * Tunes each class's bot tactics by hill climbing in self-play: perturb one class's tactics, play
 * the same seeded rounds, keep the change if that class's kill/death ratio improves. Classes take
 * turns so each adapts to the others. Prints the result to paste into TACTICS in src/server/bot.ts.
 *   npx tsx scripts/train.ts [iterationsPerClass] [cycles]
 */
import { CLASS_IDS, type ClassId } from '../src/shared/classes';
import { TACTICS, type Tactics } from '../src/server/bot';
import { arena, kd, mulberry32, report } from './arena';

type Space = Partial<Record<keyof Tactics, { min: number; max: number; step: number; int?: boolean }>>;
const COMMON: Space = {
  strafe: { min: 300, max: 3000, step: 300 },
  bomb: { min: 0, max: 1, step: 0.15 },
  bombMin: { min: 60, max: 400, step: 50 },
  bombMax: { min: 200, max: 600, step: 50 },
  heal: { min: 0, max: 0.9, step: 0.1 },
  evade: { min: 0, max: 1.5, step: 0.25 },
  bogBias: { min: -200, max: 800, step: 100 },
};
const SPACE: Record<ClassId, Space> = {
  archer: { ...COMMON, min: { min: 80, max: 500, step: 50 }, max: { min: 150, max: 700, step: 50 }, fire: { min: 200, max: 800, step: 60 }, escape: { min: 0, max: 400, step: 50 }, lead: { min: 0, max: 1.5, step: 0.2 } },
  mage: { ...COMMON, min: { min: 80, max: 500, step: 50 }, max: { min: 150, max: 700, step: 50 }, fire: { min: 200, max: 800, step: 60 }, escape: { min: 0, max: 400, step: 50 }, lead: { min: 0, max: 1.5, step: 0.2 } },
  warrior: { ...COMMON, fire: { min: 90, max: 200, step: 15 }, spinNear: { min: 1, max: 3, step: 1, int: true }, weave: { min: 0, max: 250, step: 40 } },
};

const iterations = Number(process.argv[2] ?? 30);
const cycles = Number(process.argv[3] ?? 2);
const trainSeeds = Array.from({ length: 12 }, (_, i) => 1 + i);
const holdout = Array.from({ length: 30 }, (_, i) => 5000 + i);
const rand = mulberry32(42);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());

const valid = (t: Tactics) => t.min < t.max && t.max < t.fire && t.bombMin < t.bombMax;

function mutate(t: Tactics, space: Space): Tactics {
  const next = { ...t };
  const keys = Object.keys(space) as (keyof Tactics)[];
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const k = keys[Math.floor(rand() * keys.length)];
    const s = space[k]!;
    let v = next[k] + gauss() * s.step;
    v = Math.max(s.min, Math.min(s.max, v));
    next[k] = s.int ? Math.round(v) : Math.round(v * 100) / 100;
  }
  return next;
}

const tactics: Record<ClassId, Tactics> = structuredClone(TACTICS);
const start = structuredClone(TACTICS);
const score = (t: Record<ClassId, Tactics>, cls: ClassId, seeds = trainSeeds) => kd(arena({ seeds, tactics: t })[cls]);

for (let cycle = 0; cycle < cycles; cycle++) {
  for (const cls of CLASS_IDS) {
    let best = score(tactics, cls);
    const first = best;
    for (let i = 0; i < iterations; i++) {
      const cand = mutate(tactics[cls], SPACE[cls]);
      if (!valid(cand)) continue;
      const s = score({ ...tactics, [cls]: cand }, cls);
      if (s > best) {
        best = s;
        tactics[cls] = cand;
      }
    }
    console.log(`cycle ${cycle + 1} ${cls}: K/D ${first.toFixed(2)} -> ${best.toFixed(2)}`);
  }
}

// Check on rounds the training never saw: each trained class against untrained opponents.
console.log('\nHeld-out check, each class trained vs. everyone else untrained:');
for (const cls of CLASS_IDS) {
  const before = score(start, cls, holdout), after = score({ ...start, [cls]: tactics[cls] }, cls, holdout);
  console.log(`  ${cls}: K/D ${before.toFixed(2)} -> ${after.toFixed(2)}`);
}
console.log('\nAll trained, held-out rounds:\n' + report(arena({ seeds: holdout, tactics })));
console.log('\nexport const TACTICS: Record<ClassId, Tactics> = ' + JSON.stringify(tactics, null, 2) + ';');
