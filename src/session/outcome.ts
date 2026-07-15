import { getWinner, isTerminal, type GameState, type PlayerId } from '../engine';

export type GameMode = 'hotseat' | 'ai';

export type MatchOutcome =
  | { kind: 'ongoing' }
  | {
      kind: 'draw';
      title: string;
      reason: 'score' | 'resign';
      scores: Record<PlayerId, number>;
      southLabel: string;
      northLabel: string;
    }
  | {
      kind: 'decisive';
      title: string;
      winner: PlayerId;
      reason: 'score' | 'resign';
      scores: Record<PlayerId, number>;
      southLabel: string;
      northLabel: string;
      /** Perspective for AI mode SFX / copy */
      humanResult: 'win' | 'loss' | null;
    };

export function playerLabel(
  player: PlayerId,
  mode: GameMode,
  human: PlayerId,
): string {
  if (mode === 'ai') {
    return player === human ? 'You' : 'AI';
  }
  return player === 'S' ? 'South' : 'North';
}

export function sideLabel(
  side: PlayerId,
  mode: GameMode,
  human: PlayerId,
): string {
  return playerLabel(side, mode, human);
}

/**
 * Pure presentation model for the end-of-match card and status line.
 */
export function matchOutcome(
  state: GameState,
  meta: { mode: GameMode; humanPlayer: PlayerId },
): MatchOutcome {
  if (!isTerminal(state)) return { kind: 'ongoing' };

  const winner = getWinner(state);
  if (winner === null) return { kind: 'ongoing' };

  const reason: 'score' | 'resign' = state.resigned !== null ? 'resign' : 'score';
  const scores = { ...state.score };
  const southLabel = sideLabel('S', meta.mode, meta.humanPlayer);
  const northLabel = sideLabel('N', meta.mode, meta.humanPlayer);

  if (winner === 'draw') {
    return {
      kind: 'draw',
      title: 'Draw',
      reason,
      scores,
      southLabel,
      northLabel,
    };
  }

  let title: string;
  let humanResult: 'win' | 'loss' | null = null;

  if (meta.mode === 'ai') {
    if (winner === meta.humanPlayer) {
      title = 'You win';
      humanResult = 'win';
    } else {
      title = 'AI wins';
      humanResult = 'loss';
    }
  } else {
    title = `${winner === 'S' ? 'South' : 'North'} wins`;
  }

  if (reason === 'resign' && meta.mode === 'ai' && state.resigned === meta.humanPlayer) {
    title = 'You resigned';
  } else if (reason === 'resign' && meta.mode === 'hotseat') {
    const loser = state.resigned!;
    title = `${loser === 'S' ? 'South' : 'North'} resigned`;
  }

  return {
    kind: 'decisive',
    title,
    winner,
    reason,
    scores,
    southLabel,
    northLabel,
    humanResult,
  };
}

export function outcomeStatusDetail(outcome: MatchOutcome): string {
  if (outcome.kind === 'ongoing') return '';
  if (outcome.kind === 'draw') {
    return `${outcome.southLabel} ${outcome.scores.S} — ${outcome.northLabel} ${outcome.scores.N}`;
  }
  return `${outcome.southLabel} ${outcome.scores.S} — ${outcome.northLabel} ${outcome.scores.N}`;
}
