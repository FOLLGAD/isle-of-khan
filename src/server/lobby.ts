import { DurableObject } from 'cloudflare:workers';
import { MAX_PLAYERS } from '../shared/constants';

/** Matchmaking fills public rooms to this size, leaving space for friends joining by link. */
const SOFT_CAP = MAX_PLAYERS - 4;
const RESERVATION_MS = 15_000;

interface RoomInfo {
  count: number;
  private: boolean;
  /** Times of recent assignments that haven't shown up in a report yet. */
  reserved: number[];
}

/** Tracks how full each room is so quick-play puts people together instead of alone. */
export class Lobby extends DurableObject {
  private rooms = new Map<string, RoomInfo>();

  async assign(): Promise<string> {
    const now = Date.now();
    let best: string | null = null, bestLoad = -1;
    for (const [name, r] of this.rooms) {
      r.reserved = r.reserved.filter((t) => now - t < RESERVATION_MS);
      const load = r.count + r.reserved.length;
      if (r.private || load >= SOFT_CAP) continue;
      if (load > bestLoad) (best = name), (bestLoad = load);
    }
    if (!best) {
      let n = 1;
      while (this.rooms.has(`pub-${n}`)) n++;
      best = `pub-${n}`;
      this.rooms.set(best, { count: 0, private: false, reserved: [] });
    }
    this.rooms.get(best)!.reserved.push(now);
    return best;
  }

  async report(room: string, count: number, isPrivate: boolean) {
    const r = this.rooms.get(room);
    if (count === 0 && !r?.reserved.length) return void this.rooms.delete(room);
    if (r) {
      // A join consumes the oldest reservation.
      if (count > r.count) r.reserved.splice(0, count - r.count);
      r.count = count;
    } else this.rooms.set(room, { count, private: isPrivate, reserved: [] });
  }

  async stats() {
    let online = 0;
    for (const r of this.rooms.values()) online += r.count;
    return { online };
  }
}
