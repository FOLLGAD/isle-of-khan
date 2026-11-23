import type { ClassId } from '../shared/classes';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

/** One WebSocket to a room. Messages that arrive before a handler is attached are kept. */
export class Connection {
  private backlog: ServerMsg[] = [];
  private handler: ((msg: ServerMsg) => void) | null = null;
  onClose: (() => void) | null = null;
  rtt = 0;
  private pingTimer: ReturnType<typeof setInterval>;

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      if (msg.t === 'pong') {
        const sample = performance.now() - msg.c;
        this.rtt = this.rtt ? this.rtt * 0.8 + sample * 0.2 : sample;
        return;
      }
      if (this.handler) this.handler(msg);
      else this.backlog.push(msg);
    });
    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      this.onClose?.();
    });
    this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now(), rtt: this.rtt }), 2000);
    this.send({ t: 'ping', c: performance.now(), rtt: 0 });
  }

  /** Connects and waits for the room's welcome (or a "room full" answer). */
  static open(room: string, name: string, cls: ClassId): Promise<{ conn: Connection; welcome: Extract<ServerMsg, { t: 'welcome' }> } | 'full'> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ room, name, cls });
    const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    return new Promise((resolve, reject) => {
      const first = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data as string) as ServerMsg;
        ws.removeEventListener('message', first);
        ws.removeEventListener('close', failed);
        if (msg.t === 'full') return resolve('full');
        if (msg.t !== 'welcome') return reject(new Error(`Unexpected ${msg.t}`));
        resolve({ conn: new Connection(ws), welcome: msg });
      };
      const failed = () => reject(new Error('Could not reach the isle'));
      ws.addEventListener('message', first);
      ws.addEventListener('close', failed);
    });
  }

  listen(handler: (msg: ServerMsg) => void) {
    this.handler = handler;
    for (const m of this.backlog.splice(0)) handler(m);
  }

  send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.onClose = null;
    clearInterval(this.pingTimer);
    this.ws.close();
  }
}
