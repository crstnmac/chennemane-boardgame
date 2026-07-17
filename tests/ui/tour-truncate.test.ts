import { describe, expect, it } from 'vitest';
import { createGame, executeSowing, type MoveEvent } from '../../src/engine';
import { truncateTourEvents } from '../../src/ui/three/tourEvents';

describe('truncateTourEvents', () => {
  it('includes saada and drops capture for coach sowing step', () => {
    const pits = Array(14).fill(2) as number[];
    pits[1] = 4;
    const state = createGame(
      { seedFill: 'custom', customLayout: pits },
      { firstPlayer: 'S' },
    );
    const { events } = executeSowing(state, 1, 'ccw');
    expect(events.some((e) => e.type === 'saada')).toBe(true);
    expect(events.some((e) => e.type === 'capture')).toBe(true);

    const truncated = truncateTourEvents(events, 'saada');
    expect(truncated.some((e) => e.type === 'saada')).toBe(true);
    expect(truncated.some((e) => e.type === 'capture')).toBe(false);
    expect(truncated[truncated.length - 1]?.type).toBe('saada');
  });

  it('returns original list when stop type is absent', () => {
    const events: MoveEvent[] = [
      { type: 'pickup', pit: 0, count: 1 },
      { type: 'drop', pit: 1, remainingInHand: 0 },
    ];
    expect(truncateTourEvents(events, 'saada')).toEqual(events);
  });
});
