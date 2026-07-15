import layoutJson from '../../models/store_layout.json';
import { blenderToThree } from './layout';

export type StoreSide = 'S' | 'N';

export interface StoreMeta {
  player: StoreSide;
  label: string;
  x: number;
  y: number;
  z: number;
  rotZ: number;
  seedRestZ: number;
  seedPackRadius: number;
  shellRadius: number;
  shellDepth: number;
}

const raw = layoutJson as {
  stores: Record<StoreSide, StoreMeta>;
};

export const STORES = raw.stores;

/** World position of shell origin (Three.js Y-up). */
export function storeWorldPosition(side: StoreSide): [number, number, number] {
  const s = STORES[side];
  return blenderToThree(s.x, s.y, s.z);
}

/** Yaw around world up after Blender→Three mapping. */
export function storeYaw(side: StoreSide): number {
  return STORES[side].rotZ;
}

/**
 * Pack seeds inside a coconut bowl (local shell space: Y up, opening +Y-ish).
 */
export function shellSeedOffsets(
  count: number,
  packRadius: number,
  restY: number,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  const n = Math.min(count, 28);
  const rMax = packRadius * 0.88;
  for (let i = 0; i < n; i++) {
    const t = i + 0.5;
    const a = t * 2.399963;
    const layer = Math.floor(i / 7);
    const inLayer = i % 7;
    const ring = Math.min(rMax, rMax * Math.sqrt((inLayer + 0.6) / 7));
    const ly = restY + layer * 0.0085 + (inLayer % 3) * 0.0012;
    out.push([Math.cos(a) * ring, ly, Math.sin(a) * ring * 0.92]);
  }
  return out;
}
