/**
 * Shared bead-travel pacing for live play and the tour.
 * `travelSpeed` is 1 (slowest) … 10 (fastest).
 */

export const TRAVEL_SPEED_MIN = 1;
export const TRAVEL_SPEED_MAX = 10;
/** Default leans slow so sowing is easy to follow. */
export const TRAVEL_SPEED_DEFAULT = 2;

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
  if (s <= 3) return 'Slow';
  if (s <= 6) return 'Normal';
  if (s <= 8) return 'Fast';
  return 'Very fast';
}

/**
 * Base drop duration in ms from a 1–10 speed level.
 * 1 → 420ms, 10 → 55ms (noticeably slower than before).
 */
export function dropMsForSpeed(level: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const t = (clampTravelSpeed(level) - 1) / (TRAVEL_SPEED_MAX - 1);
  return Math.round(420 * (1 - t) + 55 * t);
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
