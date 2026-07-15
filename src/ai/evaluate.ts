import {
  getLegalMoves,
  hasLegalMove,
  isTerminal,
  getWinner,
  type GameState,
  type PlayerId,
} from '../engine';

export function evaluate(state: GameState, perspective: PlayerId): number {
  if (isTerminal(state)) {
    const w = getWinner(state);
    if (w === 'draw') return 0;
    if (w === perspective) return 10_000;
    return -10_000;
  }

  const opp: PlayerId =
    perspective === 'S' ? 'N' : perspective === 'N' ? 'S' : 'S';
  const material =
    (state.score[perspective] ?? 0) - (state.score[opp] ?? 0);
  const mobility =
    (hasLegalMove(state, perspective)
      ? getLegalMoves({ ...state, toMove: perspective }).length
      : 0) - (hasLegalMove(state, opp) ? 1 : 0);

  // light board presence on half-board (2p layout)
  let ownSeeds = 0;
  let oppSeeds = 0;
  for (let i = 0; i < 7; i++) {
    if (perspective === 'S') {
      ownSeeds += state.pits[i]!;
      oppSeeds += state.pits[i + 7]!;
    } else {
      ownSeeds += state.pits[i + 7] ?? 0;
      oppSeeds += state.pits[i]!;
    }
  }

  return material * 10 + mobility * 0.5 + (ownSeeds - oppSeeds) * 0.1;
}

export function evaluateMaterialOnly(state: GameState, perspective: PlayerId): number {
  if (isTerminal(state)) {
    const w = getWinner(state);
    if (w === 'draw') return 0;
    if (w === perspective) return 10_000;
    return -10_000;
  }
  const opp: PlayerId = perspective === 'S' ? 'N' : 'S';
  return ((state.score[perspective] ?? 0) - (state.score[opp] ?? 0)) * 10;
}
