/** World pixels per map tile. Source art is 8px per tile, drawn 8x. */
export const TILE = 64;
/** World pixels per source-art pixel. */
export const PX = 8;

/** Player movement is simulated in fixed steps, identically on client and server. */
export const SIM_HZ = 60;
export const SIM_DT = 1000 / SIM_HZ;
/** The server advances the world (projectiles, bogs, pickups) and sends snapshots at this rate. */
export const TICK_HZ = 30;
export const TICK_DT = 1000 / TICK_HZ;
/** Remote entities are drawn this far in the past so there are always two snapshots to blend. */
export const INTERP_DELAY = 100;

export const MAX_PLAYERS = 16;
export const NAME_MAX = 16;
export const CHAT_MAX = 120;

export const ROUND_MS = 5 * 60_000;
export const INTERMISSION_MS = 10_000;
export const RESPAWN_MS = 3_000;
export const SPAWN_SHIELD_MS = 2_000;

/** Player collision box (feet), as half sizes around the player position. */
export const PLAYER_HW = 18;
export const PLAYER_HH = 12;
/** Player hurt box: covers the full 64x128 sprite minus some air. Relative to the player position. */
export const HURT = { left: -24, right: 24, top: -100, bottom: 14 };

export const SCORE = { kill: 3, khanBonus: 2, bog: 1, bigBog: 2, suicide: -1 };

export const enum Key {
  Up = 1,
  Down = 2,
  Left = 4,
  Right = 8,
  Primary = 16,
  Secondary = 32,
  Special = 64,
}
