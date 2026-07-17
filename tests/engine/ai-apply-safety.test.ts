import { describe, expect, it } from 'vitest';
import { applyMove, createGame, getLegalMoves } from '../../src/engine';
import { search } from '../../src/ai';

describe('AI search produces legal moves', () => {
  it('easy, medium, and hard always return a legal move on start position', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const trials = difficulty === 'hard' ? 3 : 10;
      for (let i = 0; i < trials; i++) {
        const s = createGame(undefined, { firstPlayer: 'S', rng: () => 0.1 });
        const move = search(s, { difficulty, rng: () => (i * 0.17) % 1 });
        const legal = getLegalMoves(s);
        expect(
          legal.some(
            (m) => m.startPit === move.startPit && m.direction === move.direction,
          ),
        ).toBe(true);
        // Must be applicable without throw
        expect(() => applyMove(s, move)).not.toThrow();
      }
    }
  });
});
