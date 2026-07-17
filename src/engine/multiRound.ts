import { hasLegalMove } from './moves';
import { ownedPits, playersInOrder, previousPlayer } from './board';
import { isDeadlocked } from './terminal';
import type { GameState, MoveEvent, PlayerId } from './types';

/**
 * Fold residual board seeds at match/board end.
 *
 * - **to-last-mover** (single or multi): credit previousPlayer(toMove), clear pits.
 * - **unclaimed + single**: leave seed(s) on the board (visible residual); scores
 *   unchanged — conservation `board + score === initialTotal` stays intact.
 * - **unclaimed + multi-round**: clear pits and drop from `initialTotal` so the
 *   next reseed does not count abandoned seeds as bank.
 */
export function settleResidualSeeds(state: GameState): GameState {
  const boardSeeds = state.pits.reduce((a, b) => a + b, 0);
  if (boardSeeds <= 0) return state;

  const multi = state.config.matchStructure === 'multi-round-protected';

  // Single-match unclaimed: keep the bead on the board for display / conservation.
  if (!multi && state.config.residual === 'unclaimed') {
    return state;
  }

  let initialTotal = state.initialTotal;
  const score: Record<PlayerId, number> = {
    S: state.score.S ?? 0,
    N: state.score.N ?? 0,
    E: state.score.E ?? 0,
  };

  if (state.config.residual === 'to-last-mover') {
    const lastMover = previousPlayer(state.toMove, state.config);
    score[lastMover] = (score[lastMover] ?? 0) + boardSeeds;
  } else {
    // multi-round unclaimed: drop abandoned seeds from the series total
    initialTotal -= boardSeeds;
  }

  const pitCount = state.config.pitCount;
  return {
    ...state,
    pits: Array(pitCount).fill(0),
    protectedMask: Array(pitCount).fill(false),
    score: { S: score.S, N: score.N, E: score.E },
    bank: { S: score.S, N: score.N, E: score.E },
    initialTotal,
  };
}

/** Classify why the match is terminal (before residual settle mutates pits). */
export function classifyMatchEndReason(state: GameState): import('./types').MatchEndReason {
  if (state.resigned !== null) return 'resign';
  if (state.seriesOver) return 'series-end';

  const boardSeeds = state.pits.reduce((a, b) => a + b, 0);
  if (boardSeeds === 0) return 'empty-board';
  if (isDeadlocked(state)) return 'deadlock';
  if (boardSeeds <= 1 && state.sowingsUsedThisTurn !== 1) return 'residual';

  if (!hasLegalMove(state, state.toMove)) {
    if (
      state.config.emptySide === 'end-match' ||
      state.config.playerCount === 1 ||
      state.config.engineFamily === 'seete'
    ) {
      return 'empty-side';
    }
  }
  return 'score';
}

/**
 * After a residual board-end under multi-round-protected:
 * reseed each player's pits from their score; unfilled pits become protected.
 * Returns null if the series is over (a player cannot field after residual settle).
 */
export function tryAdvanceMultiRound(
  state: GameState,
): { state: GameState; events: MoveEvent[] } | null {
  if (state.config.matchStructure !== 'multi-round-protected') return null;
  if (state.resigned !== null) return null;
  if (state.seriesOver) return null;

  const boardSeeds = state.pits.reduce((a, b) => a + b, 0);
  // Board ends on residual ≤1 or on a capture-less deadlock (e.g. one bead
  // per side dodging forever) — both reseed rather than end the series.
  if (boardSeeds > 1 && !isDeadlocked(state)) return null;
  if (state.sowingsUsedThisTurn === 1) return null;

  // Apply residual policy first (same as series-end settle), then reseed from banks.
  const settled = settleResidualSeeds(state);
  const seedsPer = settled.config.initialSeedsPerPit;
  const pitCount = settled.config.pitCount;
  const pits = Array(pitCount).fill(0) as number[];
  const protectedMask = Array(pitCount).fill(false) as boolean[];

  const bank: Record<PlayerId, number> = {
    S: settled.score.S ?? 0,
    N: settled.score.N ?? 0,
    E: settled.score.E ?? 0,
  };

  const players = playersInOrder(settled.config);
  for (const p of players) {
    let funds = bank[p] ?? 0;
    for (const pit of ownedPits(p, settled.config)) {
      if (funds >= seedsPer) {
        pits[pit] = seedsPer;
        funds -= seedsPer;
      } else {
        protectedMask[pit] = true;
        pits[pit] = 0;
      }
    }
    bank[p] = funds;
  }

  // Docs (Appendix E): the series ends when ANY player cannot field the board
  // — i.e. cannot fill at least one of their own pits from their winnings.
  const everyoneCanField = players.every((p) =>
    ownedPits(p, settled.config).some((pit) => !protectedMask[pit]),
  );
  if (!everyoneCanField) {
    return null;
  }

  const next: GameState = {
    ...settled,
    pits,
    protectedMask,
    score: { S: bank.S, N: bank.N, E: bank.E },
    bank: { S: bank.S, N: bank.N, E: bank.E },
    sowingsUsedThisTurn: 0,
    quietTurns: 0,
    openingComplete: true,
    roundIndex: settled.roundIndex + 1,
    toMove: settled.toMove,
  };

  let toMove = next.toMove;
  let guard = 0;
  while (!hasLegalMove(next, toMove) && guard++ < players.length) {
    const idx = players.indexOf(toMove);
    toMove = players[(idx + 1) % players.length]!;
  }

  return {
    state: {
      ...next,
      toMove,
      pits: pits.slice(),
      protectedMask: protectedMask.slice(),
    },
    events: [],
  };
}
