import {
  getLegalMoves,
  hasLegalMove,
  isDeadlocked,
  isTerminal,
  getWinner,
  needsSecondSowing,
  QUIET_TURN_LIMIT,
  QUIET_TURN_LIMIT_LOW_SEEDS,
  totalBoardSeeds,
  type GameState,
  type PlayerId,
} from '../engine';

/** Legal start-pit count for `player`, without double-counting directions. */
function legalStartCount(state: GameState, player: PlayerId): number {
  if (!hasLegalMove(state, player)) return 0;
  // Probe as if it were this player's turn. If the real side to move is mid
  // second sowing, clear that flag for the *other* player so isTerminal /
  // getLegalMoves don't treat the opponent as mid-second.
  const probe: GameState = {
    ...state,
    toMove: player,
    sowingsUsedThisTurn:
      state.toMove === player ? state.sowingsUsedThisTurn : 0,
  };
  if (isTerminal(probe)) return 0;
  return new Set(getLegalMoves(probe).map((m) => m.startPit)).size;
}

function opponentOf(perspective: PlayerId, state: GameState): PlayerId {
  if (perspective === 'S') return state.config.playerCount === 3 ? 'N' : 'N';
  if (perspective === 'N') return 'S';
  return 'S';
}

/**
 * Static evaluation from `perspective`'s point of view (higher = better).
 * Features tuned for Ali Guli Mane: material, mobility, second-sowing
 * pressure, quiet-turn fuse, multi-round bank depth.
 */
export function evaluate(state: GameState, perspective: PlayerId): number {
  if (isTerminal(state)) {
    const w = getWinner(state);
    if (w === 'draw') return 0;
    if (w === perspective) return 10_000;
    return -10_000;
  }

  const opp = opponentOf(perspective, state);
  const material =
    (state.score[perspective] ?? 0) - (state.score[opp] ?? 0);

  // Mobility: count legal starts (not directions) so bidirectional boards
  // don't inflate the score by 2× vs fixed-direction variants.
  const mobility =
    legalStartCount(state, perspective) - legalStartCount(state, opp);

  // Board presence on own half (2p layout; 3p uses owned bands lightly)
  let ownSeeds = 0;
  let oppSeeds = 0;
  if (state.config.playerCount === 3) {
    for (let i = 0; i < state.config.pitCount; i++) {
      const v = state.pits[i] ?? 0;
      // crude ownership by index bands (arasu split)
      if (i <= 4) {
        if (perspective === 'S') ownSeeds += v;
        else if (opp === 'S') oppSeeds += v;
      } else if (i <= 9) {
        if (perspective === 'N') ownSeeds += v;
        else if (opp === 'N') oppSeeds += v;
      } else {
        if (perspective === 'E') ownSeeds += v;
        else if (opp === 'E') oppSeeds += v;
      }
    }
  } else {
    for (let i = 0; i < 7; i++) {
      if (perspective === 'S') {
        ownSeeds += state.pits[i]!;
        oppSeeds += state.pits[i + 7]!;
      } else {
        ownSeeds += state.pits[i + 7] ?? 0;
        oppSeeds += state.pits[i]!;
      }
    }
  }

  // Forced second: owning the extra sow is a real tempo advantage.
  let secondBonus = 0;
  if (needsSecondSowing(state)) {
    secondBonus = state.toMove === perspective ? 4.5 : -4.5;
  }

  // Deadlock fuse: as quietTurns approach the limit, prefer positions that
  // already lead on material (race the residual) vs fishing for captures.
  const seeds = totalBoardSeeds(state);
  const quietLimit =
    seeds <= 4 ? QUIET_TURN_LIMIT_LOW_SEEDS : QUIET_TURN_LIMIT;
  const quietPressure = state.quietTurns / Math.max(1, quietLimit);
  const quietTerm =
    quietPressure > 0.45 ? material * (1 + quietPressure * 0.8) * 0.15 : 0;

  // Multi-round: banked score is what reseeds the next board.
  let bankTerm = 0;
  if (state.config.matchStructure === 'multi-round-protected') {
    const ownBank = state.bank[perspective] ?? state.score[perspective] ?? 0;
    const oppBank = state.bank[opp] ?? state.score[opp] ?? 0;
    const fill = state.config.initialSeedsPerPit;
    const ownPitsFillable = Math.floor(ownBank / fill);
    const oppPitsFillable = Math.floor(oppBank / fill);
    bankTerm = (ownPitsFillable - oppPitsFillable) * 2.2 + (ownBank - oppBank) * 0.05;
  }

  // Soft deadlock awareness when already deadlocked (shouldn't evaluate often)
  const dead = isDeadlocked(state) ? material * 0.5 : 0;

  return (
    material * 10 +
    mobility * 0.55 +
    (ownSeeds - oppSeeds) * 0.12 +
    secondBonus +
    quietTerm +
    bankTerm +
    dead
  );
}

export function evaluateMaterialOnly(state: GameState, perspective: PlayerId): number {
  if (isTerminal(state)) {
    const w = getWinner(state);
    if (w === 'draw') return 0;
    if (w === perspective) return 10_000;
    return -10_000;
  }
  const opp = opponentOf(perspective, state);
  return ((state.score[perspective] ?? 0) - (state.score[opp] ?? 0)) * 10;
}
