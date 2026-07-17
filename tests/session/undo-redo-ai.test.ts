/**
 * Undo/redo across AI plies must skip AI-to-move checkpoints so redo
 * restores the recorded post-AI position instead of re-searching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMove,
  createGame,
  getLegalMoves,
  type GameState,
} from '../../src/engine';
import { useGameStore } from '../../src/session/store';

/** Play until `toMove === player` or terminal; returns last state. */
function playUntilTurn(state: GameState, player: 'S' | 'N', max = 8): GameState {
  let s = state;
  for (let i = 0; i < max; i++) {
    if (s.toMove === player) return s;
    const moves = getLegalMoves(s);
    if (moves.length === 0) return s;
    s = applyMove(s, moves[0]!).state;
  }
  return s;
}

describe('undo/redo through AI plies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.setState({
      committed: null,
      historyPast: [],
      historyFuture: [],
      inputLocked: false,
      thinking: false,
      animationGeneration: 0,
      searchCancelled: false,
      mode: 'ai',
      humanPlayer: 'S',
      captureFlight: null,
      displayHand: null,
      selectedPit: null,
      pendingDirection: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('undo jumps back past AI-to-move; redo restores post-AI board', async () => {
    const h0 = createGame(
      { directionMode: 'fixedCcw', initialSeedsPerPit: 5 },
      { firstPlayer: 'S' },
    );

    // Complete human's full turn (including forced second sowing if any)
    const afterHumanTurn = playUntilTurn(
      applyMove(h0, getLegalMoves(h0)[0]!).state,
      'N',
    );
    expect(afterHumanTurn.toMove).toBe('N');

    const aiMove = getLegalMoves(afterHumanTurn)[0]!;
    const afterAi = applyMove(afterHumanTurn, aiMove).state;
    // Finish AI second sowing if granted so committed is human-to-move again
    const h2 = playUntilTurn(afterAi, 'S');

    // History as the session records it: each applyMove is one ply
    // [h0, afterHumanTurn] → after AI first ply would be afterAi, but we
    // seed the typical case undo sees: past = [start, AI-to-move], committed = post-AI
    // When AI had only one sowing, h2 === afterAi or later human turn.
    const historyPast: GameState[] = [h0, afterHumanTurn];
    // If AI got a second sowing, the session would also have intermediate states;
    // include them so redo has something to skip.
    if (afterAi !== h2 && afterAi.toMove === 'N') {
      historyPast.push(afterAi);
    }

    useGameStore.setState({
      mode: 'ai',
      humanPlayer: 'S',
      committed: h2,
      historyPast,
      historyFuture: [],
      displayPits: h2.pits.slice(),
      displayScore: { S: h2.score.S, N: h2.score.N, E: h2.score.E ?? 0 },
      displayProtected: h2.protectedMask.slice(),
      displayRound: h2.roundIndex,
      turnPhase: 'your-turn',
      inputLocked: false,
      thinking: false,
      showResult: false,
      screen: 'game',
    });

    useGameStore.getState().undo();
    await Promise.resolve();

    const afterUndo = useGameStore.getState();
    expect(afterUndo.committed!.pits).toEqual(h0.pits);
    expect(afterUndo.committed!.toMove).toBe('S');
    // Future holds AI-to-move (+ optional intermediates) then post-AI
    expect(afterUndo.historyFuture.length).toBeGreaterThanOrEqual(2);
    expect(afterUndo.historyFuture.some((s) => s.toMove === 'N')).toBe(true);

    useGameStore.getState().redo();
    await Promise.resolve();

    const afterRedo = useGameStore.getState();
    expect(afterRedo.committed!.pits).toEqual(h2.pits);
    expect(afterRedo.committed!.toMove).toBe(h2.toMove);
    expect(afterRedo.historyFuture.length).toBe(0);
    // Past restored: every skipped AI checkpoint is still undoable
    expect(afterRedo.historyPast.length).toBe(historyPast.length);
    expect(afterRedo.displayPits).toEqual(h2.pits);
  });
});
