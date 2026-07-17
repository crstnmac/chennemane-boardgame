import { executeSowing } from './apply';
import { getLegalMoves, movesEqual } from './moves';
import { isTerminal } from './terminal';
import type { Direction, GameState, Move, PitIndex } from './types';

/** Lightweight preview of what a legal sow would do (for board highlights). */
export interface MovePreview {
  path: PitIndex[];
  saadaEmpty: PitIndex | null;
  capturePits: PitIndex[];
  captureTotal: number;
  forcesSecond: boolean;
}

/**
 * Simulate a legal move's events without mutating the live session.
 * Returns null if the move is illegal or the position is terminal.
 */
export function previewMoveConsequences(
  state: GameState,
  move: Move,
): MovePreview | null {
  if (isTerminal(state)) return null;
  const legal = getLegalMoves(state);
  if (!legal.some((m) => movesEqual(m, move))) return null;

  try {
    const { events, capturedTotal } = executeSowing(
      state,
      move.startPit,
      move.direction,
    );
    const path: PitIndex[] = [];
    let saadaEmpty: PitIndex | null = null;
    const capturePits: PitIndex[] = [];
    for (const e of events) {
      if (e.type === 'drop') path.push(e.pit);
      if (e.type === 'continue') path.push(e.pit);
      if (e.type === 'saada') saadaEmpty = e.emptyPit;
      if (e.type === 'capture') {
        for (let i = 0; i < e.pits.length; i++) {
          if ((e.amounts[i] ?? 0) > 0) capturePits.push(e.pits[i]!);
        }
      }
    }
    return {
      path,
      saadaEmpty,
      capturePits,
      captureTotal: capturedTotal,
      forcesSecond: capturedTotal > 0,
    };
  } catch {
    return null;
  }
}

/** Default direction for previews when the player has not chosen yet. */
export function defaultPreviewDirection(state: GameState): Direction {
  const mode = state.config.directionMode;
  if (mode === 'fixedCw') return 'cw';
  return 'ccw';
}
