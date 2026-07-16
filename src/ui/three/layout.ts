import layoutJson from '../../models/pit_layout.json';

export interface PitMeta {
  index: number;
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

const raw = layoutJson as {
  pits: PitMeta[];
  boardSize: { x: number; y: number; z: number };
  playSurface?: { x: number; y: number; z: number };
};

/** Blender Z-up → Three Y-up (matches glTF export_yup). */
export function blenderToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

export const PITS: PitMeta[] = [...raw.pits].sort((a, b) => a.index - b.index);

/** Pit bowl rest point in Three.js world space. */
export function pitPosition(index: number): [number, number, number] {
  const p = PITS[index];
  if (!p) return [0, 0.036, 0];
  return blenderToThree(p.x, p.y, p.z);
}

/** Max beads drawn in a single pit (labels still show the true count). */
export const MAX_PIT_SEEDS_DRAWN = 24;

/**
 * Local offsets inside a pit (Three: X right, Y up, Z depth).
 * Keep base height near the bowl floor — positive Y only stacks upper seeds.
 * Packs up to {@link MAX_PIT_SEEDS_DRAWN}; late-game pits can hold more
 * (fuzz saw ≥23) so the visual count must not silently cap at 12.
 */
export function seedOffsets(count: number, radius: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const n = Math.min(count, MAX_PIT_SEEDS_DRAWN);
  // Slightly inside bowl so seeds don't sit on the rim
  const spread = radius * 0.44;
  const perLayer = 5;
  for (let i = 0; i < n; i++) {
    const t = i + 0.5;
    const a = t * 2.399963;
    const layer = Math.floor(i / perLayer);
    const inLayer = i % perLayer;
    const layerSpread = spread * (1 - layer * 0.06);
    const r = Math.min(
      layerSpread,
      layerSpread * Math.sqrt((inLayer + 0.55) / perLayer),
    );
    const ly = 0.001 + layer * 0.0075 + (inLayer % 3) * 0.0009;
    out.push([Math.cos(a) * r, ly, Math.sin(a) * r * 0.95]);
  }
  return out;
}

export const BOARD_META = {
  size: raw.boardSize,
  pitRadius: PITS[0]?.radius ?? 0.044,
  /** Play-surface height (rim), Three.js Y — rings/labels sit here, seeds use pit.z floor */
  surfaceY: raw.playSurface?.z ?? 0.055,
};

/** Horizontal pit center + surface height for rings / hit targets. */
export function pitSurfacePosition(index: number): [number, number, number] {
  const p = PITS[index];
  if (!p) return [0, BOARD_META.surfaceY, 0];
  const [x, , z] = blenderToThree(p.x, p.y, p.z);
  return [x, BOARD_META.surfaceY + 0.001, z];
}
