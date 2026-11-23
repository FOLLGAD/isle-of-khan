import type { GameRoom } from './room';
import type { Lobby } from './lobby';

export { GameRoom } from './room';
export { Lobby } from './lobby';

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  LOBBY: DurableObjectNamespace<Lobby>;
}

/** Public rooms are handed out by the lobby; private ones are any short lowercase code. */
const ROOM_RE = /^(pub-\d{1,4}|[a-z0-9]{4,12})$/;

const json = (data: unknown) => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const lobby = () => env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    switch (url.pathname) {
      case '/api/match':
        return json({ room: await lobby().assign() });
      case '/api/stats':
        return json(await lobby().stats());
      case '/ws': {
        const room = url.searchParams.get('room') ?? '';
        if (!ROOM_RE.test(room)) return new Response('Bad room', { status: 400 });
        return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
      }
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
