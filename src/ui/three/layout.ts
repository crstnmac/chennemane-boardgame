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

/**
 * Local offsets inside a pit (Three: X right, Y up, Z depth).
 * Keep base height near the bowl floor — positive Y only stacks upper seeds.
 */
export function seedOffsets(count: number, radius: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const n = Math.min(count, 16);
  // Slightly inside bowl so seeds don't sit on the rim
  const spread = radius * 0.42;
  for (let i = 0; i < n; i++) {
    const t = i + 0.5;
    const a = t * 2.399963;
    const r = Math.min(spread, spread * Math.sqrt(t / Math.max(n, 1)));
    // Layer: first seeds on floor, later ones stack gently
    const layer = Math.floor(i / 4);
    const ly = 0.001 + layer * 0.007 + (i % 4) * 0.0008;
    out.push([Math.cos(a) * r, ly, Math.sin(a) * r]);
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
