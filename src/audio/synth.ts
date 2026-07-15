import { Howler } from 'howler';

// Tiny Web Audio helpers under the CC0 foley samples.
// Used sparingly for thumps + rare result stings — not a continuous melody
// during sowing (that piano/kalimba layer was too busy).
// Rides Howler's AudioContext so mute/unlock behavior stays unified.

function ctx(): AudioContext | null {
  const c = Howler.ctx as AudioContext | undefined;
  return c && c.state !== 'closed' ? c : null;
}

// --- Shared bus with a light generated reverb --------------------------------
let busFor: AudioContext | null = null;
let dry: GainNode | null = null;
let wet: GainNode | null = null;

function getBus(c: AudioContext): GainNode {
  if (busFor === c && dry) return dry;
  const out: AudioNode = (Howler as unknown as { masterGain?: GainNode }).masterGain ?? c.destination;

  dry = c.createGain();
  dry.gain.value = 1;
  dry.connect(out);

  // 0.9s noise-burst impulse response: soft wooden-room tail, no assets needed.
  const len = Math.floor(c.sampleRate * 0.9);
  const impulse = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
    }
  }
  const reverb = c.createConvolver();
  reverb.buffer = impulse;
  wet = c.createGain();
  wet.gain.value = 0.18;
  dry.connect(reverb);
  reverb.connect(wet);
  wet.connect(out);

  busFor = c;
  return dry;
}

// --- Musical scale ------------------------------------------------------------
// A-major pentatonic from A3: every interval is consonant, so any run of drops
// sounds like a melody no matter where it stops.
const PENTATONIC = [0, 2, 4, 7, 9];
const ROOT = 220; // A3

/** Frequency for the nth step up the pentatonic scale. */
export function noteFreq(step: number): number {
  const s = Math.max(0, Math.min(step, 14));
  const octave = Math.floor(s / PENTATONIC.length);
  const deg = PENTATONIC[s % PENTATONIC.length]!;
  return ROOT * Math.pow(2, (octave * 12 + deg) / 12);
}

export interface PluckOpts {
  gain?: number;
  pan?: number;
  delay?: number;
  /** Decay seconds; longer = more bell-like. */
  decay?: number;
}

/** Kalimba-ish pluck: sine fundamental + detuned 2nd harmonic, fast decay. */
export function pluck(freq: number, opts: PluckOpts = {}) {
  const c = ctx();
  if (!c) return;
  const bus = getBus(c);
  const { gain = 0.08, pan = 0, delay = 0, decay = 0.35 } = opts;
  const t = c.currentTime + delay;

  const env = c.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0005, t + decay);

  const o1 = c.createOscillator();
  o1.type = 'sine';
  o1.frequency.value = freq;

  const h = c.createGain();
  h.gain.value = 0.35;
  const o2 = c.createOscillator();
  o2.type = 'sine';
  o2.frequency.value = freq * 2.013;

  const panner = c.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));

  o1.connect(env);
  o2.connect(h);
  h.connect(env);
  env.connect(panner);
  panner.connect(bus);

  o1.start(t);
  o2.start(t);
  o1.stop(t + decay + 0.05);
  o2.stop(t + decay + 0.05);
}

/** Deep bass thump — the physical "weight" under a capture. */
export function thump(opts: { gain?: number; pan?: number; delay?: number } = {}) {
  const c = ctx();
  if (!c) return;
  const bus = getBus(c);
  const { gain = 0.5, pan = 0, delay = 0 } = opts;
  const t = c.currentTime + delay;

  const env = c.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.16);

  const panner = c.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan * 0.5));

  o.connect(env);
  env.connect(panner);
  panner.connect(bus);
  o.start(t);
  o.stop(t + 0.35);
}

/** Ascending arpeggio of plucks (scale steps), spaced `spacing` seconds apart. */
export function arpeggio(
  steps: number[],
  opts: { gain?: number; pan?: number; delay?: number; spacing?: number; decay?: number } = {},
) {
  const { gain = 0.18, pan = 0, delay = 0, spacing = 0.075, decay = 0.6 } = opts;
  steps.forEach((s, i) => {
    pluck(noteFreq(s), { gain, pan, delay: delay + i * spacing, decay });
  });
}
