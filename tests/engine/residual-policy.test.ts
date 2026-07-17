import { describe, expect, it } from 'vitest';
import {
  appendMatchEndIfTerminal,
  createGame,
  mergeConfig,
  type GameState,
} from '../../src/engine';

function residualBoard(opts: {
  residual: 'unclaimed' | 'to-last-mover';
  multi?: boolean;
}): GameState {
  const base = createGame(
    mergeConfig({
      matchStructure: opts.multi ? 'multi-round-protected' : 'single',
      residual: opts.residual,
      initialSeedsPerPit: 5,
    }),
    { firstPlayer: 'S' },
  );
  const pits = Array(14).fill(0);
  pits[3] = 1;
  return {
    ...base,
    pits,
    score: { S: 34, N: 35, E: 0 },
    bank: { S: 34, N: 35, E: 0 },
    toMove: 'N', // last mover was S
    sowingsUsedThisTurn: 0,
    quietTurns: 0,
    openingComplete: true,
    roundIndex: opts.multi ? 1 : 0,
  };
}

describe('residual policy (single + multi)', () => {
  it('single unclaimed: leaves residual on board, scores unchanged, matchEnd residual', () => {
    const state = residualBoard({ residual: 'unclaimed' });
    const { state: final, events } = appendMatchEndIfTerminal(state, []);
    expect(final.pits.reduce((a, b) => a + b, 0)).toBe(1);
    expect(final.score.S).toBe(34);
    expect(final.score.N).toBe(35);
    expect(final.initialTotal).toBe(state.initialTotal);
    const end = events.find((e) => e.type === 'matchEnd');
    expect(end?.type).toBe('matchEnd');
    if (end?.type === 'matchEnd') {
      expect(end.reason).toBe('residual');
      expect(end.scores.N).toBe(35);
    }
  });

  it('single to-last-mover: residual credits previous player (S)', () => {
    const state = residualBoard({ residual: 'to-last-mover' });
    const { state: final, events } = appendMatchEndIfTerminal(state, []);
    expect(final.pits.every((n) => n === 0)).toBe(true);
    expect(final.score.S).toBe(35);
    expect(final.score.N).toBe(35);
    const end = events.find((e) => e.type === 'matchEnd');
    if (end?.type === 'matchEnd') {
      expect(end.reason).toBe('residual');
      expect(end.scores.S).toBe(35);
    }
  });
});
