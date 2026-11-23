import { DurableObject } from 'cloudflare:workers';
import { MAX_PLAYERS, TICK_DT } from '../shared/constants';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { World } from './world';
import type { Env } from './worker';

/**
 * One island. Holds the authoritative world in memory and runs the game loop while anyone is
 * connected; when the last player leaves the loop stops and the object is free to be evicted.
 */
export class GameRoom extends DurableObject<Env> {
  private world: World | null = null;
  private sockets = new Map<number, WebSocket>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private room = '';
  private isPrivate = false;
  private lastReport = 0;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(req.url);
    this.room = url.searchParams.get('room') ?? '';
    this.isPrivate = !this.room.startsWith('pub-');
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (this.sockets.size >= MAX_PLAYERS) {
      this.sendTo(server, { t: 'full' });
      server.close(4001, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.world) this.start();
    const world = this.world!;
    const player = world.join(url.searchParams.get('name'), url.searchParams.get('cls'));
    this.sockets.set(player.id, server);
    this.sendTo(server, { t: 'welcome', id: player.id, room: this.room, private: this.isPrivate });
    this.sendTo(server, world.roundMsg());

    server.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 4096) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') world.handle(player.id, msg);
    });
    const drop = () => this.drop(player.id);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    this.reportToLobby();
    return new Response(null, { status: 101, webSocket: client });
  }

  private start() {
    this.world = new World(
      {
        send: (id, msg) => {
          const ws = this.sockets.get(id);
          if (ws) this.sendTo(ws, msg);
        },
        broadcast: (msg) => {
          const data = JSON.stringify(msg);
          for (const ws of this.sockets.values()) this.sendRaw(ws, data);
        },
      },
      Date.now(),
    );
    this.loop = setInterval(() => this.tick(), TICK_DT);
  }

  private tick() {
    const world = this.world;
    if (!world) return;
    world.tick(Date.now());
    for (const [id, ws] of this.sockets) {
      const snap = world.snapshot(id);
      if (snap) this.sendTo(ws, snap);
    }
    world.flushEvents();
    // Periodic reports let the lobby recover its picture of the world if it gets evicted.
    if (Date.now() - this.lastReport > 20_000) this.reportToLobby();
  }

  private drop(id: number) {
    if (!this.sockets.delete(id)) return;
    this.world?.leave(id);
    if (this.sockets.size === 0) {
      if (this.loop) clearInterval(this.loop);
      this.loop = null;
      this.world = null;
    }
    this.reportToLobby();
  }

  private sendTo(ws: WebSocket, msg: ServerMsg) {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, data: string) {
    try {
      ws.send(data);
    } catch {
      // The close handler cleans this socket up.
    }
  }

  private reportToLobby() {
    this.lastReport = Date.now();
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
    this.ctx.waitUntil(lobby.report(this.room, this.sockets.size, this.isPrivate).catch((e) => console.error('lobby report failed', e)));
  }
}
