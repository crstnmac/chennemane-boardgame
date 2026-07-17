import {
  getWinner,
  isTerminal,
  type GameState,
  type MatchEndReason,
  type PlayerId,
} from '../engine';

export type GameMode = 'hotseat' | 'ai' | 'p2p';

export type MatchOutcome =
  | { kind: 'ongoing' }
  | {
      kind: 'draw';
      title: string;
      reason: 'score' | 'resign';
      endReason: MatchEndReason;
      endReasonCopy: string;
      scores: Record<PlayerId, number>;
      southLabel: string;
      northLabel: string;
    }
  | {
      kind: 'decisive';
      title: string;
      winner: PlayerId;
      reason: 'score' | 'resign';
      endReason: MatchEndReason;
      endReasonCopy: string;
      scores: Record<PlayerId, number>;
      southLabel: string;
      northLabel: string;
      /** Perspective for AI mode SFX / copy */
      humanResult: 'win' | 'loss' | null;
    };

export type PlayerNames = {
  local?: string | null;
  remote?: string | null;
};

export function playerLabel(
  player: PlayerId,
  mode: GameMode,
  human: PlayerId,
  names?: PlayerNames,
): string {
  if (mode === 'ai') {
    return player === human ? 'You' : 'AI';
  }
  if (mode === 'p2p') {
    if (player === human) {
      const n = names?.local?.trim();
      return n ? n : 'You';
    }
    const r = names?.remote?.trim();
    return r ? r : 'Opponent';
  }
  return player === 'S' ? 'South' : 'North';
}

export function sideLabel(
  side: PlayerId,
  mode: GameMode,
  human: PlayerId,
  names?: PlayerNames,
): string {
  return playerLabel(side, mode, human, names);
}

export function matchEndReasonCopy(reason: MatchEndReason): string {
  switch (reason) {
    case 'resign':
      return 'Ended by resignation.';
    case 'empty-board':
      return 'The board is empty.';
    case 'residual':
      return 'One seed left — unclaimed residual ends the match.';
    case 'deadlock':
      return 'No captures for too long — stalemate fuse ends the match.';
    case 'empty-side':
      return 'A side had no legal moves.';
    case 'series-end':
      return 'A player could not reseed the next round.';
    case 'score':
    default:
      return 'Higher score wins.';
  }
}

/**
 * Pure presentation model for the end-of-match card and status line.
 * Pass `endReason` from the last matchEnd event when available (authoritative).
 */
export function matchOutcome(
  state: GameState,
  meta: {
    mode: GameMode;
    humanPlayer: PlayerId;
    endReason?: MatchEndReason | null;
    /** P2P display names (local = this client, remote = opponent). */
    names?: PlayerNames;
  },
): MatchOutcome {
  if (!isTerminal(state)) return { kind: 'ongoing' };

  const winner = getWinner(state);
  if (winner === null) return { kind: 'ongoing' };

  const reason: 'score' | 'resign' = state.resigned !== null ? 'resign' : 'score';
  const endReason: MatchEndReason =
    meta.endReason ??
    (state.resigned !== null
      ? 'resign'
      : state.config.matchStructure === 'multi-round-protected' && state.seriesOver
        ? 'series-end'
        : 'score');
  const endReasonCopy = matchEndReasonCopy(endReason);

  const scores = { ...state.score };
  const names = meta.names;
  const southLabel = sideLabel('S', meta.mode, meta.humanPlayer, names);
  const northLabel = sideLabel('N', meta.mode, meta.humanPlayer, names);
  const localLabel = playerLabel(meta.humanPlayer, meta.mode, meta.humanPlayer, names);
  const remoteLabel = playerLabel(
    meta.humanPlayer === 'S' ? 'N' : 'S',
    meta.mode,
    meta.humanPlayer,
    names,
  );

  if (winner === 'draw') {
    return {
      kind: 'draw',
      title: 'Draw',
      reason,
      endReason,
      endReasonCopy,
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
  } else if (meta.mode === 'p2p') {
    if (winner === meta.humanPlayer) {
      title = `${localLabel} wins`;
      humanResult = 'win';
    } else {
      title = `${remoteLabel} wins`;
      humanResult = 'loss';
    }
  } else {
    title = `${winner === 'S' ? 'South' : 'North'} wins`;
  }

  if (reason === 'resign' && meta.mode === 'ai' && state.resigned === meta.humanPlayer) {
    title = 'You resigned';
  } else if (reason === 'resign' && meta.mode === 'p2p' && state.resigned === meta.humanPlayer) {
    title = `${localLabel} resigned`;
  } else if (reason === 'resign' && meta.mode === 'p2p') {
    title = `${remoteLabel} resigned`;
  } else if (reason === 'resign' && meta.mode === 'hotseat') {
    const loser = state.resigned!;
    title = `${loser === 'S' ? 'South' : 'North'} resigned`;
  }

  return {
    kind: 'decisive',
    title,
    winner,
    reason,
    endReason,
    endReasonCopy,
    scores,
    southLabel,
    northLabel,
    humanResult,
  };
}

export function outcomeStatusDetail(outcome: MatchOutcome): string {
  if (outcome.kind === 'ongoing') return '';
  return `${outcome.endReasonCopy} ${outcome.southLabel} ${outcome.scores.S} — ${outcome.northLabel} ${outcome.scores.N}`;
}
