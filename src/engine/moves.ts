import { ownedPits } from './board';
import { isTerminal } from './terminal';
import type { Direction, GameState, Move, PlayerId } from './types';

/** Primitive: never calls getLegalMoves or isTerminal */
export function hasLegalMove(state: GameState, player: PlayerId): boolean {
  for (const pit of ownedPits(player, state.config)) {
    if (state.protectedMask[pit]) continue;
    if (state.pits[pit]! > 0) return true;
  }
  return false;
}

function directionsFor(state: GameState): Direction[] {
  const mode = state.config.directionMode;
  if (mode === 'fixedCcw') return ['ccw'];
  if (mode === 'fixedCw') return ['cw'];
  if (mode === 'openingCcwThenFree' && !state.openingComplete) {
    return ['ccw'];
  }
  // bidirectional or free after opening
  return ['cw', 'ccw'];
}

export function getLegalMoves(state: GameState): Move[] {
  if (isTerminal(state)) return [];
  const player = state.toMove;
  if (!hasLegalMove(state, player)) return [];

  const dirs = directionsFor(state);
  const moves: Move[] = [];
  for (const pit of ownedPits(player, state.config)) {
    if (state.protectedMask[pit]) continue;
    if (state.pits[pit]! <= 0) continue;
    for (const direction of dirs) {
      moves.push({ startPit: pit, direction });
    }
  }
  return moves;
}

export function canSkipSecond(state: GameState): boolean {
  return (
    state.config.secondSowing === 'optional' &&
    state.sowingsUsedThisTurn === 1 &&
    !isTerminal(state)
  );
}

export function movesEqual(a: Move, b: Move): boolean {
  return a.startPit === b.startPit && a.direction === b.direction;
}
