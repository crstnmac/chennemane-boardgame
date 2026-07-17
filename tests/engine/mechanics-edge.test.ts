import { describe, expect, it } from 'vitest';
import {
  applyMove,
  createGame,
  getLegalMoves,
  getWinner,
  isDeadlocked,
  isTerminal,
  needsSecondSowing,
  QUIET_TURN_LIMIT_LOW_SEEDS,
  resign,
  totalBoardSeeds,
  type GameState,
} from '../../src/engine';

function blank(partial: Partial<GameState> & { pits: number[] }): GameState {
  const board = partial.pits.reduce((a, b) => a + b, 0);
  const score = partial.score ?? { S: 0, N: 0, E: 0 };
  const base = createGame(undefined, { firstPlayer: partial.toMove ?? 'S' });
  return {
    ...base,
    ...partial,
    pits: partial.pits,
    score: { S: score.S ?? 0, N: score.N ?? 0, E: score.E ?? 0 },
    protectedMask: partial.protectedMask ?? Array(14).fill(false),
    initialTotal:
      partial.initialTotal ??
      board + (score.S ?? 0) + (score.N ?? 0) + (score.E ?? 0),
    quietTurns: partial.quietTurns ?? 0,
    sowingsUsedThisTurn: partial.sowingsUsedThisTurn ?? 0,
  };
}

describe('mechanics edge cases', () => {
  it('capture then second sowing ending 0-capture leaves quietTurns at 0', () => {
    const s = blank({
      pits: [1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0],
      toMove: 'S',
      quietTurns: 5,
    });
    const first = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(needsSecondSowing(first.state)).toBe(true);
    expect(first.state.quietTurns).toBe(0);
    const legal = getLegalMoves(first.state);
    const second = applyMove(first.state, legal[0]!);
    expect(second.state.quietTurns).toBe(0);
    expect(second.state.sowingsUsedThisTurn).toBe(0);
  });

  it('deadlock limit switches at 4 seeds and does not fire early at 5 seeds', () => {
    const s = blank({
      pits: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: { S: 30, N: 35, E: 0 },
      toMove: 'S',
      quietTurns: QUIET_TURN_LIMIT_LOW_SEEDS,
      initialTotal: 70,
    });
    expect(totalBoardSeeds(s)).toBe(5);
    expect(isDeadlocked(s)).toBe(false);
    expect(isTerminal(s)).toBe(false);
  });

  it('resign yields opponent as winner and is terminal', () => {
    const s = createGame(undefined, { firstPlayer: 'S' });
    const { state, events } = resign(s, 'S');
    expect(isTerminal(state)).toBe(true);
    expect(getWinner(state)).toBe('N');
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
  });

  it('long relay conserves seeds and ends in saada', () => {
    // Many seeds in one pit causes multi-lap relay
    const pits = Array(14).fill(0);
    pits[0] = 20;
    pits[5] = 3;
    pits[10] = 2;
    const s = blank({ pits, toMove: 'S', initialTotal: 25 });
    const { state, events } = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(totalBoardSeeds(state) + state.score.S + state.score.N).toBe(25);
    expect(events.some((e) => e.type === 'saada' || e.type === 'capture')).toBe(
      true,
    );
    expect(events.filter((e) => e.type === 'drop').length).toBeGreaterThan(5);
  });
});
