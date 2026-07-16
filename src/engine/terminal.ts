import { totalBoardSeeds } from './invariants';
import { hasLegalMove } from './moves';
import { playersInOrder } from './board';
import type { GameState, PlayerId } from './types';

/**
 * Terminal package:
 * - resign
 * - seriesOver (multi-round finished)
 * - zero seeds on board (single / residual)
 * - residual ≤1 after turn not mid-second-sowing (unclaimed residual)
 * - deadlock: too many consecutive turns without a capture
 * - empty-side end-match when no legal move
 * - seete: no legal moves for the solo player
 */

/**
 * Deadlock limits. With ≤4 seeds on the board the players can dodge each
 * other's saada forever (verified exhaustively for totals 2–4), so a short
 * fuse ends the round quickly; the long fuse is a safety net for any other
 * capture-less cycle.
 */
export const QUIET_TURN_LIMIT_LOW_SEEDS = 12;
export const QUIET_TURN_LIMIT = 40;

/** True when play has gone too long without a capture to ever progress. */
export function isDeadlocked(state: GameState): boolean {
  // Kalah-style boards make progress via store deposits, which the quiet
  // counter doesn't see; their endgames terminate via empty-side instead.
  if (state.config.engineFamily === 'kalah' || state.config.storesInCircuit) {
    return false;
  }
  const limit =
    totalBoardSeeds(state) <= 4 ? QUIET_TURN_LIMIT_LOW_SEEDS : QUIET_TURN_LIMIT;
  return state.quietTurns >= limit;
}

export function isTerminal(state: GameState): boolean {
  if (state.resigned !== null) return true;
  if (state.seriesOver) return true;

  const seeds = totalBoardSeeds(state);
  if (seeds === 0) return true;

  // Mid forced/optional second sowing: not terminal yet
  if (state.sowingsUsedThisTurn === 1) return false;

  // Multi-round boards use residual end to trigger reseed (handled in appendMatchEnd)
  // but still report terminal for residual so tryAdvance can run — actually
  // tryAdvance is called from appendMatchEnd when we'd end. isTerminal for residual:
  if (seeds <= 1) {
    // For multi-round, residual is "board end" — isTerminal true so play stops;
    // appendMatchEndIfTerminal may reopen via tryAdvanceMultiRound.
    return true;
  }

  // Deadlock: capture-less cycle (e.g. one bead per side dodging forever).
  // Multi-round treats this as a board end too (reseed via tryAdvance).
  if (isDeadlocked(state)) return true;

  // Empty-side end-match / seete: no legal move for current player and policy ends
  if (!hasLegalMove(state, state.toMove)) {
    if (state.config.playerCount === 1 || state.config.engineFamily === 'seete') {
      return true;
    }
    if (state.config.emptySide === 'end-match') {
      return true;
    }
    // pass / opponent-continues: not terminal — pass action required
    return false;
  }

  return false;
}

/** Score including Kalah on-board stores. */
export function effectiveScore(state: GameState, player: PlayerId): number {
  let n = state.score[player] ?? 0;
  if (state.config.storesInCircuit || state.config.engineFamily === 'kalah') {
    if (player === 'S') n += state.pits[6] ?? 0;
    if (player === 'N') n += state.pits[13] ?? 0;
  }
  return n;
}

export function getWinner(state: GameState): PlayerId | 'draw' | null {
  if (!isTerminal(state) && !state.seriesOver) return null;
  if (state.resigned === 'S') return bestAmong(state, ['N', 'E']);
  if (state.resigned === 'N') return bestAmong(state, ['S', 'E']);
  if (state.resigned === 'E') return bestAmong(state, ['S', 'N']);

  const players = playersInOrder(state.config);
  let best: PlayerId = players[0]!;
  let bestScore = effectiveScore(state, best);
  let tie = false;
  for (const p of players.slice(1)) {
    const sc = effectiveScore(state, p);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
      tie = false;
    } else if (sc === bestScore) {
      tie = true;
    }
  }
  if (tie) return 'draw';
  return best;
}

function bestAmong(
  state: GameState,
  candidates: PlayerId[],
): PlayerId | 'draw' {
  const active = candidates.filter((p) =>
    playersInOrder(state.config).includes(p),
  );
  if (active.length === 0) return 'draw';
  let best = active[0]!;
  let tie = false;
  for (const p of active.slice(1)) {
    if (effectiveScore(state, p) > effectiveScore(state, best)) {
      best = p;
      tie = false;
    } else if (effectiveScore(state, p) === effectiveScore(state, best)) {
      tie = true;
    }
  }
  return tie ? 'draw' : best;
}
