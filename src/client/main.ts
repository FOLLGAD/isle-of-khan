import { isClassId, type ClassId } from '../shared/classes';
import { NAME_MAX } from '../shared/constants';
import { loadAssets } from './assets';
import { audio } from './audio';
import { Game } from './game';
import { classCards, Hud } from './hud';
import { Controls, isTouch } from './input';
import { Connection } from './net';
import { Renderer } from './renderer';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ROOM_RE = /^[a-z0-9]{4,12}$/;
const stored = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Private browsing; the menu just won't remember.
  }
};

async function main() {
  if (isTouch) document.body.classList.add('touch');
  await loadAssets();
  const canvas = $<HTMLCanvasElement>('game');
  const renderer = new Renderer(canvas);
  const controls = new Controls(canvas);
  let game: Game | null = null;
  let cls: ClassId = isClassId(stored('iok.class')) ? (stored('iok.class') as ClassId) : 'archer';
  let room: string | null = new URLSearchParams(location.search).get('room')?.toLowerCase() ?? null;
  if (room && !ROOM_RE.test(room)) room = null;

  const hud = new Hud({
    respawn: (c) => game?.respawn(c),
    chat: (m) => game?.chat(m),
    leave: () => leave(),
    reconnect: () => {
      leave();
      void start();
    },
    setChatOpen: (open) => {
      if (game) game.chatOpen = open;
      if (open) controls.release();
    },
    toggleMute: () => audio.toggleMute(),
    isMuted: () => audio.muted,
  });

  // --- title screen --------------------------------------------------------------------------
  const nameInput = $<HTMLInputElement>('name');
  nameInput.maxLength = NAME_MAX;
  nameInput.value = stored('iok.name') ?? '';
  classCards($('menu-classes'), cls, (c) => {
    cls = c;
    store('iok.class', c);
    audio.unlock();
    audio.play('click', 0.6);
  });
  const updateRoomNote = () => {
    $('room-note').innerHTML = room ? `Joining private room <b>${room}</b>` : '';
    $('play').textContent = room ? 'Join room' : 'Enter Game';
    $('play-friends').hidden = !!room;
  };
  updateRoomNote();
  $('menu-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void start();
  });
  $('play-friends').addEventListener('click', () => {
    room = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    void start();
  });
  const refreshOnline = () =>
    fetch('/api/stats')
      .then((r) => r.json() as Promise<{ online: number }>)
      .then(({ online }) => ($('online').textContent = online === 1 ? '1 player on the isle' : `${online} players on the isle`))
      .catch(() => ($('online').textContent = ''));
  refreshOnline();
  setInterval(() => !game && refreshOnline(), 10_000);

  // The title screen floats over the island itself.
  const backdrop = (t: number) => {
    if (game) return;
    requestAnimationFrame(backdrop);
    const focus = { x: 2900 + Math.cos(t / 21000) * 1100, y: 2900 + Math.sin(t / 15000) * 900 };
    renderer.draw({ focus, time: t, players: [], mobs: [], projs: [], bombs: [], hearts: [], me: null, wizardLine: null }, null);
  };
  requestAnimationFrame(backdrop);

  async function start() {
    audio.unlock();
    const name = nameInput.value.trim();
    store('iok.name', name);
    const err = $('menu-error');
    err.textContent = '';
    const buttons = [$<HTMLButtonElement>('play'), $<HTMLButtonElement>('play-friends')];
    buttons.forEach((b) => (b.disabled = true));
    $('play').textContent = 'Setting sail…';
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const target = room ?? ((await (await fetch('/api/match')).json()) as { room: string }).room;
        const res = await Connection.open(target, name, cls);
        if (res === 'full') {
          if (room) throw new Error('That room is full.');
          continue;
        }
        return enter(res.conn, res.welcome);
      }
      throw new Error('Every isle is full right now. Try again in a moment.');
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      updateRoomNote();
    }
  }

  function enter(conn: Connection, welcome: { id: number; room: string; private: boolean }) {
    if (welcome.private) history.replaceState(null, '', `?room=${welcome.room}`);
    $('menu').hidden = true;
    document.body.classList.add('in-game');
    controls.enabled = true;
    canvas.focus();
    const invite = welcome.private ? `${location.origin}/?room=${welcome.room}` : '';
    hud.show(welcome.id, invite, welcome.private);
    game = new Game(welcome.id, cls, welcome.room, welcome.private, conn, renderer, controls, hud);
    conn.onClose = () => {
      controls.enabled = false;
      hud.disconnected();
    };
  }

  function leave() {
    game?.stop();
    game = null;
    hud.hide();
    controls.enabled = false;
    controls.release();
    document.body.classList.remove('in-game');
    $('menu').hidden = false;
    requestAnimationFrame(backdrop);
    refreshOnline();
  }
}

main().catch((e) => {
  console.error(e);
  document.body.textContent = `Isle of Khan failed to start: ${e instanceof Error ? e.message : e}`;
});
