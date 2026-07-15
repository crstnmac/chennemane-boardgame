import layout from '../../models/pit_layout.json';

export interface PitMeta {
  index: number;
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export const PIT_LAYOUT = layout as {
  unit: string;
  boardSize: { x: number; y: number; z: number };
  pits: PitMeta[];
};

export const PITS_BY_INDEX: PitMeta[] = [...PIT_LAYOUT.pits].sort(
  (a, b) => a.index - b.index,
);
