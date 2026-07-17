/**
 * Shared bead-hop geometry and timing for play board, tour, and 2D fallback.
 *
 * Contract with the session store:
 * - Store sets `animBudgetMs = pace.drop` with each sow highlight and sleeps
 *   that full drop between drop highlight and pit-count land.
 * - Boards prefer `animBudgetMs` (not a fresh HUD slider sample) as the budget.
 * - Visual hop uses {@link hopDurationMs}(budget) — always ≤ budget — so the
 *   bead settles before the count increments (no double-count / teleport).
 * - Capture flights use `CaptureFlight.budgetMs = pace.capture` the same way.
 */

export type Vec3 = [number, number, number];

/** Bead rest height above the pit floor (Three.js Y). */
export const HOP_REST_Y = 0.028;

/** Base peak hop height before mobile {@link HOP_ARC_BOOST}. */
export const HOP_LIFT_BASE = 0.165;

/** Ribbon resolution for the hop-arch line. */
export const HOP_ARC_SEGMENTS = 20;

/** Ken Perlin smootherstep — eased 0→1 with zero velocity at both ends. */
export function smoother(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Point along a 3D hop at progress t ∈ [0,1].
 * Horizontal uses smootherstep (carried hand); vertical is a sine arc with
 * `skew` so the apex is slightly early/late like a real toss.
 */
export function hopPoint(
  from: Vec3,
  to: Vec3,
  t: number,
  lift: number,
  skew: number,
): Vec3 {
  const tt = Math.min(1, Math.max(0, t));
  const e = smoother(tt);
  const arc = Math.sin(Math.PI * Math.pow(tt, skew)) * lift;
  return [
    from[0] + (to[0] - from[0]) * e,
    from[1] + (to[1] - from[1]) * tt + arc,
    from[2] + (to[2] - from[2]) * e,
  ];
}

/**
 * Screen-space hop (CSS / 2D board). Y grows downward, so the arc subtracts
 * from y to throw the bead upward on screen.
 */
export function hopPoint2d(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
  liftPx: number,
  skew: number,
): { x: number; y: number } {
  const tt = Math.min(1, Math.max(0, t));
  const e = smoother(tt);
  const arc = Math.sin(Math.PI * Math.pow(tt, skew)) * liftPx;
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e - arc,
  };
}

/**
 * Resolve the drop-base budget boards should animate against.
 *
 * - Prefer store-committed `animBudgetMs` (exact twin of playEvents sleep).
 * - During sow highlights, never fall back to the HUD slider — batch /
 *   reduced-motion commits 0 and must stay hop-free.
 * - For select / AI preview (no sow budget), fall back to live travel speed.
 */
export function resolveHopBudgetMs(
  animBudgetMs: number,
  highlightKind: string,
  travelSpeed: number,
  reducedMotion: boolean,
  dropMsForSpeed: (level: number, reduced: boolean) => number,
): number {
  if (Number.isFinite(animBudgetMs) && animBudgetMs > 0) return animBudgetMs;
  const sow =
    highlightKind === 'drop' ||
    highlightKind === 'pickup' ||
    highlightKind === 'continue' ||
    highlightKind === 'saada' ||
    highlightKind === 'capture';
  if (sow) return 0;
  return dropMsForSpeed(travelSpeed, reducedMotion);
}

/**
 * Visual hop duration from store drop pacing.
 * 0 when reduced-motion / batch (no flight).
 *
 * Always ≤ `dropMs` so the bead finishes before the store lands the count
 * (a high floor like 90ms used to overshoot fast travel speeds, e.g. drop=55).
 */
export function hopDurationMs(dropMs: number): number {
  if (!Number.isFinite(dropMs) || dropMs <= 0) return 0;
  const visual = Math.round(dropMs * 0.9);
  // Soft minimum for readability, hard max = store sleep.
  // Order matters: Math.max(16, min(visual, drop)) overshoots when drop < 16.
  return Math.min(dropMs, Math.max(16, visual));
}

/**
 * In-place settle when the highlight is not a pit-to-pit drop.
 * Kept under a typical pickup sleep (~1.25× drop).
 */
export function hopSettleMs(dropMs: number): number {
  if (!Number.isFinite(dropMs) || dropMs <= 0) return 0;
  const visual = Math.round(dropMs * 0.35);
  const cap = Math.round(dropMs * 0.5);
  // Soft min 12, hard max half-drop (never outlives non-drop store sleeps).
  return Math.min(cap, Math.max(12, visual));
}

/**
 * Pit → coconut store flight.
 * `captureMs` should be `eventPaceFromDrop(dropMs).capture` — the store sleeps
 * that full duration after starting the flight. Visual must finish within the
 * sleep (same contract as hopDurationMs ≤ dropMs); the longer path still reads
 * because captureMs is already ~3.1× drop.
 */
export function captureFlightDurationMs(captureMs: number): number {
  if (!Number.isFinite(captureMs) || captureMs <= 0) return 0;
  // Slightly under store capture sleep so beads land before the next beat.
  const visual = Math.round(captureMs * 0.9);
  // Soft min 16, hard max captureMs (same floor/cap order as hopDurationMs).
  return Math.min(captureMs, Math.max(16, visual));
}

/** Peak lift for a sowing hop, with optional mobile boost. */
export function hopLift(arcBoost = 1): number {
  return HOP_LIFT_BASE * arcBoost;
}

export function randomHopLift(arcBoost = 1): number {
  return hopLift(arcBoost) * (0.88 + Math.random() * 0.35);
}

export function randomHopSkew(): number {
  return 0.88 + Math.random() * 0.3;
}

/** 2D arc height from hop distance — readable on the fallback board. */
export function hopLiftPx2d(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(56, Math.max(18, dist * 0.32));
}
