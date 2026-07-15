import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  isTerminal,
} from '../../src/engine';
import { search } from '../../src/ai';

describe('AI search', () => {
  it('returns a legal move', () => {
    const state = createGame(undefined, { firstPlayer: 'S', rng: () => 0 });
    const move = search(state, { difficulty: 'easy', rng: () => 0.5 });
    const legal = getLegalMoves(state);
    expect(legal.some((m) => m.startPit === move.startPit && m.direction === move.direction)).toBe(
      true,
    );
  });

  it('applies search moves without throwing and conserves seeds', () => {
    let state = createGame({ initialSeedsPerPit: 4 }, { firstPlayer: 'S', rng: () => 0 });
    for (let i = 0; i < 30 && !isTerminal(state); i++) {
      const moves = getLegalMoves(state);
      if (moves.length === 0) {
        state = applyPass(state).state;
        continue;
      }
      const move = search(state, { difficulty: 'easy', rng: () => 0.5 });
      state = applyMove(state, move).state;
      const total =
        state.pits.reduce((a, b) => a + b, 0) + state.score.S + state.score.N;
      expect(total).toBe(state.initialTotal);
    }
    expect(true).toBe(true);
  });
});
