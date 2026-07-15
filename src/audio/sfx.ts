import { Howl, Howler } from 'howler';
import type { PlayerId } from '../engine';
import layout from '../models/pit_layout.json';
import { arpeggio, noteFreq, pluck, thump } from './synth';

// Hybrid SFX: CC0 wood foley (Kenney.nl) for play feel.
// Musical synth plucks are limited to rare result stings — not every seed drop
// (the continuous pentatonic "piano" layer was too busy during play).

let enabled = true;

export function setSoundEnabled(v: boolean) {
  enabled = v;
  Howler.mute(!v);
}

const BASE = `${import.meta.env.BASE_URL}audio/sfx`;

// Stereo pan per pit, derived from the board layout: pits span x ∈ [-0.42, 0.42].
const PAN_SPREAD = 0.65;
const HALF_BOARD_X = Math.max(...layout.pits.map((p) => Math.abs(p.x)));
const PIT_PAN: number[] = (() => {
  const pans: number[] = [];
  for (const p of layout.pits) pans[p.index] = (p.x / HALF_BOARD_X) * PAN_SPREAD;
  return pans;
})();

function panForPit(pit: number | undefined): number {
  if (pit === undefined) return 0;
  return PIT_PAN[pit] ?? 0;
}

function howl(name: string, volume: number): Howl {
  return new Howl({
    src: [`${BASE}/${name}.ogg`, `${BASE}/${name}.mp3`],
    volume,
    preload: true,
  });
}

// Lazy-created so the AudioContext is only unlocked after a user gesture.
let bank: Record<string, Howl[]> | null = null;

function getBank() {
  if (!bank) {
    bank = {
      drop: [0, 1, 2, 3, 4].map((i) => howl(`drop_${i}`, 0.5)),
      saada: [howl('saada_0', 0.55), howl('saada_1', 0.55)],
      captureAccent: [howl('capture_accent', 0.48)],
      pickup: [howl('pickup_0', 0.38), howl('pickup_1', 0.38)],
      sparkle: [howl('sparkle_0', 0.22), howl('sparkle_1', 0.22)],
      select: [howl('select', 0.32)],
      pass: [howl('pass', 0.45)],
      win: [howl('win', 0.55)],
      lose: [howl('lose', 0.42)],
      draw: [howl('draw', 0.45)],
    };
  }
  return bank;
}

// Combo only pitches the wood sample slightly — no scale melody.
let streak = 0;
let relays = 0;

/** +2.5% pitch per seed, capped at +30% — subtle climb, not a song. */
function comboRate(base: number): number {
  return base * (1 + Math.min(streak * 0.025, 0.3));
}

function play(
  key: string,
  opts: {
    rate?: number;
    rateJitter?: number;
    volumeScale?: number;
    delay?: number;
    pan?: number;
  } = {},
) {
  if (!enabled) return;
  const takes = getBank()[key];
  if (!takes || takes.length === 0) return;
  const h = takes[Math.floor(Math.random() * takes.length)]!;
  const { rate = 1, rateJitter = 0, volumeScale = 1, delay = 0, pan = 0 } = opts;
  const fire = () => {
    if (!enabled) return;
    const id = h.play();
    h.rate(rate + (Math.random() * 2 - 1) * rateJitter, id);
    if (volumeScale !== 1) h.volume(h.volume() * volumeScale, id);
    if (pan !== 0) h.stereo(pan, id);
  };
  if (delay > 0) setTimeout(fire, delay);
  else fire();
}

export const sfx = {
  /** Pit tap: wood tick only. */
  select: (pit?: number) => {
    play('select', { rate: 1.05, rateJitter: 0.05, pan: panForPit(pit) });
  },

  /** Scoop a pit — wood shuffle only. */
  pickup: (pit?: number) => {
    streak = 0;
    relays = 0;
    play('pickup', { rate: 1.0, rateJitter: 0.06, pan: panForPit(pit) });
  },

  /** Relay scoop — slightly brighter wood, still no piano. */
  relay: (pit?: number) => {
    relays += 1;
    play('pickup', {
      rate: 1.0 + Math.min(relays * 0.06, 0.3),
      rateJitter: 0.04,
      pan: panForPit(pit),
    });
  },

  /** Seed lands in a pit — wood tap with gentle pitch climb only. */
  drop: (pit?: number) => {
    streak += 1;
    const pan = panForPit(pit);
    play('drop', { rate: comboRate(1.0), rateJitter: 0.05, pan });
    // Occasional soft glass tick on full board lap (not a melody).
    if (streak > 0 && streak % 14 === 0) {
      play('sparkle', { rate: 1 + (streak / 14) * 0.12, volumeScale: 0.45, pan });
    }
  },

  /** Empty pit before saada — deep wood knock. */
  saada: (pit?: number) => {
    play('saada', { rate: 0.92, rateJitter: 0.04, pan: panForPit(pit) });
  },

  /**
   * Capture: bass thump + wood rattle. No coin-pluck count-up melody.
   * Big hauls get a single quiet chime, not a fanfare run.
   */
  capture: (pits?: number[], total = 0) => {
    const pan =
      pits && pits.length > 0
        ? pits.reduce((a, p) => a + panForPit(p), 0) / pits.length
        : 0;
    thump({ pan, gain: 0.42 });
    play('captureAccent', { rate: 0.95, pan });
    const taps = Math.min(3 + Math.floor(total / 3), 7);
    for (let i = 0; i < taps; i++) {
      play('drop', {
        rate: 1.05 + i * 0.05,
        rateJitter: 0.04,
        volumeScale: 0.55,
        delay: 35 + i * 42,
        pan,
      });
    }
    if (total >= 10) {
      play('sparkle', { rate: 1.1, volumeScale: 0.55, delay: 40 + taps * 42, pan });
    }
  },

  pass: () => play('pass', { rate: 0.95 }),

  /** Round complete: soft thump + one quiet chime. */
  round: () => {
    thump({ gain: 0.32 });
    play('sparkle', { rate: 1.0, volumeScale: 0.5, delay: 120 });
  },

  banner: (kind: 'win' | 'lose' | 'draw') => {
    if (kind === 'win') {
      thump({ gain: 0.5 });
      play('captureAccent', { rate: 1.0 });
    } else {
      thump({ gain: 0.32 });
    }
  },

  star: (i: number) => {
    thump({ gain: 0.22 });
    play('select', { rate: 1.2 + i * 0.08, volumeScale: 0.5 });
    if (i >= 2) play('sparkle', { rate: 1.2, volumeScale: 0.55, delay: 50 });
  },

  counterTick: (i: number) => {
    play('select', { rate: 1.35 + Math.min(i * 0.03, 0.45), volumeScale: 0.4 });
  },

  /** Victory sting — sample + short soft arpeggio (results only, not during sow). */
  win: () => {
    play('win');
    arpeggio([0, 2, 4, 7], { gain: 0.08, spacing: 0.09, decay: 0.55 });
    play('sparkle', { rate: 1.1, volumeScale: 0.55, delay: 280 });
  },

  lose: () => {
    play('lose', { rate: 0.92 });
    // One low soft tone, not a descending piano run.
    pluck(noteFreq(0) / 2, { gain: 0.08, decay: 0.9 });
  },

  draw: () => {
    play('draw');
  },

  matchOutcome: (winner: PlayerId | 'draw', humanPlayer: PlayerId | null) => {
    if (winner === 'draw') {
      sfx.draw();
      return;
    }
    if (humanPlayer === null) {
      sfx.win();
      return;
    }
    if (winner === humanPlayer) sfx.win();
    else sfx.lose();
  },
};
