/**
 * Class balance check: plays many seeded bot rounds and reports each class's kill/death ratio with
 * a 95% interval (bootstrapped over rounds), plus how each class fares against each other class.
 *   npx tsx scripts/balance.ts [rounds]
 */
import { CLASS_IDS, type ClassId } from '../src/shared/classes';
import { arena, mulberry32, report, type ClassStats } from './arena';

const rounds = Number(process.argv[2] ?? 40);
const per = Array.from({ length: rounds }, (_, i) => arena({ seeds: [9000 + i] }));
const total = arena({ seeds: [] });
for (const r of per) for (const c of CLASS_IDS) {
  const t = total[c], s = r[c];
  t.kills += s.kills; t.deaths += s.deaths; t.bogDeaths += s.bogDeaths; t.suicides += s.suicides; t.bogs += s.bogs;
  t.aliveMin += s.aliveMin; t.idleMin += s.idleMin;
  for (const v of CLASS_IDS) t.killed[v] += s.killed[v];
}
console.log(report(total));

const rand = mulberry32(7);
const ratio = (rs: Record<ClassId, ClassStats>[], c: ClassId) =>
  rs.reduce((n, r) => n + r[c].kills, 0) / Math.max(1, rs.reduce((n, r) => n + r[c].deaths, 0));
console.log('\nK/D with 95% interval over rounds:');
for (const c of CLASS_IDS) {
  const boots = Array.from({ length: 400 }, () => ratio(Array.from({ length: rounds }, () => per[Math.floor(rand() * rounds)]), c)).sort((a, b) => a - b);
  console.log(`  ${c.padEnd(8)} ${ratio(per, c).toFixed(2)}  [${boots[10].toFixed(2)}, ${boots[389].toFixed(2)}]`);
}
console.log('\nHead to head (row kills column / column kills row):');
for (const a of CLASS_IDS) {
  console.log('  ' + a.padEnd(8) + CLASS_IDS.map((b) => `${b} ${(total[a].killed[b] / Math.max(1, total[b].killed[a])).toFixed(2)}`).join('   '));
}
