/**
 * Session animation abort: skip mid-sowing must not leave displayPits
 * desynced from committed (post-await drop land race).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMove, getLegalMoves } from '../../src/engine';
import { useGameStore } from '../../src/session/store';

describe('animation abort keeps display in sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Isolate from prior suite state
    useGameStore.setState({
      committed: null,
      historyPast: [],
      historyFuture: [],
      inputLocked: false,
      thinking: false,
      animationGeneration: 0,
      searchCancelled: false,
      captureFlight: null,
      displayHand: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skip mid-sowing leaves displayPits equal to committed', async () => {
    const store = useGameStore.getState();
    store.updateSettings({
      travelSpeed: 1,
      reducedMotionOverride: 'never',
      directionMode: 'fixedCcw',
      multiRound: false,
      soundEnabled: false,
    });
    store.newGame('hotseat');

    const before = useGameStore.getState().committed!;
    const move = getLegalMoves(before)[0]!;
    const expected = applyMove(before, move).state;

    // Fire human move (async anim)
    store.selectPit(move.startPit);

    // Let a few hop sleeps start, then skip before the full sequence ends
    await vi.advanceTimersByTimeAsync(200);
    useGameStore.getState().skipAnimation();
    // Flush microtasks / resolve chain
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();

    const after = useGameStore.getState();
    expect(after.committed).not.toBeNull();
    // Skip snaps display to committed — never a partial hop land from the aborted run
    expect(after.displayPits).toEqual(after.committed!.pits);
    // And committed should be the completed move (apply happened before anim)
    expect(after.committed!.pits).toEqual(expected.pits);
    expect(after.displayScore).toEqual({
      S: expected.score.S,
      N: expected.score.N,
      E: expected.score.E ?? 0,
    });
    expect(after.inputLocked).toBe(false);
    expect(after.captureFlight).toBeNull();
  });

  it('undo mid-sowing restores prior display board, not a hybrid', async () => {
    const store = useGameStore.getState();
    store.updateSettings({
      travelSpeed: 1,
      reducedMotionOverride: 'never',
      directionMode: 'fixedCcw',
      multiRound: false,
      soundEnabled: false,
    });
    store.newGame('hotseat');

    const start = useGameStore.getState().committed!;
    const startPits = start.pits.slice();
    const move = getLegalMoves(start)[0]!;

    store.selectPit(move.startPit);
    await vi.advanceTimersByTimeAsync(150);
    useGameStore.getState().undo();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();

    const after = useGameStore.getState();
    expect(after.committed!.pits).toEqual(startPits);
    expect(after.displayPits).toEqual(startPits);
    expect(after.inputLocked).toBe(false);
  });
});
