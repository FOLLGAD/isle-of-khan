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
- **Play with friends** creates a private room. Share the link from the Esc menu.

## Development

```sh
npm install
npm run dev        # game + Worker + Durable Objects at http://localhost:5173
npm test           # world logic tests
npm run typecheck
```

`npm run dev` runs the real Worker and Durable Objects locally in workerd through the Cloudflare Vite plugin, so multiplayer works across browser tabs.

## Deploying to Cloudflare

```sh
npx wrangler login
npm run deploy     # builds, then runs wrangler deploy
```

Durable Objects use the SQLite storage backend, so this works on the Workers free plan. You can also connect this repository in the Cloudflare dashboard (Workers & Pages, then Import a repository) with build command `npm run build` and deploy command `npx wrangler deploy`.

## How it works

- `src/shared`: code that runs on both sides. The map loader (`map/island.json` is the original Tiled map), class stats, the wire protocol, and the fixed-step player movement simulation.
- `src/server`: the Worker entry, a `Lobby` Durable Object that puts quick-play players into the fullest public room with space, and a `GameRoom` Durable Object per island. Each room keeps its `World` in memory and runs it at 30 Hz while anyone is connected. Rooms hold up to 16 players.
- `src/client`: canvas renderer, HUD, input and networking. Your own movement is predicted locally and reconciled with the server; other players, bogs and projectiles are drawn 100 ms behind and interpolated.
- `public/assets`: the original sprites, sounds and font, plus a mage sprite sheet (a palette swap of the archer, since the original was never finished) and a few small new sprites: crown, orb, staff and ability icons.
- `art/`: the original Paint.NET source files.
