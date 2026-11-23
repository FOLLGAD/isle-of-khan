# Isle of Khan

A multiplayer pixel-art brawler. Wash up on the isle as an **Archer**, **Warrior** or **Mage**, fight the bogs and each other, and take the Khan's crown.

Originally made in 2016 with Node and socket.io; rebuilt from scratch in 2026 to run on Cloudflare.

## How to play

| Input | Action |
| --- | --- |
| WASD / arrows | Move |
| Mouse | Aim |
| Left mouse (hold) | Attack: bow, sword or arcane orb |
| Right mouse / Q / E | Lob a bomb toward the cursor (mind the blast) |
| Space / Shift | Class power: Dash, Whirlwind or Blink |
| Tab | Scoreboard |
| Enter | Chat |
| Esc | Menu: invite link, sound, leave |
| M | Mute |

On phones and tablets: the left stick moves, the right stick aims and fires, and the buttons throw bombs and use your power.

- Killing a player is worth 3 glory, a bog 1, a big bog 2. Blowing yourself up costs 1.
- Whoever has the most glory is **the Khan** and wears the crown. Killing the Khan is worth 2 extra glory.
- Rounds last 5 minutes. The leader at the end is Khan of the Isle, then everything resets.
- Hearts heal 25 HP. Bogs sometimes drop them, and so does everyone who dies.
- **Coins** drop from bogs (big bogs drop more), lie around the isle, and are paid as a bounty for kills (more for the Khan). When you die, half your purse spills on the ground for anyone to grab.
- **The wizard's shop:** stand next to the wizard in the plaza and press 1-4 (or click) to buy upgrades that last until the round ends: a sharpened weapon (+10% damage per level), thick hide (+20 max HP per level), black powder (bigger, stronger bombs) and a healing draught. Bots shop too.
- **Samuel** shows up every few minutes: a small, fast thief who goes for the fattest purse, steals coins and runs. Catch him to get the stolen coins back plus a bonus. (He's the unused `Samenemy.pdn` enemy from 2016, finally on the isle.)
- A **ford** of shallow water joins the southern crescent's east tip to the mainland. You wade slowly through it.
- **Play with friends** creates a private room. Share the link from the Esc menu.
- Bots keep every room lively: while anyone is playing, the room is topped up to 6 fighters with bots, and they step aside as people join. They play by the same rules as you (same inputs, cooldowns and hitboxes) and see the world with a human-like delay and reaction time, so they don't have superhuman reflexes. They're tagged BOT on the scoreboard.

## Classes

| | Archer | Warrior | Mage |
| --- | --- | --- | --- |
| HP | 100 | 200 | 100 |
| Primary (hold LMB) | Bow: longest range, a little less accurate on the run | Sword: wide cleave with heavy knockback | Arcane orb: slow, bursts on impact and splashes nearby enemies |
| Secondary (RMB) | Bombs | Bombs | Bombs |
| Special (Space) | Dash | Whirlwind: hits everything around you | Blink toward the cursor, even across water |

HP and loadouts follow the original 2016 class menu. The classes are balanced so that, played well, each wins about as often as it loses overall, with rock-paper-scissors matchups: archers kite warriors, warriors run down mages, and mage splash punishes archers. The mage's look (yellow pointed hat, blue cloak) comes from the unfinished 2016 mage sheet, completed in all four directions.

## Development

```sh
npm install
npm run dev        # game + Worker + Durable Objects at http://localhost:5173
npm test           # world logic tests
npm run typecheck
```

`npm run dev` runs the real Worker and Durable Objects locally in workerd through the Cloudflare Vite plugin, so multiplayer works across browser tabs.

### Bots and balance

```sh
npm run arena -- 10     # play 10 simulated bot rounds, print per-class results
npm run train -- 30 2   # tune bot tactics per class in self-play; prints a new TACTICS table
npm run balance -- 80   # per-class kill/death with 95% intervals, plus head-to-head matchups
```

Bot tactics live in `TACTICS` in `src/server/bot.ts` and class stats in `src/shared/classes.ts` and `src/server/world.ts`. After changing a class, retrain and re-run the balance check.

## Deploying to Cloudflare

```sh
npx wrangler login
npm run deploy     # builds, then runs wrangler deploy to isle-of-khan.emil.zip
```

Durable Objects use the SQLite storage backend, so this works on the Workers free plan. You can also connect this repository in the Cloudflare dashboard (Workers & Pages, then Import a repository) with build command `npm run build` and deploy command `npx wrangler deploy`.

## How it works

- `src/shared`: code that runs on both sides. The map loader (`map/island.json` is the original Tiled map), class stats, the wire protocol, and the fixed-step player movement simulation.
- `src/server`: the Worker entry, a `Lobby` Durable Object that puts quick-play players into the fullest public room with space, and a `GameRoom` Durable Object per island. Each room keeps its `World` in memory and runs it at 30 Hz while anyone is connected. Rooms hold up to 16 players.
- `src/client`: canvas renderer, HUD, input and networking. Your own movement is predicted locally and reconciled with the server; other players, bogs and projectiles are drawn 100 ms behind and interpolated.
- `src/server/bot.ts`: bot players. Each tick a bot looks at the world and decides which keys to hold and where to aim, then the world runs that through the same input path as a human's.
- `public/assets`: the original sprites, sounds and font, plus the finished mage sheet and a few small new sprites: crown, orb, staff and ability icons.
- `art/`: the original Paint.NET source files.
