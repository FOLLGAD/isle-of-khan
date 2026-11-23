import { Key } from '../shared/constants';

const KEYMAP: Record<string, Key> = {
  KeyW: Key.Up, ArrowUp: Key.Up,
  KeyS: Key.Down, ArrowDown: Key.Down,
  KeyA: Key.Left, ArrowLeft: Key.Left,
  KeyD: Key.Right, ArrowRight: Key.Right,
  Space: Key.Special, ShiftLeft: Key.Special,
  KeyE: Key.Secondary, KeyQ: Key.Secondary,
};

export const isTouch = matchMedia('(pointer: coarse)').matches;

/**
 * Collects keyboard, mouse and touch state. The game samples it once per simulation step; aim is
 * kept in screen space and converted to world space by the game, which knows the camera.
 */
export class Controls {
  keys = 0;
  /** Keys pressed since the last sample, so a click shorter than a simulation step still counts. */
  private latched = 0;
  /** Cursor in CSS px relative to the canvas. */
  mouseX = innerWidth / 2;
  mouseY = innerHeight / 2;
  /** Touch aim: when set, aim comes from the right stick instead of the cursor. */
  touchAim: { x: number; y: number } | null = null;
  enabled = false;

  constructor(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      const k = KEYMAP[e.code];
      if (k) {
        this.press(k);
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => {
      const k = KEYMAP[e.code];
      if (k) this.keys &= ~k;
    });
    addEventListener('blur', () => (this.keys = 0));
    canvas.addEventListener('mousemove', (e) => {
      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
      this.touchAim = null;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.press(Key.Primary);
      if (e.button === 2) this.press(Key.Secondary);
      e.preventDefault();
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.keys &= ~Key.Primary;
      if (e.button === 2) this.keys &= ~Key.Secondary;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    if (isTouch) this.setupTouch();
  }

  release() {
    this.keys = this.latched = 0;
  }

  /** Held keys plus anything tapped since the previous call. */
  sample() {
    const k = this.keys | this.latched;
    this.latched = 0;
    return k;
  }

  private press(k: Key) {
    this.keys |= k;
    this.latched |= k;
  }

  private setupTouch() {
    const root = document.getElementById('touch')!;
    const stick = (el: HTMLElement, onMove: (x: number, y: number, active: boolean) => void) => {
      const knob = el.querySelector<HTMLElement>('.knob')!;
      let id: number | null = null;
      const update = (t: Touch) => {
        const r = el.getBoundingClientRect();
        const max = r.width / 2;
        let dx = t.clientX - (r.left + max), dy = t.clientY - (r.top + max);
        const d = Math.hypot(dx, dy);
        if (d > max) (dx *= max / d), (dy *= max / d);
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        onMove(dx / max, dy / max, true);
      };
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        id = t.identifier;
        update(t);
      });
      el.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) if (t.identifier === id) update(t);
      });
      const end = (e: TouchEvent) => {
        for (const t of e.changedTouches) if (t.identifier === id) {
          id = null;
          knob.style.transform = '';
          onMove(0, 0, false);
        }
      };
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
    };
    stick(root.querySelector('#stick-move')!, (x, y) => {
      this.keys &= ~(Key.Up | Key.Down | Key.Left | Key.Right);
      if (!this.enabled) return;
      if (x < -0.35) this.keys |= Key.Left;
      if (x > 0.35) this.keys |= Key.Right;
      if (y < -0.35) this.keys |= Key.Up;
      if (y > 0.35) this.keys |= Key.Down;
    });
    stick(root.querySelector('#stick-aim')!, (x, y, active) => {
      if (Math.hypot(x, y) > 0.25) this.touchAim = { x, y };
      if (active && this.enabled && Math.hypot(x, y) > 0.5) this.press(Key.Primary);
      else this.keys &= ~Key.Primary;
    });
    const button = (sel: string, key: Key) => {
      const el = root.querySelector<HTMLElement>(sel)!;
      el.addEventListener('touchstart', (e) => (e.preventDefault(), this.enabled && this.press(key)));
      el.addEventListener('touchend', (e) => (e.preventDefault(), (this.keys &= ~key)));
    };
    button('#btn-bomb', Key.Secondary);
    button('#btn-special', Key.Special);
  }
}

export const isTyping = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
