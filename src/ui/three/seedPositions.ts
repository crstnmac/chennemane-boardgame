import type { PitMeta } from './pitLayout';

/**
 * Blender Z-up (x, y, z) → glTF / Three.js Y-up (x, z, -y).
 * Must match `export_yup=True` and must NOT be combined with an extra board rotation.
 */
export function blenderToThree(
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [x, z, -y];
}

/** Deterministic seed offsets inside a pit, in Three.js local space (X right, Y up, Z toward camera for south). */
export function seedOffsets(count: number, radius: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (count <= 0) return out;
  const r = radius * 0.5;
  for (let i = 0; i < count; i++) {
    const t = i + 0.5;
    const angle = t * 2.399963;
    const rad = Math.min(r, r * Math.sqrt(t / Math.max(count, 1)));
    // Local XZ on the pit floor, Y up
    const lx = Math.cos(angle) * rad;
    const lz = Math.sin(angle) * rad;
    const ly = 0.004 + (i % 4) * 0.003;
    out.push([lx, ly, lz]);
  }
  return out;
}

export function pitWorldPosition(pit: PitMeta): [number, number, number] {
  return blenderToThree(pit.x, pit.y, pit.z);
}
