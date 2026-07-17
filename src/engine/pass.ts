import { EngineError } from './errors';
import { canSkipSecond, getLegalMoves } from './moves';
import { isTerminal } from './terminal';
import { appendMatchEndIfTerminal, endTurnSwitch } from './turn';
import type { GameState, MoveEvent } from './types';

export function applyPass(
  state: GameState,
): { state: GameState; events: MoveEvent[] } {
  if (isTerminal(state)) {
    throw new EngineError('ILLEGAL_PASS', 'already terminal');
  }
  if (getLegalMoves(state).length > 0) {
    throw new EngineError('ILLEGAL_PASS', 'moves exist');
  }

  const player = state.toMove;

  // end-match policy: no pass — position is terminal
  if (state.config.emptySide === 'end-match') {
    const ended = {
      ...state,
      sowingsUsedThisTurn: 0 as const,
    };
    const events: MoveEvent[] = [
      { type: 'turnEnd', player, reason: 'empty-side-end' },
    ];
    return appendMatchEndIfTerminal(ended, events);
  }

  // pass and opponent-continues both hand the turn to the next player.
  // opponent-continues is the same rule family (auto-pass in session); keep
  // a pass event so UI/coaching can announce the empty row.
  const events: MoveEvent[] = [
    { type: 'pass', player },
    { type: 'turnEnd', player, reason: 'pass' },
  ];
  const next = endTurnSwitch({ ...state, quietTurns: state.quietTurns + 1 });
  return appendMatchEndIfTerminal(next, events);
}

/** Decline optional second sowing. */
export function applySkipSecond(
  state: GameState,
): { state: GameState; events: MoveEvent[] } {
  if (!canSkipSecond(state)) {
    throw new EngineError('ILLEGAL_MOVE', 'skip second not allowed');
  }
  const player = state.toMove;
  const events: MoveEvent[] = [
    { type: 'skipSecond', player },
    { type: 'turnEnd', player, reason: 'skip-second' },
  ];
  // First sowing captured (or skipping wouldn't be offered), so the turn
  // made progress — reset rather than increment the deadlock counter.
  return appendMatchEndIfTerminal(
    endTurnSwitch({ ...state, quietTurns: 0 }),
    events,
  );
}
