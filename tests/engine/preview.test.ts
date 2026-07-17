import { describe, expect, it } from 'vitest';
import {
  createGame,
  DEFAULT_CONFIG,
  previewMoveConsequences,
  type GameState,
} from '../../src/engine';

describe('previewMoveConsequences', () => {
  it('returns null for illegal starts', () => {
    const state = createGame(DEFAULT_CONFIG, { firstPlayer: 'S' });
    expect(
      previewMoveConsequences(state, { startPit: 7, direction: 'ccw' }),
    ).toBeNull();
  });

  it('wiki golden: previews capture pits for North A6 ccw', () => {
    const state: GameState = {
      pits: [0, 0, 3, 0, 0, 0, 0, 0, 0, 4, 0, 0, 1, 0],
      score: { S: 0, N: 0, E: 0 },
      toMove: 'N',
      sowingsUsedThisTurn: 0,
      protectedMask: Array(14).fill(false),
      resigned: null,
      initialTotal: 8,
      config: { ...DEFAULT_CONFIG },
      quietTurns: 0,
      openingComplete: true,
      roundIndex: 0,
      bank: { S: 0, N: 0, E: 0 },
      seriesOver: false,
    };
    const prev = previewMoveConsequences(state, {
      startPit: 12,
      direction: 'ccw',
    });
    expect(prev).not.toBeNull();
    expect(prev!.saadaEmpty).toBe(10);
    expect(prev!.capturePits).toEqual(expect.arrayContaining([9, 2]));
    expect(prev!.captureTotal).toBe(7);
    expect(prev!.forcesSecond).toBe(true);
  });
});
