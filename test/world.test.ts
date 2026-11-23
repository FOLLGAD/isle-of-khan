import { describe, expect, it } from 'vitest';
import { CLASSES } from '../src/shared/classes';
import { INTERMISSION_MS, Key, ROUND_MS, SIM_DT, TICK_DT } from '../src/shared/constants';
import { MAP, boxBlocked } from '../src/shared/map';
import type { ServerMsg } from '../src/shared/protocol';
import { newBody, stepPlayer } from '../src/shared/sim';
import { World, type Player } from '../src/server/world';

function setup() {
  const sent: { to: number | 'all'; msg: ServerMsg }[] = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let now = 1_000_000;
  const world = new World({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: 'all', msg }) }, now, rand);
  world.mobs = [];
  let seq = 0;
  const run = (ms: number, inputs: (p: Player) => { keys: number; aim: number; dist?: number } | null = () => null) => {
    for (let t = 0; t < ms; t += TICK_DT) {
      for (const p of world.players.values()) {
        const i = inputs(p);
        if (!i) continue;
        const batch = [1, 2].map(() => [++seq, i.keys, i.aim, i.dist ?? 0] as [number, number, number, number]);
        world.handle(p.id, { t: 'in', i: batch });
      }
      now += TICK_DT;
      world.tick(now);
      world.mobs = world.mobs.filter(() => false);
      world.flushEvents();
    }
  };
  /** Places two players face to face on open ground, past their spawn shields. */
  const duel = (a: Player, b: Player, gap: number) => {
    const x = 28 * 64, y = 57 * 64 + 32;
    a.body = newBody(x, y);
    b.body = newBody(x + gap, y);
    a.shieldUntil = b.shieldUntil = 0;
  };
  return { world, sent, run, duel, now: () => now };
}

describe('map', () => {
  it('loads the island with water around it and trees on it', () => {
    expect(MAP.w).toBe(100);
    expect(MAP.trees.length).toBeGreaterThan(100);
    expect(boxBlocked(MAP, 0, 0, 10, 10)).toBe(true);
    const t = MAP.trees[0];
    expect(boxBlocked(MAP, t.tx * 64 + 10, t.ty * 64 + 10, t.tx * 64 + 20, t.ty * 64 + 20)).toBe(true);
  });

  it('stops players at the shoreline', () => {
    const b = newBody(30 * 64, 60 * 64);
    for (let i = 0; i < 600; i++) stepPlayer(MAP, b, 'archer', { seq: i, keys: Key.Left, aim: 0, dist: 0 });
    expect(boxBlocked(MAP, b.x - 18, b.y - 12, b.x + 18, b.y + 12)).toBe(false);
    expect(b.x).toBeGreaterThan(0);
  });
});

describe('world', () => {
  it('names guests and spawns them on land', () => {
    const { world } = setup();
    const a = world.join('', 'mage');
    const b = world.join('  ', 'nonsense');
    expect([a.name, b.name]).toEqual(['Guest 1', 'Guest 2']);
    expect(b.cls).toBe('archer');
    expect(a.hp).toBe(CLASSES.mage.hp);
    expect(boxBlocked(MAP, a.body.x - 18, a.body.y - 12, a.body.x + 18, a.body.y + 12)).toBe(false);
  });

  it('moves players only as fast as real time allows', () => {
    const { world, run } = setup();
    const p = world.join('Speedy', 'archer');
    const x0 = p.body.x;
    // A cheating client sends 30 inputs per message.
    for (let i = 0; i < 20; i++) {
      world.handle(p.id, { t: 'in', i: Array.from({ length: 30 }, (_, j) => [i * 30 + j + 1, Key.Right, 0, 0] as [number, number, number, number]) });
      run(TICK_DT);
    }
    const maxSteps = (20 * TICK_DT) / SIM_DT + 16;
    expect(p.body.x - x0).toBeLessThanOrEqual(maxSteps * SIM_DT * CLASSES.archer.speed + 1);
  });

  it('archer arrows kill and award the kill', () => {
    const { world, run, duel, sent } = setup();
    const a = world.join('Alice', 'archer');
    const b = world.join('Bob', 'warrior');
    duel(a, b, 300);
    run(4000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(b.alive).toBe(false);
    expect(a.kills).toBe(1);
    expect(a.score).toBe(3);
    expect(sent.some((s) => s.msg.t === 'kill' && s.msg.k === 'Alice' && s.msg.v === 'Bob' && s.msg.how === 'arrow')).toBe(true);
    expect(sent.some((s) => s.to === b.id && s.msg.t === 'dead')).toBe(true);
  });

  it('sword hits in front but not behind', () => {
    const { world, run, duel } = setup();
    const a = world.join('A', 'warrior');
    const b = world.join('B', 'archer');
    duel(a, b, 90);
    run(TICK_DT * 2, (p) => (p === a ? { keys: Key.Primary, aim: Math.PI } : null));
    expect(b.hp).toBe(CLASSES.archer.hp);
    run(1000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(b.hp).toBeLessThan(CLASSES.archer.hp);
  });

  it('bombs hurt everyone nearby, the thrower half as much', () => {
    const { world, run, duel, sent } = setup();
    const a = world.join('A', 'archer');
    const b = world.join('B', 'archer');
    duel(a, b, 120);
    run(TICK_DT, (p) => (p === a ? { keys: Key.Secondary, aim: 0, dist: 60 } : null));
    run(1300);
    expect(b.hp).toBeLessThan(CLASSES.archer.hp);
    expect(a.hp).toBeLessThan(CLASSES.archer.hp);
    expect(CLASSES.archer.hp - a.hp).toBeLessThan(CLASSES.archer.hp - b.hp);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('respawns only after the timer, with the newly chosen class', () => {
    const { world, run, duel } = setup();
    const a = world.join('A', 'archer');
    const b = world.join('B', 'archer');
    duel(a, b, 300);
    run(4000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(b.alive).toBe(false);
    world.handle(b.id, { t: 'respawn', cls: 'mage' });
    run(3000);
    world.handle(b.id, { t: 'respawn', cls: 'mage' });
    expect(b.alive).toBe(true);
    expect(b.cls).toBe('mage');
    expect(b.hp).toBe(CLASSES.mage.hp);
  });

  it('crowns the leader as Khan and pays a bounty on them', () => {
    const { world, run, duel } = setup();
    const a = world.join('A', 'archer');
    const b = world.join('B', 'archer');
    b.score = 10;
    run(TICK_DT);
    expect(world.khan).toBe(b.id);
    duel(a, b, 300);
    run(4000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(a.score).toBe(5);
  });

  it('ends the round, shows results, then starts fresh', () => {
    const { world, run, sent } = setup();
    const a = world.join('A', 'archer');
    a.score = 7;
    run(ROUND_MS + TICK_DT);
    expect(world.phase).toBe('end');
    const end = sent.find((s) => s.msg.t === 'round' && s.msg.phase === 'end')?.msg;
    expect(end && end.t === 'round' && end.results[0]).toMatchObject({ name: 'A', score: 7 });
    run(INTERMISSION_MS + TICK_DT);
    expect(world.phase).toBe('play');
    expect(a.score).toBe(0);
    expect(a.alive).toBe(true);
  });

  it('rate limits chat and strips control characters', () => {
    const { world, sent, run } = setup();
    const a = world.join('A', 'archer');
    sent.length = 0;
    world.handle(a.id, { t: 'chat', m: 'hi\u0007 there' });
    world.handle(a.id, { t: 'chat', m: 'spam' });
    run(700);
    world.handle(a.id, { t: 'chat', m: 'later' });
    expect(sent.filter((s) => s.msg.t === 'chat').map((s) => s.msg.t === 'chat' && s.msg.m)).toEqual(['hi there', 'later']);
  });
});
