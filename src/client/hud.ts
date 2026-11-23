import { BOMB_CD, CLASS_IDS, CLASSES, type ClassId } from '../shared/classes';
import { TILE } from '../shared/constants';
import { MAP } from '../shared/map';
import type { KillHow, RoundResult } from '../shared/protocol';
import { ITEMS, priceOf, type ItemId } from '../shared/shop';
import { escapeHtml, type Game, type RosterInfo } from './game';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Minimap colors per tile, as in the original game. */
const TILE_COLORS: Record<number, string> = { 7: '#0075FD', 14: '#603000', 6: '#11A033', 15: '#4FA0FF' };
const tileColor = (gid: number) => TILE_COLORS[gid - 1] ?? ([3, 4, 5, 11, 12, 13, 19, 20, 21].includes(gid - 1) ? '#8FA3A2' : '#11A033');

export const PRIMARY_ICON: Record<ClassId, string> = { archer: 'arrow', warrior: 'short-sword', mage: 'bolt' };
export const SPECIAL_ICON: Record<string, string> = { dash: 'icon-dash', spin: 'icon-spin', blink: 'icon-blink' };
const HOW: Record<KillHow, string> = { arrow: 'shot', sword: 'cut down', orb: 'blasted', bomb: 'blew up', spin: 'whirled down', bog: 'ate', sam: 'mugged' };
const ITEM_ICON: Record<ItemId, string> = { weapon: '', armor: 'icon-armor', powder: 'bomb', potion: 'icon-potion' };

/** Class picker cards; used on the title screen and the death screen. */
export function classCards(root: HTMLElement, selected: ClassId, onPick: (c: ClassId) => void, compact = false) {
  root.innerHTML = '';
  for (const id of CLASS_IDS) {
    const c = CLASSES[id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `class-card${id === selected ? ' selected' : ''}${compact ? ' compact' : ''}`;
    card.dataset.cls = id;
    card.innerHTML = `
      <img src="/assets/sprites/${id}-menu.png" alt="">
      <div class="overlay">
        <h2>${c.name}</h2>
        <div class="desc">
          <span class="red">HP:</span> ${c.hp}<br>
          <span class="green">Primary:</span> ${c.primary.name}<br>
          <span class="yellow">Secondary:</span> Bombs<br>
          <span class="blue">Special:</span> ${c.special.name}
        </div>
      </div>
      <span class="label">${c.name}</span>`;
    card.addEventListener('click', () => {
      root.querySelectorAll('.class-card').forEach((el) => el.classList.toggle('selected', el === card));
      onPick(id);
    });
    root.appendChild(card);
  }
}

export interface HudActions {
  respawn(cls: ClassId): void;
  buy(item: ItemId): void;
  chat(m: string): void;
  leave(): void;
  reconnect(): void;
  setChatOpen(open: boolean): void;
  toggleMute(): boolean;
  isMuted(): boolean;
}

export class Hud {
  private minimapBase: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private lastMinimap = 0;
  private bigQueue: string[] = [];
  private bigBusy = false;
  private roundEndsAt = 0;
  private roundPhase: 'play' | 'end' = 'play';
  private respawnAt = 0;
  private deathCls: ClassId = 'archer';
  private players: RosterInfo[] = [];
  private khan = 0;
  private myId = 0;
  private debug = false;
  private fps = 0;
  private lastFrame = 0;
  private slotCls: ClassId | null = null;
  private shopKey = '';
  private atShop = false;
  inviteUrl = '';

  constructor(private actions: HudActions) {
    const mm = $<HTMLCanvasElement>('minimap');
    this.minimapCtx = mm.getContext('2d')!;
    this.minimapBase = document.createElement('canvas');
    this.minimapBase.width = this.minimapBase.height = MAP.w * 2;
    const g = this.minimapBase.getContext('2d')!;
    for (let ty = 0; ty < MAP.h; ty++) for (let tx = 0; tx < MAP.w; tx++) {
      g.fillStyle = tileColor(MAP.tiles[ty * MAP.w + tx]);
      g.fillRect(tx * 2, ty * 2, 2, 2);
    }
    g.fillStyle = '#006818';
    for (const t of MAP.trees) g.fillRect(t.tx * 2, t.ty * 2, 2, 2);

    const input = $<HTMLInputElement>('chat-input');
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const m = input.value.trim();
      if (m) this.actions.chat(m);
      input.value = '';
      input.blur();
    });
    input.addEventListener('focus', () => (document.body.classList.add('chatting'), this.actions.setChatOpen(true)));
    input.addEventListener('blur', () => (document.body.classList.remove('chatting'), this.actions.setChatOpen(false)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') input.blur();
      e.stopPropagation();
    });

    addEventListener('keydown', (e) => {
      if (!this.active || e.target instanceof HTMLInputElement) return;
      if (e.code === 'Tab') {
        e.preventDefault();
        this.renderScoreboard();
        $('scoreboard').hidden = false;
      } else if (e.code === 'Enter') {
        e.preventDefault();
        input.focus();
      } else if (e.code === 'Escape') {
        this.togglePause();
      } else if (e.code === 'KeyM') {
        this.updateMuteLabel(this.actions.toggleMute());
      } else if (e.code === 'Backquote') {
        this.debug = !this.debug;
        $('debug').hidden = !this.debug;
      } else if (this.atShop && /^Digit[1-4]$/.test(e.code)) {
        this.actions.buy(ITEMS[Number(e.code.slice(5)) - 1].id);
      } else if (e.code === 'Space' && !$('death').hidden) {
        if (performance.now() >= this.respawnAt) this.actions.respawn(this.deathCls);
      }
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'Tab') $('scoreboard').hidden = true;
    });
    $('respawn').addEventListener('click', () => this.actions.respawn(this.deathCls));
    $('resume').addEventListener('click', () => this.togglePause());
    $('leave').addEventListener('click', () => this.actions.leave());
    $('reconnect').addEventListener('click', () => this.actions.reconnect());
    $('mute').addEventListener('click', () => this.updateMuteLabel(this.actions.toggleMute()));
    $('invite').addEventListener('click', () => this.copyInvite());
    $('menu-button').addEventListener('click', () => this.togglePause());
    $('chat-button').addEventListener('click', () => input.focus());
    $('shop').addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item;
      if (id) this.actions.buy(id as ItemId);
    });
    this.updateMuteLabel(this.actions.isMuted());
  }

  active = false;

  show(myId: number, inviteUrl: string, isPrivate: boolean) {
    this.myId = myId;
    this.inviteUrl = inviteUrl;
    this.active = true;
    $('hud').hidden = false;
    $('chat-list').innerHTML = '';
    $('feed').innerHTML = '';
    for (const id of ['death', 'round-end', 'pause', 'disconnected', 'scoreboard']) $(id).hidden = true;
    if (isPrivate) this.chat(null, `You're in a private room. Press ESC to copy the invite link for your friends.`);
  }

  hide() {
    this.active = false;
    $('hud').hidden = true;
  }

  disconnected() {
    $('disconnected').hidden = false;
  }

  // --- feeds ---------------------------------------------------------------------------------

  chat(from: string | null, m: string) {
    const li = document.createElement('li');
    if (from === null) li.innerHTML = `<span class="system">${escapeHtml(m)}</span>`;
    else li.innerHTML = `<span class="from">&lt;${escapeHtml(from)}&gt;</span> ${escapeHtml(m)}`;
    const list = $('chat-list');
    list.appendChild(li);
    while (list.children.length > 40) list.firstElementChild!.remove();
    list.scrollTop = list.scrollHeight;
    setTimeout(() => li.classList.add('old'), 12_000);
  }

  kill(killer: string | null, victim: string, how: KillHow, mine: boolean, iKilled: boolean) {
    const k = killer ? escapeHtml(killer[0].toUpperCase() + killer.slice(1)) : null, v = escapeHtml(victim);
    const line = k ? `<span class="green">${k}</span> ${HOW[how]} <span class="red">${v}</span>` : `<span class="red">${v}</span> blew themselves up`;
    const li = document.createElement('li');
    li.innerHTML = line;
    $('feed').prepend(li);
    while ($('feed').children.length > 5) $('feed').lastElementChild!.remove();
    setTimeout(() => li.remove(), 7000);
    if (mine) this.big(iKilled ? `You ${HOW[how]} <span class="red">${v}</span>` : line);
  }

  /** The big centered messages from the original game, one at a time. */
  big(html: string) {
    this.bigQueue.push(html);
    if (this.bigQueue.length > 4) this.bigQueue.splice(0, this.bigQueue.length - 4);
    this.nextBig();
  }

  private nextBig() {
    if (this.bigBusy || !this.bigQueue.length) return;
    this.bigBusy = true;
    const el = $('big-messages');
    el.innerHTML = `<h1>${this.bigQueue.shift()}</h1>`;
    el.classList.remove('fade');
    void el.offsetWidth;
    el.classList.add('fade');
    setTimeout(() => {
      this.bigBusy = false;
      el.innerHTML = '';
      this.nextBig();
    }, 2200);
  }

  hurt() {
    const v = $('hurt-vignette');
    v.classList.remove('on');
    void v.offsetWidth;
    v.classList.add('on');
  }

  // --- roster, rounds, death -----------------------------------------------------------------

  roster(list: RosterInfo[], khan: number, myId: number) {
    this.players = list;
    this.khan = khan;
    this.myId = myId;
    const sorted = [...list].sort((a, b) => b.score - a.score || b.kills - a.kills);
    const rows = sorted.slice(0, 5);
    const me = sorted.findIndex((p) => p.id === myId);
    const row = (p: RosterInfo, i: number) =>
      `<li class="${p.id === myId ? 'me' : ''}">${i + 1}. ${p.id === khan ? '<img src="/assets/sprites/crown.png" class="px-icon">' : ''}${escapeHtml(p.name)}: <span class="score">${p.score}</span> <span class="green">${p.kills}</span>/<span class="red">${p.deaths}</span></li>`;
    $('leaderboard-list').innerHTML = rows.map(row).join('') + (me >= 5 ? row(sorted[me], me) : '');
    const k = list.find((p) => p.id === khan);
    $('khan-info').innerHTML = k ? `<img src="/assets/sprites/crown.png" class="px-icon"> ${escapeHtml(k.name)}` : 'No Khan yet';
    if (!$('scoreboard').hidden) this.renderScoreboard();
  }

  private renderScoreboard() {
    const sorted = [...this.players].sort((a, b) => b.score - a.score || b.kills - a.kills);
    $('scoreboard-body').innerHTML = sorted
      .map((p, i) => `<tr class="${p.id === this.myId ? 'me' : ''}"><td>${i + 1}</td><td class="name">${p.id === this.khan ? '<img src="/assets/sprites/crown.png" class="px-icon"> ' : ''}${escapeHtml(p.name)}${p.bot ? ' <span class="bot-tag">BOT</span>' : ''}</td><td>${CLASSES[p.cls].name}</td><td>${p.score}</td><td class="green">${p.kills}</td><td class="red">${p.deaths}</td><td>${p.bogs}</td><td>${p.bot ? '–' : p.ping}</td></tr>`)
      .join('');
  }

  round(phase: 'play' | 'end', endsAt: number, results: RoundResult[], myId: number) {
    this.roundPhase = phase;
    this.roundEndsAt = endsAt;
    const panel = $('round-end');
    if (phase === 'play') {
      panel.hidden = true;
      return;
    }
    $('death').hidden = true;
    const w = results[0];
    $('round-winner').innerHTML = w && w.score > 0
      ? `<img src="/assets/sprites/crown.png" class="px-icon big"> <span class="gold">${escapeHtml(w.name)}</span> is the Khan of the Isle!`
      : 'Nobody claimed the crown.';
    const me = this.players.find((p) => p.id === myId)?.name;
    $('round-results').innerHTML =
      '<tr><th>#</th><th>Name</th><th>Score</th><th>Kills</th><th>Deaths</th><th>Bogs</th></tr>' +
      results.slice(0, 8).map((r, i) => `<tr class="${r.name === me ? 'me' : ''}"><td>${i + 1}</td><td class="name">${escapeHtml(r.name)}</td><td>${r.score}</td><td class="green">${r.kills}</td><td class="red">${r.deaths}</td><td>${r.bogs}</td></tr>`).join('');
    panel.hidden = false;
  }

  showDeath(by: string | null, respawnAt: number, cls: ClassId) {
    this.respawnAt = respawnAt;
    this.deathCls = cls;
    $('death-title').innerHTML = by ? `Slain by <span class="red">${escapeHtml(by)}</span>` : 'You died';
    classCards($('death-classes'), cls, (c) => (this.deathCls = c), true);
    if (this.roundPhase === 'play') $('death').hidden = false;
  }

  hideDeath() {
    $('death').hidden = true;
  }

  private togglePause() {
    const p = $('pause');
    p.hidden = !p.hidden;
    $('invite').hidden = !this.inviteUrl;
  }

  private updateMuteLabel(muted: boolean) {
    $('mute').textContent = muted ? 'Sound: off' : 'Sound: on';
  }

  private copyInvite() {
    navigator.clipboard?.writeText(this.inviteUrl).then(
      () => this.toast('Invite link copied!'),
      () => this.toast(this.inviteUrl),
    );
  }

  toast(text: string) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout((t as unknown as { timer: number }).timer);
    (t as unknown as { timer: number }).timer = window.setTimeout(() => (t.hidden = true), 2500);
  }

  // --- per frame -----------------------------------------------------------------------------

  frame(game: Game, now: number) {
    this.fps = this.fps * 0.95 + (1000 / Math.max(1, now - this.lastFrame)) * 0.05;
    this.lastFrame = now;
    const secs = Math.max(0, Math.ceil((this.roundEndsAt - now) / 1000));
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('timer').textContent = this.roundPhase === 'play' ? clock : `Next round ${clock}`;
    if (this.roundPhase === 'end') $('round-next').textContent = `Next round in ${secs}…`;

    if (!$('death').hidden) {
      const left = Math.ceil((this.respawnAt - now) / 1000);
      const btn = $<HTMLButtonElement>('respawn');
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `Respawn in ${left}…` : 'Respawn (SPACE)';
    }

    const def = CLASSES[game.cls];
    if (this.slotCls !== game.cls) {
      this.slotCls = game.cls;
      $<HTMLImageElement>('slot-primary-img').src = `/assets/sprites/${PRIMARY_ICON[game.cls]}.png`;
      $<HTMLImageElement>('slot-special-img').src = `/assets/sprites/${SPECIAL_ICON[def.special.kind]}.png`;
      $('slot-primary').title = def.primary.name;
      $('slot-special').title = def.special.name;
    }
    const b = game.body;
    this.cooldown('slot-primary', b.cdP, def.primary.cd);
    this.cooldown('slot-secondary', b.cdS, BOMB_CD);
    this.cooldown('slot-special', b.cdX, def.special.cd);
    const hp = game.alive ? game.myHp : 0, max = game.myMaxHp || def.hp;
    $('hp-fill').style.width = `${(100 * hp) / max}%`;
    $('hp-fill').className = hp / max > 0.5 ? '' : hp / max > 0.25 ? 'mid' : 'low';
    $('hp-text').textContent = `${hp} / ${max}`;
    $('coins').textContent = String(game.coins);
    this.renderShop(game);

    if (now - this.lastMinimap > 100) {
      this.lastMinimap = now;
      this.drawMinimap(game);
    }
    if (this.debug) {
      $('debug').textContent = `fps ${this.fps.toFixed(0)}  ping ${game.rtt.toFixed(0)}ms  room ${game.room}  pos ${b.x.toFixed(0)},${b.y.toFixed(0)}`;
    }
  }

  /** The wizard's shop, shown while you stand next to him. */
  private renderShop(game: Game) {
    this.atShop = game.atShop;
    const panel = $('shop');
    panel.hidden = !this.atShop;
    if (!this.atShop) return;
    const key = JSON.stringify([game.coins, game.up, game.cls, game.myHp >= game.myMaxHp]);
    if (key === this.shopKey) return;
    this.shopKey = key;
    $('shop-items').innerHTML = ITEMS.map((item, i) => {
      const price = priceOf(item.id, game.up);
      const level = item.id === 'potion' ? null : game.up[item.id];
      const full = item.id === 'potion' && game.myHp >= game.myMaxHp;
      const can = price !== null && game.coins >= price && !full;
      const icon = item.id === 'weapon' ? PRIMARY_ICON[game.cls] : ITEM_ICON[item.id];
      const pips = level === null ? '' : `<span class="pips">${item.costs.map((_, l) => `<i class="${l < level ? 'on' : ''}"></i>`).join('')}</span>`;
      return `<button class="shop-item${can ? '' : ' cant'}" data-item="${item.id}">
        <span class="shop-key">${i + 1}</span><img src="/assets/sprites/${icon}.png" alt="">
        <span class="shop-text"><b>${item.name}</b>${pips}<small>${item.desc}</small></span>
        <span class="shop-price">${price === null ? 'MAX' : `<img src="/assets/sprites/coin.png" class="px-icon"> ${price}`}</span>
      </button>`;
    }).join('');
  }

  private cooldown(id: string, left: number, total: number) {
    const el = $(id);
    const f = total ? left / total : 0;
    (el.querySelector('.cd') as HTMLElement).style.height = `${f * 100}%`;
    (el.querySelector('.cd-text') as HTMLElement).textContent = left > 30 ? String(Math.ceil(left / 60)) : '';
  }

  private drawMinimap(game: Game) {
    const g = this.minimapCtx, s = 2, pad = 2;
    g.clearRect(0, 0, 204, 204);
    g.drawImage(this.minimapBase, pad, pad);
    g.fillStyle = '#7b4fd6';
    g.fillRect(pad + (MAP.wizard.x / TILE) * s - 2, pad + (MAP.wizard.y / TILE) * s - 2, 4, 4);
    for (const p of game.minimapPlayers()) {
      g.fillStyle = p.me ? 'blue' : p.khan ? '#ffd23f' : 'red';
      g.fillRect(pad + (p.x / TILE) * s - s, pad + (p.y / TILE) * s - s, s * 2 + (p.me ? 1 : 0), s * 2 + (p.me ? 1 : 0));
    }
  }
}
