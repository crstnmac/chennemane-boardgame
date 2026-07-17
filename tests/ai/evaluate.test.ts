import { describe, expect, it } from 'vitest';
import {
  applyMove,
  createGame,
  needsSecondSowing,
} from '../../src/engine';
import { evaluate } from '../../src/ai/evaluate';

describe('evaluate', () => {
  it('is antisymmetric on the opening position', () => {
    const s = createGame(undefined, { firstPlayer: 'S' });
    expect(evaluate(s, 'S')).toBeCloseTo(-evaluate(s, 'N'), 5);
  });

  it('does not throw mid forced second sowing', () => {
    const layout = [1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0];
    const s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    const { state } = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(needsSecondSowing(state)).toBe(true);
    expect(Number.isFinite(evaluate(state, 'S'))).toBe(true);
    expect(Number.isFinite(evaluate(state, 'N'))).toBe(true);
  });
});
