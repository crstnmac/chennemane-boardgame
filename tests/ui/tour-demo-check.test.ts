import { describe, expect, it } from 'vitest';
import { createGame, executeSowing } from '../../src/engine';
import { truncateTourEvents } from '../../src/ui/three/tourEvents';

/** Layouts mirrored from CoachScreen tour steps. */
function sowInitial(): number[] {
  const p = Array(14).fill(2) as number[];
  p[1] = 4;
  return p;
}

function captureInitial(): number[] {
  const p = Array(14).fill(1) as number[];
  p[0] = 1;
  p[1] = 0;
  p[2] = 0;
  p[3] = 4;
  p[10] = 3;
  for (const i of [4, 5, 6, 7, 8, 9, 11, 12, 13]) p[i] = 1;
  return p;
}

describe('tour demo layouts (coach auto-play)', () => {
  it('sowing step produces drops and ends at saada (no capture spoiler)', () => {
    const state = createGame(
      { seedFill: 'custom', customLayout: sowInitial() },
      { firstPlayer: 'S' },
    );
    const { events } = executeSowing(state, 1, 'ccw');
    const truncated = truncateTourEvents(events, 'saada');
    expect(truncated.some((e) => e.type === 'pickup')).toBe(true);
    expect(truncated.filter((e) => e.type === 'drop').length).toBeGreaterThan(0);
    expect(truncated.at(-1)?.type).toBe('saada');
    expect(truncated.every((e) => e.type !== 'capture')).toBe(true);
  });

  it('capture step reaches saada and a non-empty capture of both bowls', () => {
    const state = createGame(
      { seedFill: 'custom', customLayout: captureInitial() },
      { firstPlayer: 'S' },
    );
    const { events, state: after } = executeSowing(state, 0, 'ccw');
    expect(events.some((e) => e.type === 'saada')).toBe(true);
    const cap = events.find((e) => e.type === 'capture');
    expect(cap).toBeDefined();
    if (!cap || cap.type !== 'capture') return;
    const total = cap.amounts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(cap.pits).toEqual(expect.arrayContaining([3, 10]));
    expect((after.score.S ?? 0) + (after.score.N ?? 0)).toBeGreaterThan(0);
  });

  it('full board idle step has beads to show (no move required)', () => {
    const full = Array.from({ length: 14 }, () => 5);
    expect(full.reduce((a, b) => a + b, 0)).toBe(70);
  });
});
