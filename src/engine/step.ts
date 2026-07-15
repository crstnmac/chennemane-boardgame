import { applyMove } from './apply';
import { applyPass, applySkipSecond } from './pass';
import { appendMatchEndIfTerminal } from './turn';
import type { Action, GameState, MoveEvent, PlayerId } from './types';

function isPass(action: Action): action is { type: 'pass' } {
  return 'type' in action && action.type === 'pass';
}

function isSkipSecond(action: Action): action is { type: 'skipSecond' } {
  return 'type' in action && action.type === 'skipSecond';
}

export function step(
  state: GameState,
  action: Action,
): { state: GameState; events: MoveEvent[] } {
  if (isPass(action)) {
    return applyPass(state);
  }
  if (isSkipSecond(action)) {
    return applySkipSecond(state);
  }
  return applyMove(state, action);
}

export function resign(
  state: GameState,
  player: PlayerId,
): { state: GameState; events: MoveEvent[] } {
  const next: GameState = {
    ...state,
    pits: state.pits.slice(),
    score: { ...state.score },
    bank: { ...state.bank },
    protectedMask: state.protectedMask.slice(),
    resigned: player,
    sowingsUsedThisTurn: 0,
    seriesOver: true,
  };
  const events: MoveEvent[] = [
    { type: 'turnEnd', player, reason: 'resign' },
  ];
  return appendMatchEndIfTerminal(next, events);
}
