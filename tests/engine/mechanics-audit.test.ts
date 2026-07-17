import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  getWinner,
  isTerminal,
  needsSecondSowing,
  totalBoardSeeds,
  type GameState,
} from '../../src/engine';

function total(s: GameState) {
  return totalBoardSeeds(s) + s.score.S + s.score.N + (s.score.E ?? 0);
}

function randomPlay(seed: number, maxPlies: number) {
  let s = createGame(undefined, {
    firstPlayer: seed % 2 === 0 ? 'S' : 'N',
  });
  const initial = s.initialTotal;
  let plies = 0;
  while (!isTerminal(s) && plies < maxPlies) {
    const legal = getLegalMoves(s);
    if (legal.length === 0) {
      s = applyPass(s).state;
    } else {
      const m = legal[(seed * 31 + plies * 17) % legal.length]!;
      const { state, events } = applyMove(s, m);
      // conservation
      expect(total(state)).toBe(initial);
      // quietTurns non-negative
      expect(state.quietTurns).toBeGreaterThanOrEqual(0);
      // if mid second sowing after this move, must have captured on this path
      if (state.sowingsUsedThisTurn === 1) {
        expect(needsSecondSowing(state)).toBe(true);
        expect(getLegalMoves(state).length).toBeGreaterThan(0);
        // quiet should be 0 after capture that forced second
        expect(state.quietTurns).toBe(0);
      }
      // never both terminal and second sowing pending
      if (isTerminal(state)) {
        expect(state.sowingsUsedThisTurn).toBe(0);
      }
      // matchEnd only when series over or single terminal
      if (events.some((e) => e.type === 'matchEnd')) {
        expect(isTerminal(state) || state.seriesOver).toBe(true);
        expect(getWinner(state)).not.toBeNull();
      }
      s = state;
    }
    plies++;
  }
  if (isTerminal(s)) {
    expect(getWinner(s)).not.toBeNull();
    // terminal states should not offer moves
    expect(getLegalMoves(s)).toEqual([]);
  }
  return { s, plies, initial };
}

describe('mechanics audit', () => {
  it('random games conserve and keep second-sowing invariants', () => {
    for (let seed = 0; seed < 80; seed++) {
      randomPlay(seed, 500);
    }
  });

  it('illegal pass when moves exist', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    expect(() => applyPass(g)).toThrow();
  });

  it('cannot move when terminal residual', () => {
    const layout = Array(14).fill(0);
    layout[3] = 1;
    const s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    // 1 seed residual — terminal if not mid second sowing
    expect(isTerminal(s)).toBe(true);
    expect(getLegalMoves(s)).toEqual([]);
  });

  it('forced second sowing is not terminal even with 1 seed if sowingsUsed=1', () => {
    const layout = Array(14).fill(0);
    layout[5] = 1;
    let s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    s = { ...s, sowingsUsedThisTurn: 1, score: { S: 10, N: 10, E: 0 }, initialTotal: 21 };
    expect(needsSecondSowing(s)).toBe(true);
    expect(isTerminal(s)).toBe(false);
    expect(getLegalMoves(s).length).toBeGreaterThan(0);
  });

  it('openingCcwThenFree locks first move to ccw', () => {
    const g = createGame(
      { directionMode: 'openingCcwThenFree' },
      { firstPlayer: 'S' },
    );
    expect(g.openingComplete).toBe(false);
    const moves = getLegalMoves(g);
    expect(moves.every((m) => m.direction === 'ccw')).toBe(true);
    const { state } = applyMove(g, moves[0]!);
    // after first complete turn openingComplete true - may still be second sowing
    // After full first sowing that ends turn:
    if (state.sowingsUsedThisTurn === 0) {
      expect(state.openingComplete).toBe(true);
      const next = getLegalMoves(state);
      if (next.length) {
        expect(next.some((m) => m.direction === 'cw')).toBe(true);
      }
    }
  });

  it('pass when empty row advances turn and increments quietTurns', () => {
    const layout = [0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0];
    const s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    // adjust total
    const fixed = {
      ...s,
      score: { S: 30, N: 37, E: 0 },
      initialTotal: 70,
    };
    expect(getLegalMoves(fixed)).toEqual([]);
    const { state } = applyPass(fixed);
    expect(state.toMove).toBe('N');
    expect(state.quietTurns).toBe(1);
  });
});
