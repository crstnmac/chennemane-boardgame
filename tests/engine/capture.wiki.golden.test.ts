import { describe, expect, it } from 'vitest';
import {
  applyMove,
  DEFAULT_CONFIG,
  needsSecondSowing,
  type GameState,
} from '../../src/engine';

/** Appendix A — Wikipedia golden capture fixture */
function wikiGoldenPre(): GameState {
  return {
    pits: [0, 0, 3, 0, 0, 0, 0, 0, 0, 4, 0, 0, 1, 0],
    score: { S: 0, N: 0, E: 0 },
    toMove: 'N',
    sowingsUsedThisTurn: 0,
    protectedMask: Array(14).fill(false),
    resigned: null,
    initialTotal: 8,
    config: { ...DEFAULT_CONFIG, directionMode: 'bidirectional' },
    quietTurns: 0,
    openingComplete: true,
    roundIndex: 0,
    bank: { S: 0, N: 0, E: 0 },
    seriesOver: false,
  };
}

describe('Appendix A Wikipedia golden capture', () => {
  it('North sows A6 ccw → capture A3+B3, second sowing pending', () => {
    const pre = wikiGoldenPre();
    const { state, events } = applyMove(pre, { startPit: 12, direction: 'ccw' });

    expect(events).toEqual([
      { type: 'pickup', pit: 12, count: 1 },
      { type: 'drop', pit: 11, remainingInHand: 0 },
      { type: 'saada', emptyPit: 10 },
      { type: 'capture', pits: [9, 2], amounts: [4, 3] },
    ]);

    expect(state.pits).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(state.score).toEqual({ S: 0, N: 7, E: 0 });
    expect(state.toMove).toBe('N');
    expect(state.sowingsUsedThisTurn).toBe(1);
    expect(needsSecondSowing(state)).toBe(true);
    expect(state.pits.reduce((a, b) => a + b, 0) + state.score.S + state.score.N).toBe(8);
  });
});
