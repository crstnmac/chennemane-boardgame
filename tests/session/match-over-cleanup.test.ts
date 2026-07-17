/**
 * Match-over and capture presentation edge cases in the session store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMove,
  createGame,
  getLegalMoves,
  isTerminal,
  mergeConfig,
  tryAdvanceMultiRound,
  type GameState,
} from '../../src/engine';
import { useGameStore } from '../../src/session/store';

describe('match over cleans selection UI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.setState({
      committed: null,
      historyPast: [],
      historyFuture: [],
      inputLocked: false,
      thinking: false,
      animationGeneration: 0,
      pendingDirection: false,
      selectedPit: null,
      showResult: false,
      captureFlight: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resign while direction sheet open clears pendingDirection', () => {
    const g = createGame({ directionMode: 'bidirectional' }, { firstPlayer: 'S' });
    useGameStore.setState({
      screen: 'game',
      mode: 'ai',
      humanPlayer: 'S',
      committed: g,
      displayPits: g.pits.slice(),
      displayScore: { S: 0, N: 0, E: 0 },
      displayProtected: g.protectedMask.slice(),
      turnPhase: 'your-turn',
      selectedPit: 2,
      pendingDirection: true,
      displayHand: 5,
      highlightPit: 2,
      highlightKind: 'select',
      inputLocked: false,
      showResult: false,
    });

    useGameStore.getState().resign();

    const s = useGameStore.getState();
    expect(s.pendingDirection).toBe(false);
    expect(s.selectedPit).toBeNull();
    expect(s.displayHand).toBeNull();
    expect(s.turnPhase).toBe('over');
    expect(s.showResult).toBe(true);
    expect(s.committed && isTerminal(s.committed)).toBe(true);
  });

  it('skip on terminal position presents the result overlay', () => {
    const g = createGame(undefined, { firstPlayer: 'S' });
    const resigned = {
      ...g,
      resigned: 'S' as const,
      seriesOver: true,
      sowingsUsedThisTurn: 0 as const,
    };
    useGameStore.setState({
      screen: 'game',
      mode: 'ai',
      humanPlayer: 'S',
      committed: resigned,
      displayPits: resigned.pits.slice(),
      displayScore: { S: 0, N: 0, E: 0 },
      turnPhase: 'animating',
      inputLocked: true,
      showResult: false,
      animationGeneration: 1,
    });

    useGameStore.getState().skipAnimation();

    const s = useGameStore.getState();
    expect(isTerminal(s.committed!)).toBe(true);
    expect(s.turnPhase).toBe('over');
    expect(s.showResult).toBe(true);
    expect(s.inputLocked).toBe(false);
  });
});

describe('multi-round reseed score vs pre-reseed capture credit', () => {
  it('tryAdvance leaves banks much smaller than pre-reseed capture totals', () => {
    // Simulates why display must not snap to committed.score at capture time:
    // after reseed, score banks are only unfilled remainders.
    const pits = Array(14).fill(0);
    pits[0] = 1;
    let s: GameState = createGame(
      mergeConfig({
        matchStructure: 'multi-round-protected',
        residual: 'unclaimed',
        seedFill: 'custom',
        customLayout: pits,
      }),
      { firstPlayer: 'S' },
    );
    s = {
      ...s,
      score: { S: 40, N: 29, E: 0 },
      initialTotal: 70,
      sowingsUsedThisTurn: 0,
      openingComplete: true,
    };
    expect(isTerminal(s)).toBe(true);
    const adv = tryAdvanceMultiRound(s);
    expect(adv).not.toBeNull();
    // Pre-reseed S had 40; after filling 7×5=35, bank is 5 — not 40.
    expect(adv!.state.score.S).toBe(5);
    expect(adv!.state.score.S).toBeLessThan(40);
  });

  it('a normal capture still conserves when score is credited incrementally', () => {
    // Fixture: S0=1 → drop S1, peek S2 empty, capture S3+N3
    const layout = [1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0];
    const before = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    const preScoreS = before.score.S;
    const { state, events } = applyMove(before, { startPit: 0, direction: 'ccw' });
    const cap = events.find((e) => e.type === 'capture');
    expect(cap && cap.type === 'capture').toBe(true);
    if (!cap || cap.type !== 'capture') return;
    const total = cap.amounts.reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
    // Incremental credit matches engine post-move score
    expect(preScoreS + total).toBe(state.score.S);
    expect(getLegalMoves(state).length).toBeGreaterThan(0);
  });
});
