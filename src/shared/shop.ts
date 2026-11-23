import { CLASSES, type ClassId } from './classes';

/** The wizard's wares. Upgrades last until the end of the round. */
export type ItemId = 'weapon' | 'armor' | 'powder' | 'potion';
export interface Item {
  id: ItemId;
  name: string;
  desc: string;
  /** Price of each level; the potion has one price and can be bought again and again. */
  costs: number[];
}
export const ITEMS: Item[] = [
  { id: 'weapon', name: 'Sharpened weapon', desc: '+10% damage', costs: [6, 10, 16] },
  { id: 'armor', name: 'Thick hide', desc: '+20 max HP', costs: [6, 10, 16] },
  { id: 'powder', name: 'Black powder', desc: 'Bigger, stronger bombs', costs: [5, 9] },
  { id: 'potion', name: 'Healing draught', desc: 'Heal to full', costs: [4] },
];
export const isItemId = (v: unknown): v is ItemId => ITEMS.some((i) => i.id === v);

export interface Upgrades {
  weapon: number;
  armor: number;
  powder: number;
}
export const noUpgrades = (): Upgrades => ({ weapon: 0, armor: 0, powder: 0 });

/** How close to the wizard you must stand to trade (world px). */
export const SHOP_RANGE = 220;

export const weaponMul = (u: Upgrades) => 1 + 0.1 * u.weapon;
export const powderMul = (u: Upgrades) => 1 + 0.2 * u.powder;
export const maxHp = (cls: ClassId, u: Upgrades) => CLASSES[cls].hp + 20 * u.armor;

/** What buying `id` next costs, or null if it's maxed out. */
export function priceOf(id: ItemId, u: Upgrades): number | null {
  const item = ITEMS.find((i) => i.id === id)!;
  if (id === 'potion') return item.costs[0];
  return item.costs[u[id]] ?? null;
}

/** Hit points of each kind of monster; the client needs them for health bars. */
export const MOB_HP = { bog: 45, big: 120, sam: 70 } as const;
export type MobKind = keyof typeof MOB_HP;
