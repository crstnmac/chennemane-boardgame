import {
  applyMoveSilent,
  applyPass,
  getLegalMoves,
  isTerminal,
  type GameState,
  type Move,
  type PlayerId,
} from '../engine';
import { evaluate, evaluateMaterialOnly } from './evaluate';

export type Difficulty = 'easy' | 'medium';

export interface SearchOptions {
  difficulty: Difficulty;
  cancelled?: () => boolean;
  rng?: () => number;
}

const BUDGETS: Record<
  Difficulty,
  { depth: number; timeMs: number; materialOnly: boolean; epsilon: number }
> = {
  // Search can finish quickly; UI enforces a minimum "thinking" display time.
  easy: { depth: 2, timeMs: 180, materialOnly: true, epsilon: 0.18 },
  medium: { depth: 4, timeMs: 900, materialOnly: false, epsilon: 0 },
};

function orderMoves(state: GameState, moves: Move[]): Move[] {
  // Prefer moves that start from pits with more seeds (heuristic ordering)
  return [...moves].sort((a, b) => state.pits[b.startPit]! - state.pits[a.startPit]!);
}

export function search(state: GameState, opts: SearchOptions): Move {
  const budget = BUDGETS[opts.difficulty];
  const rng = opts.rng ?? Math.random;
  const perspective = state.toMove;
  const moves = getLegalMoves(state);
  if (moves.length === 0) {
    throw new Error('search called with no legal moves — use applyPass');
  }

  if (opts.difficulty === 'easy' && rng() < budget.epsilon) {
    return moves[Math.floor(rng() * moves.length)]!;
  }

  const deadline = performance.now() + budget.timeMs;
  let nodes = 0;
  let bestMove = moves[0]!;
  let bestScore = -Infinity;

  const evalFn = budget.materialOnly ? evaluateMaterialOnly : evaluate;

  function minimax(
    s: GameState,
    depth: number,
    alpha: number,
    beta: number,
    maximizing: boolean,
  ): number {
    nodes++;
    if (nodes % 256 === 0) {
      if (opts.cancelled?.() || performance.now() > deadline) {
        return evalFn(s, perspective);
      }
    }
    if (depth === 0 || isTerminal(s)) {
      return evalFn(s, perspective);
    }

    const legal = getLegalMoves(s);
    if (legal.length === 0) {
      const next = applyPass(s).state;
      return minimax(next, depth - 1, alpha, beta, next.toMove === perspective);
    }

    const ordered = orderMoves(s, legal);
    if (maximizing) {
      let value = -Infinity;
      for (const m of ordered) {
        const child = applyMoveSilent(s, m);
        value = Math.max(
          value,
          minimax(child, depth - 1, alpha, beta, child.toMove === perspective),
        );
        alpha = Math.max(alpha, value);
        if (alpha >= beta) break;
      }
      return value;
    } else {
      let value = Infinity;
      for (const m of ordered) {
        const child = applyMoveSilent(s, m);
        value = Math.min(
          value,
          minimax(child, depth - 1, alpha, beta, child.toMove === perspective),
        );
        beta = Math.min(beta, value);
        if (alpha >= beta) break;
      }
      return value;
    }
  }

  // Iterative deepening for medium
  const maxDepth = budget.depth;
  for (let d = 1; d <= maxDepth; d++) {
    if (opts.cancelled?.() || performance.now() > deadline) break;
    let depthBest = bestMove;
    let depthScore = -Infinity;
    const ordered = orderMoves(state, moves);
    for (const m of ordered) {
      if (opts.cancelled?.() || performance.now() > deadline) break;
      const child = applyMoveSilent(state, m);
      const score = minimax(
        child,
        d - 1,
        -Infinity,
        Infinity,
        child.toMove === perspective,
      );
      if (score > depthScore) {
        depthScore = score;
        depthBest = m;
      }
    }
    bestMove = depthBest;
    bestScore = depthScore;
  }

  // Tie-break: among moves equal at depth-1 material, keep bestMove
  void bestScore;
  void (perspective as PlayerId);
  return bestMove;
}
