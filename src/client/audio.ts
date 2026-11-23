const SAMPLES = { bow: 'bow-fire.mp3', sword: 'sword-sound.mp3', boom: 'grenade-sound.mp3', swoosh: 'arrow-swosh.mp3' } as const;
type Sample = keyof typeof SAMPLES;
export type Sfx = Sample | 'hit' | 'hurt' | 'pickup' | 'death' | 'squish' | 'blink' | 'crown' | 'throw' | 'orb' | 'burst' | 'click' | 'spawn' | 'thud' | 'coin' | 'buy' | 'steal';

const MUTE_KEY = 'iok.muted';

/** Plays the original game's samples plus a few synthesized retro blips for everything else. */
class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Sample, AudioBuffer>();
  muted = localStorage.getItem(MUTE_KEY) === '1';

  /** Browsers only allow audio after a user gesture, so this is called from the first click. */
  unlock() {
    if (this.ctx) return void this.ctx.resume();
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    for (const [name, file] of Object.entries(SAMPLES) as [Sample, string][]) {
      fetch(`/assets/sounds/${file}`)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx!.decodeAudioData(b))
        .then((buf) => this.buffers.set(name, buf))
        .catch((e) => console.warn('sound failed to load', file, e));
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  /** `volume` already includes distance falloff. */
  play(name: Sfx, volume = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master || volume <= 0.02 || ctx.state !== 'running') return;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(this.master);
    const buf = this.buffers.get(name as Sample);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.94 + Math.random() * 0.12;
      src.connect(out);
      src.start();
      return;
    }
    const t = ctx.currentTime;
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t + delay);
      o.frequency.exponentialRampToValueAtTime(f1, t + delay + dur);
      g.gain.setValueAtTime(gain, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
      o.connect(g).connect(out);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.02);
    };
    const noise = (dur: number, gain: number, freq: number) => {
      const len = Math.floor(ctx.sampleRate * dur);
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = b;
      f.type = 'lowpass';
      f.frequency.value = freq;
      g.gain.value = gain;
      s.connect(f).connect(g).connect(out);
      s.start();
    };
    switch (name) {
      case 'hit': tone('square', 220, 90, 0.08, 0.18); noise(0.06, 0.25, 2500); break;
      case 'hurt': tone('square', 160, 60, 0.16, 0.25); noise(0.1, 0.3, 1500); break;
      case 'pickup': [523, 659, 784].forEach((f, i) => tone('square', f, f * 1.01, 0.08, 0.12, i * 0.06)); break;
      case 'death': tone('sawtooth', 300, 40, 0.5, 0.2); break;
      case 'squish': tone('triangle', 260, 50, 0.18, 0.3); noise(0.12, 0.2, 900); break;
      case 'blink': tone('sine', 300, 1400, 0.18, 0.2); tone('triangle', 1200, 400, 0.15, 0.1, 0.08); break;
      case 'crown': [392, 523, 659, 784, 1046].forEach((f, i) => tone('square', f, f, 0.12, 0.1, i * 0.09)); break;
      case 'throw': tone('triangle', 500, 220, 0.12, 0.15); break;
      case 'orb': tone('sine', 700, 300, 0.25, 0.2); tone('triangle', 1400, 900, 0.15, 0.06); break;
      case 'burst': tone('sine', 500, 120, 0.2, 0.2); noise(0.15, 0.15, 3000); break;
      case 'click': tone('square', 880, 880, 0.04, 0.08); break;
      case 'spawn': [262, 392, 523].forEach((f, i) => tone('triangle', f, f, 0.1, 0.1, i * 0.05)); break;
      case 'thud': noise(0.05, 0.25, 1200); break;
      case 'coin': tone('square', 988, 988, 0.05, 0.1); tone('square', 1319, 1319, 0.12, 0.1, 0.05); break;
      case 'buy': [659, 784, 988, 1319].forEach((f, i) => tone('triangle', f, f, 0.1, 0.12, i * 0.05)); noise(0.08, 0.1, 6000); break;
      case 'steal': tone('square', 900, 300, 0.25, 0.15); tone('square', 600, 200, 0.2, 0.1, 0.1); break;
    }
  }
}

export const audio = new SoundBoard();
