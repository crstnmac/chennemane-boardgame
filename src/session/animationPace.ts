/**
 * Shared bead-travel pacing for live play and the tour.
 * `travelSpeed` is 1 (slowest) … 10 (fastest).
 *
 * Hop visuals live in `src/ui/hopMath.ts` and must stay aligned with these
 * durations: store commits `animBudgetMs = drop` and sleeps the full drop;
 * boards hop with hopDurationMs(animBudgetMs) ≤ that budget.
 */

import type { Settings } from './settings';

export const TRAVEL_SPEED_MIN = 1;
export const TRAVEL_SPEED_MAX = 10;
/** Default leans slow so sowing is easy to follow. */
export const TRAVEL_SPEED_DEFAULT = 2;

/**
 * Long sowings (many drops) skip per-bead hops so counts don't lag the flyer.
 * Must match store `playEvents` batching and board hop gating.
 */
export const BATCH_DROP_THRESHOLD = 60;

/** True when the store should skip hop highlights and per-event sleeps. */
export function shouldBatchSow(dropMs: number, dropCount: number): boolean {
  return dropMs <= 0 || dropCount > BATCH_DROP_THRESHOLD;
}

/** Settings-aware reduced-motion (shared by store + all hop surfaces). */
export function prefersReducedMotion(
  settings: Pick<Settings, 'reducedMotionOverride'>,
): boolean {
  return (
    settings.reducedMotionOverride === 'always' ||
    (settings.reducedMotionOverride === 'auto' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

export type EventPace = {
  drop: number;
  pickup: number;
  continue: number;
  saada: number;
  capture: number;
  pass: number;
  endBeat: number;
  /** Tour-only hold between demo loops */
  hold: number;
  reset: number;
};

export function clampTravelSpeed(n: number): number {
  if (!Number.isFinite(n)) return TRAVEL_SPEED_DEFAULT;
  return Math.min(TRAVEL_SPEED_MAX, Math.max(TRAVEL_SPEED_MIN, Math.round(n)));
}

/** Migrate legacy enum or invalid values → 1..10 */
export function normalizeTravelSpeed(raw: unknown): number {
  if (typeof raw === 'number') return clampTravelSpeed(raw);
  if (raw === 'slow') return 2;
  if (raw === 'normal') return 5;
  if (raw === 'fast') return 8;
  return TRAVEL_SPEED_DEFAULT;
}

export function travelSpeedLabel(level: number): string {
  const s = clampTravelSpeed(level);
  // Wider "Slow/Normal" band — matches the eased duration curve below.
  if (s <= 4) return 'Slow';
  if (s <= 6) return 'Normal';
  if (s <= 8) return 'Fast';
  return 'Very fast';
}

/**
 * Base drop duration in ms from a 1–10 speed level.
 * 1 → ~560ms (easy to follow), 10 → ~120ms (snappy, not a blur).
 *
 * Duration eases so the left/mid of the slider stays readable; only the
 * far-right ticks get truly fast. Linear mapping used to make "Normal"
 * feel like Fast (mid levels dropped under ~260ms).
 *
 * The session store sleeps this full duration between drop highlight and
 * pit-count land. Visual hops use a slightly shorter duration
 * (`hopDurationMs` in `src/ui/hopMath.ts`) so the bead settles first.
 */
export function dropMsForSpeed(level: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const t = (clampTravelSpeed(level) - 1) / (TRAVEL_SPEED_MAX - 1);
  // Ease-in on "fastness": mid-slider spends more time in the slow band.
  const u = Math.pow(t, 1.45);
  const slowMs = 560;
  const fastMs = 120;
  return Math.round(slowMs * (1 - u) + fastMs * u);
}

export function eventPaceFromDrop(drop: number): EventPace {
  if (drop === 0) {
    return {
      drop: 0,
      pickup: 0,
      continue: 0,
      saada: 0,
      capture: 0,
      pass: 450,
      endBeat: 0,
      hold: 800,
      reset: 650,
    };
  }
  return {
    drop,
    pickup: Math.round(drop * 1.25),
    continue: Math.round(drop * 1.55),
    saada: Math.round(drop * 2.5),
    capture: Math.round(drop * 3.1),
    pass: Math.max(650, drop * 4.5),
    endBeat: Math.round(drop * 1.7),
    hold: Math.max(1000, Math.round(drop * 9)),
    reset: Math.max(700, Math.round(drop * 7)),
  };
}

/** Tour demos stay a bit slower than live play so teaching reads clearly. */
export function tourPaceFromSpeed(level: number, reducedMotion: boolean): EventPace {
  const drop = dropMsForSpeed(level, reducedMotion);
  if (drop === 0) return eventPaceFromDrop(0);
  // ~1.55× play durations for the coach
  return eventPaceFromDrop(Math.round(drop * 1.55));
}
