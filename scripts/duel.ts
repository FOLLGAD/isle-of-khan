/**
 * Reproduces what a person sees in a sword fight with a bot: a simulated client with real network
 * delay and interpolation duels a bot warrior on the actual server code. Reports how many swings
 * that looked like hits on the player's screen actually landed on the server.
 *   npx tsx scripts/duel.ts [pingMs]
 */
import { INTERP_DELAY, Key, SIM_DT, TICK_DT } from '../src/shared/constants';
import { Ev, type ServerMsg } from '../src/shared/protocol';
import { World } from '../src/server/world';
import { mulberry32 } from './arena';

export function duel(ping: number, seconds = 180, seed = 1) {
  const oneWay = ping / 2;
  let now = 1_000_000;
  const world = new World({ send: () => {}, broadcast: () => {} } as { send(id: number, m: ServerMsg): void; broadcast(m: ServerMsg): void }, now, { rand: mulberry32(seed), botFill: 2 });
  const me = world.join('Human', 'warrior');
  // Snapshots of the bot's position as the client receives them: [serverTime, arrivalTime, x, y].
  const seen: [number, number, number, number][] = [];
  const inFlight: { at: number; msg: Parameters<World['handle']>[1] }[] = [];
  let seq = 0, outbox: [number, number, number, number][] = [], clientNow = now, viewAt = 0;
  let swings = 0, lookedLikeHits = 0, landed = 0, botDamage = 0, myDamage = 0;
  const pendingLooks: number[] = [];
  for (let t = 0; t < seconds * 1000; t += TICK_DT) {
    const bot = [...world.players.values()].find((p) => p.bot);
    if (bot && bot.cls !== 'warrior') bot.cls = 'warrior';
    // The client runs at 60 Hz between server ticks.
    for (let f = 0; f < 2; f++) {
      clientNow += SIM_DT;
      const latest = seen.filter((s) => s[1] <= clientNow);
      if (!bot || !latest.length) continue;
      const last = latest[latest.length - 1];
      // Render time in server clock, exactly as the real client computes it.
      viewAt = last[0] + (clientNow - last[1]) - INTERP_DELAY;
      const i = latest.findIndex((s) => s[0] > viewAt);
      const a = latest[Math.max(0, i - 1)], b = latest[i < 0 ? latest.length - 1 : i];
      const k = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (viewAt - a[0]) / (b[0] - a[0])));
      const vx = a[2] + (b[2] - a[2]) * k, vy = a[3] + (b[3] - a[3]) * k;
      const dx = vx - me.body.x, dy = vy - me.body.y, d = Math.hypot(dx, dy);
      let keys = 0;
      if (d > 70) keys |= (dx > 20 ? Key.Right : 0) | (dx < -20 ? Key.Left : 0) | (dy > 20 ? Key.Down : 0) | (dy < -20 ? Key.Up : 0);
      if (d < 125 && me.alive && me.body.cdP === 0) {
        keys |= Key.Primary;
        pendingLooks.push(seq + 1);
      }
      outbox.push([++seq, keys, Math.atan2(dy, dx), d]);
      if (outbox.length >= 2) {
        inFlight.push({ at: clientNow + oneWay, msg: { t: 'in', i: outbox, vt: viewAt } });
        outbox = [];
      }
    }
    now += TICK_DT;
    for (const m of inFlight.filter((m) => m.at <= now)) world.handle(me.id, m.msg);
    inFlight.splice(0, inFlight.length, ...inFlight.filter((m) => m.at > now));
    const botHp = bot?.hp ?? 0, myHp = me.hp;
    world.mobs = [];
    world.tick(now);
    // Only count swings at a bot that could be hit: alive and past its spawn shield.
    const hittable = !!bot && botHp > 0 && now >= bot.shieldUntil;
    const evs = world.events.map((ev) => ev.data);
    if (hittable && evs.some((e) => e[0] === Ev.Swing && e[1] === me.id)) {
      swings++;
      if (evs.some((e) => e[0] === Ev.Hit && e[5] === bot!.id)) landed++;
    }
    world.flushEvents();
    if (bot) botDamage += Math.max(0, botHp - bot.hp);
    myDamage += Math.max(0, myHp - me.hp);
    lookedLikeHits = pendingLooks.filter((s) => s <= me.ack).length;
    if (bot?.alive) seen.push([now, now + oneWay, bot.body.x, bot.body.y]);
    if (!me.alive) world.handle(me.id, { t: 'respawn', cls: 'warrior' });
    me.shieldUntil = 0;
  }
  return { swings, lookedLikeHits, landed, hitRate: landed / Math.max(1, swings), myDamageDealt: botDamage, damageTaken: myDamage };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const ping of process.argv[2] ? [Number(process.argv[2])] : [0, 40, 80, 150]) {
    const runs = [1, 2, 3, 4, 5].map((s) => duel(ping, 120, s));
    const sum = (k: keyof ReturnType<typeof duel>) => runs.reduce((n, r) => n + (r[k] as number), 0);
    console.log(`ping ${String(ping).padStart(3)}ms: swings ${sum('swings')}, landed ${sum('landed')} (${((100 * sum('landed')) / Math.max(1, sum('swings'))).toFixed(0)}%), damage dealt ${sum('myDamageDealt')} vs taken ${sum('damageTaken')}`);
  }
}
