import type { GameState } from './types';
import { EngineError } from './errors';

export function totalBoardSeeds(state: GameState): number {
  return state.pits.reduce((a, b) => a + b, 0);
}

export function totalScore(state: GameState): number {
  return (state.score.S ?? 0) + (state.score.N ?? 0) + (state.score.E ?? 0);
}

export function assertInvariants(state: GameState, hand = 0): void {
  const n = state.config.pitCount;
  if (state.pits.length !== n) {
    throw new EngineError('INVARIANT', `pits length must be ${n}`);
  }
  if (state.protectedMask.length !== n) {
    throw new EngineError('INVARIANT', `protectedMask length must be ${n}`);
  }
  for (const x of state.pits) {
    if (x < 0 || !Number.isInteger(x)) {
      throw new EngineError('INVARIANT', 'negative or non-integer seeds');
    }
  }
  const total = totalBoardSeeds(state) + totalScore(state) + hand;
  if (total !== state.initialTotal) {
    throw new EngineError(
      'INVARIANT',
      `seed conservation broken: ${total} !== ${state.initialTotal}`,
    );
  }
}
