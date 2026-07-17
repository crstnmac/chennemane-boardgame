/**
 * Lightweight pure-logic probes for session-adjacent engine paths that
 * have historically caused soft-locks. No DOM / zustand.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  isTerminal,
  needsSecondSowing,
  previousPlayer,
  nextPlayer,
  mergeConfig,
} from '../../src/engine';

describe('session-adjacent engine smoke', () => {
  it('previousPlayer is inverse of nextPlayer for 2p', () => {
    const cfg = mergeConfig({});
    expect(previousPlayer(nextPlayer('S', cfg), cfg)).toBe('S');
    expect(previousPlayer(nextPlayer('N', cfg), cfg)).toBe('N');
  });

  it('AI-style forced second sowing always has legal moves', () => {
    // First sowing captures and leaves own seeds → second required
    const layout = [1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0];
    const s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    const { state } = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(needsSecondSowing(state)).toBe(true);
    expect(isTerminal(state)).toBe(false);
    expect(getLegalMoves(state).length).toBeGreaterThan(0);
    // Second sowing completes without soft-lock
    const m = getLegalMoves(state)[0]!;
    const { state: after } = applyMove(state, m);
    expect(needsSecondSowing(after)).toBe(false);
    expect(after.sowingsUsedThisTurn).toBe(0);
  });

  it('pass then opponent always has moves or terminal', () => {
    const layout = [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0];
    let s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    s = {
      ...s,
      score: { S: 34, N: 34, E: 0 },
      initialTotal: 70,
    };
    expect(getLegalMoves(s)).toEqual([]);
    const { state } = applyPass(s);
    expect(state.toMove).toBe('N');
    const legal = getLegalMoves(state);
    // Either N can move or board is terminal (shouldn't be with 2 seeds on N)
    expect(legal.length > 0 || isTerminal(state)).toBe(true);
  });
});
