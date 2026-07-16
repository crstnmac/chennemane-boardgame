import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  EngineError,
  getLegalMoves,
  getWinner,
  hasLegalMove,
  isTerminal,
  needsSecondSowing,
  resign,
  totalBoardSeeds,
  type GameState,
  DEFAULT_CONFIG,
} from '../../src/engine';

function blank(partial: Partial<GameState> & { pits: number[] }): GameState {
  const board = partial.pits.reduce((a, b) => a + b, 0);
  const score = partial.score ?? { S: 0, N: 0, E: 0 };
  return {
    pits: partial.pits,
    score: { S: score.S ?? 0, N: score.N ?? 0, E: score.E ?? 0 },
    toMove: partial.toMove ?? 'S',
    sowingsUsedThisTurn: partial.sowingsUsedThisTurn ?? 0,
    protectedMask: partial.protectedMask ?? Array(14).fill(false),
    resigned: partial.resigned ?? null,
    initialTotal:
      partial.initialTotal ?? board + (score.S ?? 0) + (score.N ?? 0) + (score.E ?? 0),
    config: partial.config ?? { ...DEFAULT_CONFIG },
    quietTurns: partial.quietTurns ?? 0,
    openingComplete: partial.openingComplete ?? true,
    roundIndex: partial.roundIndex ?? 0,
    bank: partial.bank ?? { S: 0, N: 0, E: 0 },
    seriesOver: partial.seriesOver ?? false,
  };
}

describe('createGame', () => {
  it('uses 5 seeds by default (70 total)', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    expect(g.pits.every((n) => n === 5)).toBe(true);
    expect(g.initialTotal).toBe(70);
    expect(g.toMove).toBe('S');
  });

  it('uses injected rng for first player', () => {
    const s = createGame(undefined, { rng: () => 0.1 });
    const n = createGame(undefined, { rng: () => 0.9 });
    expect(s.toMove).toBe('S');
    expect(n.toMove).toBe('N');
  });
});

describe('legal moves', () => {
  it('bidirectional lists both dirs', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    const moves = getLegalMoves(g);
    expect(moves.length).toBe(7 * 2);
  });

  it('fixedCcw rejects cw', () => {
    const g = createGame({ directionMode: 'fixedCcw' }, { firstPlayer: 'S' });
    const moves = getLegalMoves(g);
    expect(moves.every((m) => m.direction === 'ccw')).toBe(true);
    expect(moves.length).toBe(7);
  });

  it('illegal opponent pit not listed', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    expect(getLegalMoves(g).some((m) => m.startPit >= 7)).toBe(false);
  });
});

describe('pass', () => {
  it('pass_when_own_row_empty', () => {
    const state = blank({
      pits: [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0],
      score: { S: 30, N: 38, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    expect(getLegalMoves(state)).toEqual([]);
    const { state: next, events } = applyPass(state);
    expect(next.toMove).toBe('N');
    expect(events.some((e) => e.type === 'pass')).toBe(true);
    expect(isTerminal(next)).toBe(false);
  });

  it('illegal_pass_when_moves_exist', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    expect(() => applyPass(g)).toThrow(EngineError);
  });

  it('pass then north continues when south row empty', () => {
    const state = blank({
      pits: [0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0],
      score: { S: 30, N: 37, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    const { state: afterPass } = applyPass(state);
    expect(afterPass.toMove).toBe('N');
    expect(isTerminal(afterPass)).toBe(false);
    expect(getLegalMoves(afterPass).length).toBeGreaterThan(0);
  });
});

describe('capture edges', () => {
  it('capture_empty_amounts_emits_event — no second sowing', () => {
    // Two seeds so pre-state is not terminal; sow one → residual 1 + 0 capture
    const state = blank({
      pits: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      score: { S: 34, N: 34, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    const { state: next, events } = applyMove(state, {
      startPit: 0,
      direction: 'ccw',
    });
    const cap = events.find((e) => e.type === 'capture');
    expect(cap).toEqual({ type: 'capture', pits: [3, 10], amounts: [0, 0] });
    expect(needsSecondSowing(next)).toBe(false);
    expect(events.some((e) => e.type === 'turnEnd' && e.reason === 'saada-no-capture')).toBe(
      true,
    );
  });

  it('continue_does_not_pickup_landing_pit', () => {
    const state = blank({
      pits: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      toMove: 'S',
    });
    const { events } = applyMove(state, { startPit: 0, direction: 'ccw' });
    const cont = events.find((e) => e.type === 'continue');
    expect(cont).toMatchObject({ type: 'continue', pit: 2, count: 3 });
  });

  it('capture_gt0_with_residual_on_own_row_forces_second_sowing', () => {
    const state = blank({
      pits: [1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0],
      toMove: 'S',
      initialTotal: 6,
    });
    const { state: next, events } = applyMove(state, {
      startPit: 0,
      direction: 'ccw',
    });
    expect(next.score.S).toBe(5);
    expect(totalBoardSeeds(next)).toBe(1);
    expect(needsSecondSowing(next)).toBe(true);
    expect(next.toMove).toBe('S');
    expect(isTerminal(next)).toBe(false); // second sowing still owed
    expect(events.some((e) => e.type === 'turnEnd')).toBe(false);
  });

  it('capture_gt0_no_legal_second_when_residual_on_opponent_row', () => {
    // N0=7 sows ccw: drop S0, peek S1 empty, capture S2+N2 (0). Residual on S. N empty.
    // Need ≥2 board seeds pre-move so not already terminal: put an extra seed on N that... 
    // actually after move residual=1 on S only if only seed was N's. Pre with 2 seeds on N row:
    // N0=1, N1=1. Sow N0: drop S0, peek S1 empty, capture S2+N2=0. Residual S0=1 and N1=1 → 2 seeds, not terminal.
    // For residual only on opponent after capture>0: N has 1, capture takes something from S and N.
    // N0=1, S2=2, N2=3. Drop S0, capture S2+N2. Residual S0. N empty. Capture 5 > 0, no second.
    const state = blank({
      pits: [0, 0, 2, 0, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0],
      score: { S: 30, N: 34, E: 0 },
      toMove: 'N',
      initialTotal: 70,
    });
    const { state: next, events } = applyMove(state, {
      startPit: 7,
      direction: 'ccw',
    });
    expect(next.score.N).toBe(34 + 5);
    expect(hasLegalMove(next, 'N')).toBe(false);
    expect(needsSecondSowing(next)).toBe(false);
    expect(
      events.some((e) => e.type === 'turnEnd' && e.reason === 'no-legal-second-sowing'),
    ).toBe(true);
    expect(totalBoardSeeds(next)).toBe(1);
    expect(isTerminal(next)).toBe(true);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
  });
});

describe('second sowing', () => {
  it('second_sowing_ends_turn', () => {
    // 2 seeds so first-sowing-complete state with sowingsUsed=1 is not “residual terminal”
    // Actually with sowingsUsed=1, even 1 seed is non-terminal.
    const state = blank({
      pits: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      score: { S: 0, N: 7, E: 0 },
      toMove: 'N',
      sowingsUsedThisTurn: 1,
      initialTotal: 8,
    });
    expect(needsSecondSowing(state)).toBe(true);
    expect(isTerminal(state)).toBe(false);
    const { state: next, events } = applyMove(state, {
      startPit: 11,
      direction: 'ccw',
    });
    expect(next.toMove).toBe('S');
    expect(next.sowingsUsedThisTurn).toBe(0);
    expect(needsSecondSowing(next)).toBe(false);
    expect(events.some((e) => e.type === 'turnEnd' && e.reason === 'second-saada')).toBe(
      true,
    );
    expect(isTerminal(next)).toBe(true);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
  });
});

describe('terminal', () => {
  it('empty board is terminal by score', () => {
    const state = blank({
      pits: Array(14).fill(0),
      score: { S: 40, N: 30, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    expect(isTerminal(state)).toBe(true);
    expect(getWinner(state)).toBe('S');
  });

  it('one residual seed is terminal (unclaimed) when not mid-second-sowing', () => {
    const state = blank({
      pits: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: { S: 40, N: 29, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    expect(isTerminal(state)).toBe(true);
    expect(getWinner(state)).toBe('S');
  });

  it('one residual seed mid-second-sowing is not terminal', () => {
    const state = blank({
      pits: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: { S: 40, N: 29, E: 0 },
      toMove: 'S',
      sowingsUsedThisTurn: 1,
      initialTotal: 70,
    });
    expect(isTerminal(state)).toBe(false);
    expect(getLegalMoves(state).length).toBeGreaterThan(0);
  });

  it('two seeds on board is not terminal', () => {
    const state = blank({
      pits: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: { S: 34, N: 34, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    expect(isTerminal(state)).toBe(false);
  });

  it('draw on equal scores', () => {
    const state = blank({
      pits: Array(14).fill(0),
      score: { S: 35, N: 35, E: 0 },
      toMove: 'N',
      initialTotal: 70,
    });
    expect(isTerminal(state)).toBe(true);
    expect(getWinner(state)).toBe('draw');
  });

  it('sowing that leaves one residual emits matchEnd', () => {
    // pre: 2 seeds; sow one with 0 capture → board may still have 2, or capture path
    // Capture 1 seed from a 2-seed board: S0=1, S3=1. Drop S1, capture S3+N3 → residual S1 only.
    const state = blank({
      pits: [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: { S: 34, N: 34, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    expect(isTerminal(state)).toBe(false);
    const { state: next, events } = applyMove(state, {
      startPit: 0,
      direction: 'ccw',
    });
    expect(totalBoardSeeds(next)).toBe(1);
    expect(next.score.S).toBe(35);
    // capture > 0 and residual on own row → second sowing, not yet match end
    if (needsSecondSowing(next)) {
      expect(isTerminal(next)).toBe(false);
      const { state: after2, events: ev2 } = applyMove(next, {
        startPit: next.pits.findIndex((n) => n > 0),
        direction: 'ccw',
      });
      expect(isTerminal(after2)).toBe(true);
      expect(ev2.some((e) => e.type === 'matchEnd')).toBe(true);
    } else {
      expect(isTerminal(next)).toBe(true);
      expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
    }
  });

  it('resign_mid_second_sowing', () => {
    const state = blank({
      pits: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      score: { S: 0, N: 7, E: 0 },
      toMove: 'N',
      sowingsUsedThisTurn: 1,
      initialTotal: 8,
    });
    const { state: next, events } = resign(state, 'N');
    expect(isTerminal(next)).toBe(true);
    expect(getWinner(next)).toBe('S');
    expect(events.some((e) => e.type === 'matchEnd' && e.winner === 'S')).toBe(true);
  });

  it('matchEnd payload matches getWinner and scores', () => {
    const state = blank({
      pits: [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: { S: 34, N: 34, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    let { state: next, events } = applyMove(state, {
      startPit: 0,
      direction: 'ccw',
    });
    if (needsSecondSowing(next)) {
      const pit = next.pits.findIndex((n) => n > 0);
      ({ state: next, events } = applyMove(next, { startPit: pit, direction: 'ccw' }));
    }
    const end = events.find((e) => e.type === 'matchEnd');
    expect(end).toBeDefined();
    if (end?.type === 'matchEnd') {
      expect(end.winner).toBe(getWinner(next));
      expect(end.scores).toEqual(next.score);
    }
  });
});

describe('conservation', () => {
  it('full game conserves seeds and terminates', () => {
    let state = createGame({ initialSeedsPerPit: 4 }, { firstPlayer: 'S', rng: () => 0 });
    let guard = 0;
    while (!isTerminal(state) && guard++ < 5000) {
      const moves = getLegalMoves(state);
      if (moves.length === 0) {
        state = applyPass(state).state;
        continue;
      }
      state = applyMove(state, moves[0]!).state;
      expect(totalBoardSeeds(state) + state.score.S + state.score.N).toBe(
        state.initialTotal,
      );
    }
    expect(isTerminal(state)).toBe(true);
    expect(totalBoardSeeds(state)).toBeLessThanOrEqual(1);
    expect(guard).toBeLessThan(5000);
  });
});

describe('hasLegalMove primitive', () => {
  it('does not require getLegalMoves', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    expect(hasLegalMove(g, 'S')).toBe(true);
    expect(hasLegalMove(g, 'N')).toBe(true);
    const emptyS = blank({
      pits: [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0],
      score: { S: 34, N: 34, E: 0 },
      toMove: 'S',
      initialTotal: 70,
    });
    expect(hasLegalMove(emptyS, 'S')).toBe(false);
    expect(hasLegalMove(emptyS, 'N')).toBe(true);
  });
});
