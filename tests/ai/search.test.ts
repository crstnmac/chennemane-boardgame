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

  it('cancelled search still returns a legal move (keeps last complete depth)', () => {
    const state = createGame(undefined, { firstPlayer: 'S', rng: () => 0 });
    const legal = getLegalMoves(state);
    // Cancel immediately: no depth commits; fallback is first legal move.
    const move = search(state, {
      difficulty: 'medium',
      cancelled: () => true,
    });
    expect(
      legal.some((m) => m.startPit === move.startPit && m.direction === move.direction),
    ).toBe(true);
  });

  it('medium search returns a legal move on the start position', () => {
    const state = createGame(undefined, { firstPlayer: 'S', rng: () => 0 });
    const legal = getLegalMoves(state);
    const move = search(state, { difficulty: 'medium' });
    expect(
      legal.some((m) => m.startPit === move.startPit && m.direction === move.direction),
    ).toBe(true);
  });

  it('hard search returns a legal move on the start position', () => {
    const state = createGame(undefined, { firstPlayer: 'S', rng: () => 0 });
    const legal = getLegalMoves(state);
    const move = search(state, { difficulty: 'hard' });
    expect(
      legal.some((m) => m.startPit === move.startPit && m.direction === move.direction),
    ).toBe(true);
  });
});
