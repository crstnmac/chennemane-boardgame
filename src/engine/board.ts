import type { Direction, PitIndex, PlayerId, VariantConfig } from './types';
import { EngineError } from './errors';

/** Wikipedia A-row = North, B-row = South (2×7) */
export const LABEL_TO_INDEX: Record<string, number> = {
  A1: 7,
  A2: 8,
  A3: 9,
  A4: 10,
  A5: 11,
  A6: 12,
  A7: 13,
  B1: 0,
  B2: 1,
  B3: 2,
  B4: 3,
  B5: 4,
  B6: 5,
  B7: 6,
};

export const INDEX_TO_LABEL: readonly string[] = [
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
];

/** Engine ccw === Wikipedia anti-clockwise: S L→R then N R→L */
export const CCW_RING = [0, 1, 2, 3, 4, 5, 6, 13, 12, 11, 10, 9, 8, 7] as const;

/** Engine cw === reverse of CCW_RING */
export const CW_RING = [0, 7, 8, 9, 10, 11, 12, 13, 6, 5, 4, 3, 2, 1] as const;

/**
 * Kalah-style ring on 14 slots: play pits 0–5 (S) and 7–12 (N);
 * stores at 6 (S) and 13 (N). Sowing includes only own store.
 */
export const KALAH_CCW_S = [0, 1, 2, 3, 4, 5, 6, 12, 11, 10, 9, 8, 7] as const;
export const KALAH_CCW_N = [7, 8, 9, 10, 11, 12, 13, 5, 4, 3, 2, 1, 0] as const;

export function opposite(i: PitIndex, pitCount = 14): PitIndex {
  const half = pitCount / 2;
  return ((i + half) % pitCount) as PitIndex;
}

/** Ownership for 2-row boards and 3-player Arasu split. */
export function ownedPits(
  player: PlayerId,
  config?: Pick<VariantConfig, 'playerCount' | 'engineFamily' | 'storesInCircuit' | 'pitsPerRow'>,
): readonly PitIndex[] {
  if (config?.engineFamily === 'arasu' || config?.playerCount === 3) {
    // 14 pits split ~evenly among three
    if (player === 'S') return [0, 1, 2, 3, 4];
    if (player === 'N') return [5, 6, 7, 8, 9];
    return [10, 11, 12, 13];
  }
  if (config?.storesInCircuit || config?.engineFamily === 'kalah') {
    // Play pits only (stores not sowable starts)
    if (player === 'S') return [0, 1, 2, 3, 4, 5];
    if (player === 'N') return [7, 8, 9, 10, 11, 12];
    return [];
  }
  if (player === 'S') return [0, 1, 2, 3, 4, 5, 6];
  if (player === 'N') return [7, 8, 9, 10, 11, 12, 13];
  return [];
}

export function ownerOf(
  pit: PitIndex,
  config?: Pick<VariantConfig, 'playerCount' | 'engineFamily' | 'storesInCircuit'>,
): PlayerId {
  if (config?.engineFamily === 'arasu' || config?.playerCount === 3) {
    if (pit <= 4) return 'S';
    if (pit <= 9) return 'N';
    return 'E';
  }
  if (config?.storesInCircuit || config?.engineFamily === 'kalah') {
    if (pit === 6) return 'S';
    if (pit === 13) return 'N';
    if (pit <= 5) return 'S';
    return 'N';
  }
  return pit < 7 ? 'S' : 'N';
}

export function isStorePit(
  pit: PitIndex,
  config: Pick<VariantConfig, 'storesInCircuit' | 'engineFamily'>,
): boolean {
  if (!(config.storesInCircuit || config.engineFamily === 'kalah')) return false;
  return pit === 6 || pit === 13;
}

export function storePitFor(player: PlayerId): PitIndex {
  return player === 'S' ? 6 : 13;
}

export function nextPit(
  from: PitIndex,
  dir: Direction,
  protectedMask: boolean[],
  opts?: {
    config?: VariantConfig;
    player?: PlayerId;
  },
): PitIndex {
  const config = opts?.config;
  const player = opts?.player;

  if (config && (config.storesInCircuit || config.engineFamily === 'kalah') && player) {
    // Direction collapsed to "forward" along player's kalah path; cw flips
    const base = player === 'S' ? KALAH_CCW_S : KALAH_CCW_N;
    const ring = dir === 'ccw' ? base : ([...base].reverse() as readonly number[]);
    const pos = ring.indexOf(from);
    if (pos < 0) {
      // starting from opponent store shouldn't happen
      throw new EngineError('BAD_PIT', `pit ${from} not in kalah ring for ${player}`);
    }
    let i = (pos + 1) % ring.length;
    let guard = 0;
    while (protectedMask[ring[i]!] && guard++ < ring.length) {
      i = (i + 1) % ring.length;
    }
    if (guard >= ring.length) {
      throw new EngineError('ALL_PROTECTED', 'no un-protected pit in ring');
    }
    // Skip opponent's store (not in ring by construction)
    return ring[i]! as PitIndex;
  }

  const ring = dir === 'ccw' ? CCW_RING : CW_RING;
  const pos = ring.indexOf(from as (typeof ring)[number]);
  if (pos < 0) throw new EngineError('BAD_PIT', `pit ${from} not in ring`);
  let i = (pos + 1) % ring.length;
  let guard = 0;
  while (protectedMask[ring[i]!] && guard++ < ring.length) {
    i = (i + 1) % ring.length;
  }
  if (guard >= ring.length) {
    throw new EngineError('ALL_PROTECTED', 'no un-protected pit in ring');
  }
  return ring[i]! as PitIndex;
}

/** Active players in turn order for this config. */
export function playersInOrder(config: VariantConfig): PlayerId[] {
  if (config.playerCount === 1 || config.engineFamily === 'seete') return ['S'];
  if (config.playerCount === 3 || config.engineFamily === 'arasu') {
    return ['S', 'N', 'E'];
  }
  return ['S', 'N'];
}

export function nextPlayer(current: PlayerId, config: VariantConfig): PlayerId {
  const order = playersInOrder(config);
  const idx = order.indexOf(current);
  if (idx < 0) return order[0]!;
  return order[(idx + 1) % order.length]!;
}

/** Player who moved immediately before `current` (inverse of nextPlayer). */
export function previousPlayer(current: PlayerId, config: VariantConfig): PlayerId {
  const order = playersInOrder(config);
  const idx = order.indexOf(current);
  if (idx < 0) return order[0]!;
  return order[(idx - 1 + order.length) % order.length]!;
}
