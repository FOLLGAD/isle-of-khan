import { SIM_HZ } from './constants';

export type ClassId = 'archer' | 'warrior' | 'mage';
export const CLASS_IDS: ClassId[] = ['archer', 'warrior', 'mage'];

const steps = (ms: number) => Math.round((ms / 1000) * SIM_HZ);

export interface ClassDef {
  name: string;
  hp: number;
  /** px per ms */
  speed: number;
  primary: { name: string; cd: number; desc: string };
  special: { kind: 'dash' | 'spin' | 'blink'; name: string; cd: number; desc: string };
}

export const BOMB_CD = steps(4000);
/** Movement is slowed for this long after using the primary attack. */
export const ATTACK_SLOW = steps(250);
export const DASH_STEPS = steps(160);
export const DASH_SPEED = 1.5;
export const BLINK_RANGE = 330;

export const CLASSES: Record<ClassId, ClassDef> = {
  archer: {
    name: 'Archer',
    hp: 100,
    speed: 0.43,
    primary: { name: 'Bow', cd: steps(480), desc: 'Hold to loose arrows' },
    special: { kind: 'dash', name: 'Dash', cd: steps(6000), desc: 'Burst of speed' },
  },
  warrior: {
    name: 'Warrior',
    hp: 200,
    speed: 0.44,
    primary: { name: 'Sword', cd: steps(520), desc: 'Wide cleave, heavy knockback' },
    special: { kind: 'spin', name: 'Whirlwind', cd: steps(6000), desc: 'Hits everything around you' },
  },
  mage: {
    name: 'Mage',
    hp: 100,
    speed: 0.43,
    primary: { name: 'Arcane orb', cd: steps(680), desc: 'Slow orb that bursts on impact' },
    special: { kind: 'blink', name: 'Blink', cd: steps(6000), desc: 'Teleport toward the cursor' },
  },
};

/** Projectile stats, shared by the server, the client's predicted shots and the bots' aim. */
export const ARROW = { speed: 1.25, ttl: 600, dmg: 16, knock: 0.5 };
export const ORB = { speed: 0.9, ttl: 950, dmg: 28, knock: 0.7, splash: 90, splashDmg: 16 };

export const isClassId = (v: unknown): v is ClassId => typeof v === 'string' && v in CLASSES;
