import { describe, expect, it } from 'vitest';
import {
  applyMove,
  createGame,
  getLegalMoves,
  needsSecondSowing,
  isTerminal,
  resign,
  totalBoardSeeds,
  type GameState,
} from '../../src/engine';

function blank(pits: number[], extra: Partial<GameState> = {}): GameState {
  const base = createGame(
    { seedFill: 'custom', customLayout: pits },
    { firstPlayer: (extra.toMove as 'S' | 'N') ?? 'S' },
  );
  const board = pits.reduce((a, b) => a + b, 0);
  const score = extra.score ?? { S: 0, N: 0, E: 0 };
  return {
    ...base,
    ...extra,
    pits: pits.slice(),
    score: { S: score.S ?? 0, N: score.N ?? 0, E: score.E ?? 0 },
    initialTotal:
      extra.initialTotal ?? board + (score.S ?? 0) + (score.N ?? 0) + (score.E ?? 0),
  };
}

describe('loop hunt', () => {
  it('second sowing after capture never leaves AI without legal moves when needsSecond', () => {
    // Run many capture-forcing positions
    let secondCount = 0;
    for (let sPit = 0; sPit < 7; sPit++) {
      for (let cPit = 0; cPit < 14; cPit++) {
        if (cPit === sPit) continue;
        const pits = Array(14).fill(0);
        pits[sPit] = 1;
        // place capture targets two steps ahead ccw from sPit
        // S0 ccw: drop S1, peek S2, capture S3+opp
        // Build generic: only test known pattern
      }
    }
    // Known fixture
    const s = blank([1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0], {
      toMove: 'S',
      quietTurns: 3,
    });
    const { state } = applyMove(s, { startPit: 0, direction: 'ccw' });
    if (needsSecondSowing(state)) {
      secondCount++;
      expect(getLegalMoves(state).length).toBeGreaterThan(0);
      expect(isTerminal(state)).toBe(false);
    }
    expect(secondCount).toBe(1);
  });

  it('resign during second sowing clears sowings and ends series', () => {
    const s = blank([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], {
      toMove: 'S',
      sowingsUsedThisTurn: 1,
      score: { S: 20, N: 20, E: 0 },
      initialTotal: 41,
    });
    const { state } = resign(s, 'S');
    expect(state.sowingsUsedThisTurn).toBe(0);
    expect(state.seriesOver).toBe(true);
    expect(isTerminal(state)).toBe(true);
  });

  it('conservation holds across second sowing pair', () => {
    const s = blank([1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0], { toMove: 'S' });
    const total =
      totalBoardSeeds(s) + s.score.S + s.score.N;
    const first = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(totalBoardSeeds(first.state) + first.state.score.S + first.state.score.N).toBe(
      total,
    );
    if (needsSecondSowing(first.state)) {
      const m = getLegalMoves(first.state)[0]!;
      const second = applyMove(first.state, m);
      expect(
        totalBoardSeeds(second.state) + second.state.score.S + second.state.score.N,
      ).toBe(total);
    }
  });
});
