import { describe, expect, it } from 'vitest';
import {
  BATCH_DROP_THRESHOLD,
  shouldBatchSow,
} from '../../src/session/animationPace';
import {
  captureFlightDurationMs,
  hopDurationMs,
  hopLiftPx2d,
  hopPoint,
  hopPoint2d,
  hopSettleMs,
  resolveHopBudgetMs,
  smoother,
} from '../../src/ui/hopMath';

describe('hopMath', () => {
  it('smoother is 0 at start, 1 at end, mid near 0.5', () => {
    expect(smoother(0)).toBe(0);
    expect(smoother(1)).toBe(1);
    expect(smoother(0.5)).toBeCloseTo(0.5, 5);
  });

  it('hopPoint starts at from and ends at to (plus zero arc at ends)', () => {
    const from: [number, number, number] = [0, 0, 0];
    const to: [number, number, number] = [2, 0, 4];
    const a = hopPoint(from, to, 0, 1, 1);
    const b = hopPoint(from, to, 1, 1, 1);
    expect(a[0]).toBeCloseTo(0, 5);
    expect(a[2]).toBeCloseTo(0, 5);
    expect(b[0]).toBeCloseTo(2, 5);
    expect(b[2]).toBeCloseTo(4, 5);
    // Apex is above the chord
    const mid = hopPoint(from, to, 0.5, 1, 1);
    expect(mid[1]).toBeGreaterThan(0.5);
  });

  it('hopPoint2d arcs upward on screen (negative y)', () => {
    const from = { x: 0, y: 100 };
    const to = { x: 100, y: 100 };
    const mid = hopPoint2d(from, to, 0.5, 40, 1);
    expect(mid.y).toBeLessThan(100);
  });

  it('hopDurationMs stays at or under store drop sleep at every speed', () => {
    expect(hopDurationMs(0)).toBe(0);
    expect(hopDurationMs(200)).toBe(180);
    // Fast travel (drop ~55): must not use a 90ms floor that overshoots sleep
    expect(hopDurationMs(55)).toBe(50);
    expect(hopDurationMs(55)).toBeLessThanOrEqual(55);
    expect(hopDurationMs(100)).toBe(90);
    // Sub-floor budgets: soft min must not exceed the store sleep
    expect(hopDurationMs(10)).toBe(10);
    expect(hopDurationMs(16)).toBe(16);
    expect(hopSettleMs(200)).toBe(70);
    expect(hopSettleMs(55)).toBeLessThanOrEqual(Math.round(55 * 0.5));
    expect(hopSettleMs(10)).toBeLessThanOrEqual(Math.round(10 * 0.5));
    expect(captureFlightDurationMs(10)).toBe(10);
  });

  it('hopDurationMs never exceeds dropMs across the 1–10 speed table', async () => {
    const { dropMsForSpeed, eventPaceFromDrop } = await import(
      '../../src/session/animationPace'
    );
    for (let speed = 1; speed <= 10; speed++) {
      const drop = dropMsForSpeed(speed, false);
      const hop = hopDurationMs(drop);
      expect(hop).toBeGreaterThan(0);
      expect(hop).toBeLessThanOrEqual(drop);
      const pace = eventPaceFromDrop(drop);
      // Settles must finish before pickup / continue / saada store sleeps.
      expect(hopSettleMs(drop)).toBeLessThanOrEqual(pace.pickup);
      expect(hopSettleMs(drop)).toBeLessThanOrEqual(pace.continue);
    }
  });

  it('travel speed curve stays readable (not a mid-slider blur)', async () => {
    const { dropMsForSpeed, travelSpeedLabel } = await import(
      '../../src/session/animationPace'
    );
    // Default-ish (2) and "Normal" band should still be easy to follow.
    expect(dropMsForSpeed(2, false)).toBeGreaterThanOrEqual(480);
    expect(dropMsForSpeed(5, false)).toBeGreaterThanOrEqual(360);
    // Fastest is snappy but not ~1 frame.
    expect(dropMsForSpeed(10, false)).toBeGreaterThanOrEqual(100);
    expect(dropMsForSpeed(10, false)).toBeLessThanOrEqual(140);
    // Monotonic: higher level → shorter drop
    for (let s = 1; s < 10; s++) {
      expect(dropMsForSpeed(s + 1, false)).toBeLessThanOrEqual(
        dropMsForSpeed(s, false),
      );
    }
    expect(travelSpeedLabel(2)).toBe('Slow');
    expect(travelSpeedLabel(5)).toBe('Normal');
  });

  it('hopLiftPx2d scales with distance', () => {
    const near = hopLiftPx2d({ x: 0, y: 0 }, { x: 10, y: 0 });
    const far = hopLiftPx2d({ x: 0, y: 0 }, { x: 200, y: 0 });
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(56);
  });

  it('captureFlightDurationMs stays under store capture sleep', async () => {
    expect(captureFlightDurationMs(0)).toBe(0);
    const { dropMsForSpeed, eventPaceFromDrop } = await import(
      '../../src/session/animationPace'
    );
    const drop = 200;
    const captureMs = eventPaceFromDrop(drop).capture;
    const bowl = hopDurationMs(drop);
    const toStore = captureFlightDurationMs(captureMs);
    // Longer path than a single sow hop, but never longer than store sleep.
    expect(toStore).toBeGreaterThan(bowl);
    expect(toStore).toBeLessThanOrEqual(captureMs);
    for (let speed = 1; speed <= 10; speed++) {
      const cap = eventPaceFromDrop(dropMsForSpeed(speed, false)).capture;
      const flight = captureFlightDurationMs(cap);
      expect(flight).toBeGreaterThan(0);
      expect(flight).toBeLessThanOrEqual(cap);
    }
  });

  it('shouldBatchSow matches store hop gating', () => {
    expect(shouldBatchSow(0, 1)).toBe(true);
    expect(shouldBatchSow(200, BATCH_DROP_THRESHOLD)).toBe(false);
    expect(shouldBatchSow(200, BATCH_DROP_THRESHOLD + 1)).toBe(true);
    expect(shouldBatchSow(200, 10)).toBe(false);
  });

  it('resolveHopBudgetMs never invents a sow hop when store budget is 0', async () => {
    const { dropMsForSpeed } = await import('../../src/session/animationPace');
    // Batch / reduced: animBudgetMs=0 + drop highlight must not use HUD speed.
    expect(
      resolveHopBudgetMs(0, 'drop', 2, false, dropMsForSpeed),
    ).toBe(0);
    expect(
      resolveHopBudgetMs(0, 'pickup', 5, false, dropMsForSpeed),
    ).toBe(0);
    // Committed budget wins.
    expect(
      resolveHopBudgetMs(200, 'drop', 10, false, dropMsForSpeed),
    ).toBe(200);
    // Select / AI preview may sample live speed.
    expect(
      resolveHopBudgetMs(0, 'select', 2, false, dropMsForSpeed),
    ).toBe(dropMsForSpeed(2, false));
    expect(
      resolveHopBudgetMs(0, 'ai', 2, true, dropMsForSpeed),
    ).toBe(0);
  });

  it('visual durations never exceed a store-committed anim budget', async () => {
    const { dropMsForSpeed, eventPaceFromDrop } = await import(
      '../../src/session/animationPace'
    );
    for (let speed = 1; speed <= 10; speed++) {
      const animBudgetMs = dropMsForSpeed(speed, false);
      // Boards use hopDurationMs(animBudgetMs) while store sleeps animBudgetMs.
      expect(hopDurationMs(animBudgetMs)).toBeLessThanOrEqual(animBudgetMs);
      const captureBudget = eventPaceFromDrop(animBudgetMs).capture;
      // CaptureFlight.budgetMs twin — flight ≤ sleep.
      expect(captureFlightDurationMs(captureBudget)).toBeLessThanOrEqual(
        captureBudget,
      );
    }
  });
});
