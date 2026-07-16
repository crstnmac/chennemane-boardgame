import { hasLegalMove } from './moves';
import { ownedPits, playersInOrder } from './board';
import { isDeadlocked } from './terminal';
import type { GameState, MoveEvent, PlayerId } from './types';

/**
 * After a residual board-end under multi-round-protected:
 * reseed each player's pits from their score; unfilled pits become protected.
 * Returns null if the series is over (nobody can move after reseed).
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

  const seedsPer = state.config.initialSeedsPerPit;
  const pitCount = state.config.pitCount;
  const pits = Array(pitCount).fill(0) as number[];
  const protectedMask = Array(pitCount).fill(false) as boolean[];

  // Score banks become the reseed fund. Residual board seeds:
  // unclaimed → drop from conservation; to-last-mover → add to that player.
  let initialTotal = state.initialTotal;
  const bank: Record<PlayerId, number> = {
    S: state.score.S ?? 0,
    N: state.score.N ?? 0,
    E: state.score.E ?? 0,
  };

  if (boardSeeds > 0) {
    if (state.config.residual === 'to-last-mover') {
      bank[state.toMove] = (bank[state.toMove] ?? 0) + boardSeeds;
    } else {
      initialTotal -= boardSeeds;
    }
  }

  const players = playersInOrder(state.config);
  for (const p of players) {
    let funds = bank[p] ?? 0;
    for (const pit of ownedPits(p, state.config)) {
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

  const next: GameState = {
    ...state,
    pits,
    protectedMask,
    score: { S: bank.S, N: bank.N, E: bank.E },
    bank: { S: bank.S, N: bank.N, E: bank.E },
    sowingsUsedThisTurn: 0,
    quietTurns: 0,
    openingComplete: true,
    roundIndex: state.roundIndex + 1,
    initialTotal,
    toMove: state.toMove,
  };

  // Docs (Appendix E): the series ends when ANY player cannot field the board
  // — i.e. cannot fill at least one of their own pits from their winnings.
  const everyoneCanField = players.every((p) =>
    ownedPits(p, state.config).some((pit) => !protectedMask[pit]),
  );
  if (!everyoneCanField) {
    return null;
  }

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
