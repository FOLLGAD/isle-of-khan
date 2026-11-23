import { describe, expect, it } from 'vitest';
import { CLASSES } from '../src/shared/classes';
import { INTERMISSION_MS, Key, ROUND_MS, SIM_DT, TICK_DT } from '../src/shared/constants';
import { MAP, boxBlocked } from '../src/shared/map';
import type { ServerMsg } from '../src/shared/protocol';
import { newBody, stepPlayer } from '../src/shared/sim';
import { World, type Player } from '../src/server/world';
import { maxHp } from '../src/shared/shop';

function setup() {
  const sent: { to: number | 'all'; msg: ServerMsg }[] = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let now = 1_000_000;
  const world = new World({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: 'all', msg }) }, now, { rand, botFill: 0 });
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

describe('ford', () => {
  it('lets you wade from the crescent to the mainland, slowly', () => {
    // Walk up-left from the crescent's east tip across the shallows.
    const b = newBody(79.5 * 64, 69.5 * 64);
    for (let i = 0; i < 400 && b.x > 73.6 * 64; i++) stepPlayer(MAP, b, 'archer', { seq: i, keys: Key.Up | Key.Left, aim: 0, dist: 0 });
    expect(b.x).toBeLessThanOrEqual(73.6 * 64);
    expect(b.y).toBeLessThan(67.5 * 64);

    const step = (x: number, y: number) => {
      const body = newBody(x, y);
      stepPlayer(MAP, body, 'archer', { seq: 1, keys: Key.Right, aim: 0, dist: 0 });
      return body.x - x;
    };
    expect(step(76.5 * 64, 68.5 * 64)).toBeLessThan(step(28 * 64, 57 * 64 + 32) * 0.7);
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
    // A full-health warrior takes 13 arrows.
    run(8000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
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

  it('judges swings by what the swinger saw, within reason', () => {
    const { world, run, duel } = setup();
    const a = world.join('A', 'warrior');
    const b = world.join('B', 'archer');
    duel(a, b, 90);
    run(500);
    // B steps out of reach just as A swings: A still saw B in range, so it lands.
    b.body.x += 200;
    run(TICK_DT, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(b.hp).toBeLessThan(CLASSES.archer.hp);
    // Long gone by the time of the next swing: a miss.
    const hp = b.hp;
    run(1000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(b.hp).toBe(hp);
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

describe('coins and the wizard', () => {
  const atWizard = (world: World, p: Player) => {
    p.body = newBody(world.map.wizard.x, world.map.wizard.y + 80);
    p.shieldUntil = 0;
  };

  it('sells upgrades only up close and only for coin', () => {
    const { world } = setup();
    const p = world.join('Buyer', 'warrior');
    p.coins = 100;
    expect(world.buy(p, 'weapon')).toBe(false);
    atWizard(world, p);
    p.coins = 5;
    expect(world.buy(p, 'weapon')).toBe(false);
    p.coins = 100;
    expect(world.buy(p, 'weapon')).toBe(true);
    expect(world.buy(p, 'weapon')).toBe(true);
    expect(world.buy(p, 'weapon')).toBe(true);
    expect(world.buy(p, 'weapon')).toBe(false);
    expect(p.coins).toBe(100 - 6 - 10 - 16);
    expect(p.up.weapon).toBe(3);
  });

  it('armor raises max and current health; the potion heals to full', () => {
    const { world } = setup();
    const p = world.join('Tank', 'warrior');
    atWizard(world, p);
    p.coins = 50;
    p.hp = 100;
    expect(world.buy(p, 'armor')).toBe(true);
    expect(maxHp('warrior', p.up)).toBe(220);
    expect(p.hp).toBe(120);
    expect(world.buy(p, 'potion')).toBe(true);
    expect(p.hp).toBe(220);
    expect(world.buy(p, 'potion')).toBe(false);
  });

  it('upgraded weapons hit harder', () => {
    const plain = setup(), sharp = setup();
    for (const { world, run, duel } of [plain, sharp]) {
      const a = world.join('A', 'archer');
      const b = world.join('B', 'warrior');
      if (world === sharp.world) a.up.weapon = 3;
      duel(a, b, 300);
      run(TICK_DT * 4, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
      run(400);
    }
    const lost = (w: World) => 200 - [...w.players.values()].find((p) => p.name === 'B')!.hp;
    expect(lost(sharp.world)).toBeGreaterThan(lost(plain.world));
  });

  it('pays bounties and spills half the purse on death', () => {
    const { world, run, duel } = setup();
    const a = world.join('A', 'archer');
    const b = world.join('B', 'archer');
    b.coins = 9;
    duel(a, b, 300);
    run(4000, (p) => (p === a ? { keys: Key.Primary, aim: 0 } : null));
    expect(b.alive).toBe(false);
    expect(b.coins).toBe(5);
    expect(world.drops.some((d) => d.value === 4)).toBe(true);
    expect(a.coins).toBeGreaterThanOrEqual(2);
  });
});

describe('Samuel', () => {
  it('turns up, steals coins, and gives them back when caught', () => {
    let now = 1_000_000;
    const sent: ServerMsg[] = [];
    const world = new World({ send: () => {}, broadcast: (m) => sent.push(m) }, now, { botFill: 0 });
    const p = world.join('Rich', 'warrior');
    p.coins = 20;
    let sam;
    for (let t = 0; t < 200_000 && !sam; t += TICK_DT) {
      now += TICK_DT;
      world.tick(now);
      world.flushEvents();
      p.hp = 200;
      sam = world.mobs.find((m) => m.kind === 'sam');
    }
    expect(sam).toBeTruthy();
    expect(sent.some((m) => m.t === 'announce' && m.m.includes('Samuel'))).toBe(true);
    // Stand still and let him come; he steals and runs.
    world.mobs = [sam!];
    p.shieldUntil = 0;
    for (let t = 0; t < 30_000 && sam!.stolen === 0; t += TICK_DT) {
      now += TICK_DT;
      world.tick(now);
      world.flushEvents();
      world.mobs = world.mobs.filter((m) => m.kind === 'sam');
      p.hp = 200;
    }
    expect(sam!.stolen).toBe(3);
    expect(p.coins).toBe(17);
  });
});

describe('bots', () => {
  function botWorld() {
    let now = 1_000_000;
    const world = new World({ send: () => {}, broadcast: () => {} }, now, { botFill: 6 });
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += TICK_DT) {
        now += TICK_DT;
        world.tick(now);
        world.flushEvents();
      }
    };
    return { world, run };
  }

  it('fill the room only while people are playing and make way for them', () => {
    const { world, run } = botWorld();
    run(5000);
    expect(world.players.size).toBe(0);
    const human = world.join('Human', 'archer');
    run(10_000);
    expect([...world.players.values()].filter((p) => p.bot).length).toBe(5);
    world.join('Friend', 'mage');
    run(100);
    expect([...world.players.values()].filter((p) => p.bot).length).toBe(4);
    world.leave(human.id);
    run(10_000);
    expect(world.players.size).toBe(6);
  });

  it('always include Jamukha, even in a full room', () => {
    const { world, run } = botWorld();
    const people = Array.from({ length: 8 }, (_, i) => world.join(`P${i}`, 'archer'));
    run(5000);
    const bots = [...world.players.values()].filter((p) => p.bot);
    expect(bots.map((p) => p.name)).toEqual(['Jamukha']);
    for (const p of people.slice(1)) world.leave(p.id);
    run(10_000);
    expect([...world.players.values()].filter((p) => p.bot && p.name === 'Jamukha').length).toBe(1);
  });

  it('roam, fight bogs and each other, and respawn', () => {
    const { world, run } = botWorld();
    const human = world.join('Human', 'warrior');
    human.shieldUntil = Infinity;
    const start = new Map<number, { x: number; y: number }>();
    run(8000);
    for (const p of world.players.values()) if (p.bot) start.set(p.id, { x: p.body.x, y: p.body.y });
    run(90_000);
    const bots = [...world.players.values()].filter((p) => p.bot);
    const moved = bots.filter((p) => {
      const s = start.get(p.id);
      return !s || Math.hypot(p.body.x - s.x, p.body.y - s.y) > 200 || p.deaths > 0;
    });
    expect(moved.length).toBeGreaterThanOrEqual(4);
    expect(bots.reduce((n, p) => n + p.bogs, 0)).toBeGreaterThan(3);
    expect(bots.reduce((n, p) => n + p.kills, 0)).toBeGreaterThan(0);
    expect(bots.every((p) => p.alive || world.now - p.respawnAt < 4000)).toBe(true);
  });
});
