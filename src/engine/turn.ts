import { nextPlayer } from './board';
import { hasLegalMove } from './moves';
import { getWinner, isTerminal } from './terminal';
import { tryAdvanceMultiRound } from './multiRound';
import type { GameState, MoveEvent, PlayerId } from './types';

/** True when the current player must/may take a second sowing. */
export function needsSecondSowing(state: GameState): boolean {
  if (state.sowingsUsedThisTurn !== 1) return false;
  if (state.config.secondSowing === 'none') return false;
  return true;
}

export function endTurnSwitch(state: GameState): GameState {
  // Solitaire / seete: same player keeps going until no legal move
  if (state.config.playerCount === 1 || state.config.engineFamily === 'seete') {
    return {
      ...state,
      toMove: 'S',
      sowingsUsedThisTurn: 0,
    };
  }
  return {
    ...state,
    toMove: nextPlayer(state.toMove, state.config),
    sowingsUsedThisTurn: 0,
  };
}

/**
 * If the position is terminal, append matchEnd. Call after turn-ending transitions.
 */
export function appendMatchEndIfTerminal(
  state: GameState,
  events: MoveEvent[],
): { state: GameState; events: MoveEvent[] } {
  // Multi-round: try to open next board instead of ending
  if (
    state.config.matchStructure === 'multi-round-protected' &&
    !state.seriesOver
  ) {
    const advanced = tryAdvanceMultiRound(state);
    if (advanced) {
      return {
        state: advanced.state,
        events: [
          ...events,
          { type: 'roundEnd', roundIndex: state.roundIndex },
          ...advanced.events,
        ],
      };
    }
  }

  if (!isTerminal(state)) return { state, events };
  const winner = getWinner(state);
  if (winner === null) {
    throw new Error('appendMatchEndIfTerminal: terminal state without winner');
  }
  return {
    state: { ...state, seriesOver: true },
    events: [
      ...events,
      { type: 'matchEnd', winner, scores: { ...state.score } },
    ],
  };
}

export function afterSowing(
  state: GameState,
  capturedTotal: number,
  events: MoveEvent[],
  opts?: { extraTurn?: boolean },
): { state: GameState; events: MoveEvent[] } {
  const player: PlayerId = state.toMove;
  let s: GameState = {
    ...state,
    openingComplete: true,
    quietTurns: capturedTotal > 0 ? 0 : state.quietTurns,
  };
  // Deadlock counter: a turn ending without any capture is "quiet"
  const quietAfterEnd = capturedTotal > 0 ? 0 : state.quietTurns + 1;

  // Kalah-style extra turn (last seed in store): keep same player, sowings reset
  if (opts?.extraTurn) {
    return {
      state: { ...s, sowingsUsedThisTurn: 0 },
      events,
    };
  }

  const mode = s.config.secondSowing;

  // First sowing of the turn
  if (s.sowingsUsedThisTurn === 0) {
    if (mode === 'none') {
      const withEnd: MoveEvent[] = [
        ...events,
        { type: 'turnEnd', player, reason: 'single-sowing-end' },
      ];
      return appendMatchEndIfTerminal(
        endTurnSwitch({ ...s, quietTurns: quietAfterEnd }),
        withEnd,
      );
    }

    // mode is forced | optional
    if (capturedTotal > 0 && hasLegalMove(s, player)) {
      return {
        state: { ...s, sowingsUsedThisTurn: 1 },
        events,
      };
    }
    const reason =
      capturedTotal > 0 ? 'no-legal-second-sowing' : 'saada-no-capture';
    const withEnd: MoveEvent[] = [
      ...events,
      { type: 'turnEnd', player, reason },
    ];
    return appendMatchEndIfTerminal(
      endTurnSwitch({ ...s, quietTurns: quietAfterEnd }),
      withEnd,
    );
  }

  // Second sowing always ends the turn
  const withEnd: MoveEvent[] = [
    ...events,
    { type: 'turnEnd', player, reason: 'second-saada' },
  ];
  return appendMatchEndIfTerminal(
    endTurnSwitch({ ...s, quietTurns: quietAfterEnd }),
    withEnd,
  );
}
