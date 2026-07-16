import { mergeConfig } from './config';
import type { GameState, PlayerId, VariantConfig } from './types';

function emptyScore(): Record<PlayerId, number> {
  return { S: 0, N: 0, E: 0 };
}

function buildPits(config: VariantConfig): number[] {
  const n = config.pitCount;
  if (config.seedFill === 'custom' && config.customLayout?.length === n) {
    return config.customLayout.slice();
  }
  if (config.storesInCircuit || config.engineFamily === 'kalah') {
    // 6 play pits per side + empty stores
    const pits = Array.from({ length: n }, () => 0);
    const seeds = config.initialSeedsPerPit;
    for (let i = 0; i < 6; i++) pits[i] = seeds;
    for (let i = 7; i < 13; i++) pits[i] = seeds;
    pits[6] = 0;
    pits[13] = 0;
    return pits;
  }
  const seeds = config.initialSeedsPerPit;
  return Array.from({ length: n }, () => seeds);
}

export function createGame(
  configPartial?: Partial<VariantConfig>,
  opts?: { firstPlayer?: PlayerId; rng?: () => number },
): GameState {
  const config = mergeConfig(configPartial);
  const pits = buildPits(config);
  const initialTotal = pits.reduce((a, b) => a + b, 0);

  let first: PlayerId;
  if (opts?.firstPlayer) {
    first = opts.firstPlayer;
  } else if (config.playerCount === 1) {
    first = 'S';
  } else {
    const rng = opts?.rng ?? Math.random;
    const order =
      config.playerCount === 3 ? (['S', 'N', 'E'] as const) : (['S', 'N'] as const);
    first = order[Math.floor(rng() * order.length)]!;
  }

  // Seete / 1p always South
  if (config.playerCount === 1) first = 'S';

  return {
    pits,
    score: emptyScore(),
    toMove: first,
    sowingsUsedThisTurn: 0,
    protectedMask: Array(config.pitCount).fill(false),
    config,
    resigned: null,
    initialTotal,
    quietTurns: 0,
    openingComplete: false,
    roundIndex: 0,
    bank: emptyScore(),
    seriesOver: false,
  };
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    pits: state.pits.slice(),
    score: { ...state.score },
    bank: { ...state.bank },
    protectedMask: state.protectedMask.slice(),
    config: {
      ...state.config,
      customLayout: state.config.customLayout?.slice(),
    },
  };
}
