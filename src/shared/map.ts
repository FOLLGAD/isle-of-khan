import island from '../../map/island.json';
import { TILE } from './constants';

/** Tile ids (Tiled gids) that matter to gameplay. The rest are decorative grass/stone variants. */
export const WATER = 8;

export interface GameMap {
  w: number;
  h: number;
  /** Tiled gid per tile, row-major. */
  tiles: Uint8Array;
  /** 1 where walkers (players, bogs, bombs) can't go: water, tree trunks, the wizard. */
  walk: Uint8Array;
  /** 1 where projectiles stop: tree trunks. Arrows fly over water. */
  shot: Uint8Array;
  /** Tree trunk tiles; the crown is drawn one tile above. */
  trees: { tx: number; ty: number }[];
  /** Where the wizard stands, in world px (feet). */
  wizard: { x: number; y: number };
}

interface TiledMap {
  width: number;
  height: number;
  layers: { type: string; data?: number[]; objects?: { x: number; y: number }[] }[];
}

export function loadMap(src: TiledMap = island as TiledMap): GameMap {
  const { width: w, height: h } = src;
  const data = src.layers.find((l) => l.type === 'tilelayer')!.data!;
  const objects = src.layers.find((l) => l.type === 'objectgroup')!.objects!;
  const tiles = Uint8Array.from(data);
  const walk = new Uint8Array(w * h);
  const shot = new Uint8Array(w * h);
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === WATER) walk[i] = 1;
  // Tiled tile objects are anchored bottom-left in 8px source units; the trunk is the lower tile.
  const trees = objects.map((o) => ({ tx: o.x / 8, ty: o.y / 8 - 1 }));
  for (const t of trees) walk[t.ty * w + t.tx] = shot[t.ty * w + t.tx] = 1;
  const wizardTile = { tx: 44, ty: 47 };
  walk[wizardTile.ty * w + wizardTile.tx] = 1;
  return {
    w, h, tiles, walk, shot, trees,
    wizard: { x: (wizardTile.tx + 0.5) * TILE, y: (wizardTile.ty + 1) * TILE - 6 },
  };
}

export const MAP = loadMap();

const blockedAt = (grid: Uint8Array, m: GameMap, tx: number, ty: number) =>
  tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || grid[ty * m.w + tx] === 1;

export const walkBlocked = (m: GameMap, tx: number, ty: number) => blockedAt(m.walk, m, tx, ty);
export const shotBlocked = (m: GameMap, wx: number, wy: number) =>
  blockedAt(m.shot, m, Math.floor(wx / TILE), Math.floor(wy / TILE));

/** True if the axis-aligned box [x0,x1)x[y0,y1) overlaps any walk-blocking tile. */
export function boxBlocked(m: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x1 - 0.001) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y1 - 0.001) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (walkBlocked(m, tx, ty)) return true;
  return false;
}

export interface Box { x: number; y: number }

/**
 * Moves a box (center x/y, half sizes hw/hh) by dx/dy, resolving each axis separately so bodies
 * slide along walls. Returns which axes were stopped.
 */
export function moveBox(m: GameMap, b: Box, hw: number, hh: number, dx: number, dy: number) {
  let hitX = false, hitY = false;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 16));
  const sx = dx / n, sy = dy / n;
  for (let i = 0; i < n; i++) {
    if (sx !== 0 && !hitX) {
      const nx = b.x + sx;
      if (boxBlocked(m, nx - hw, b.y - hh, nx + hw, b.y + hh)) {
        // Snap flush against the tile edge we ran into.
        b.x = sx > 0 ? Math.floor((nx + hw) / TILE) * TILE - hw - 0.01 : Math.ceil((nx - hw) / TILE) * TILE + hw + 0.01;
        if (boxBlocked(m, b.x - hw, b.y - hh, b.x + hw, b.y + hh)) b.x = nx - sx;
        hitX = true;
      } else b.x = nx;
    }
    if (sy !== 0 && !hitY) {
      const ny = b.y + sy;
      if (boxBlocked(m, b.x - hw, ny - hh, b.x + hw, ny + hh)) {
        b.y = sy > 0 ? Math.floor((ny + hh) / TILE) * TILE - hh - 0.01 : Math.ceil((ny - hh) / TILE) * TILE + hh + 0.01;
        if (boxBlocked(m, b.x - hw, b.y - hh, b.x + hw, b.y + hh)) b.y = ny - sy;
        hitY = true;
      } else b.y = ny;
    }
  }
  return { hitX, hitY };
}

/** A random walkable spot for a box of the given half sizes, centered in a tile. */
export function randomSpot(m: GameMap, rand: () => number, hw: number, hh: number, avoid?: (x: number, y: number) => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const tx = Math.floor(rand() * m.w), ty = Math.floor(rand() * m.h);
    const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
    if (boxBlocked(m, x - hw - 8, y - hh - 8, x + hw + 8, y + hh + 8)) continue;
    if (avoid?.(x, y)) continue;
    return { x, y };
  }
  return { x: m.wizard.x, y: m.wizard.y + TILE };
}
