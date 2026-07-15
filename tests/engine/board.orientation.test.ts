import { describe, expect, it } from 'vitest';
import {
  LABEL_TO_INDEX,
  nextPit,
  opposite,
  CCW_RING,
} from '../../src/engine';

const ZEROS = Array(14).fill(false);

describe('board orientation (locked)', () => {
  it('maps Wikipedia A/B labels', () => {
    expect(LABEL_TO_INDEX.A6).toBe(12);
    expect(LABEL_TO_INDEX.A5).toBe(11);
    expect(LABEL_TO_INDEX.A4).toBe(10);
    expect(LABEL_TO_INDEX.A3).toBe(9);
    expect(LABEL_TO_INDEX.B3).toBe(2);
  });

  it('A5→A4→A3 under ccw (Wikipedia anti-clockwise)', () => {
    expect(nextPit(11, 'ccw', ZEROS)).toBe(10);
    expect(nextPit(10, 'ccw', ZEROS)).toBe(9);
    expect(nextPit(9, 'ccw', ZEROS)).toBe(8);
  });

  it('A5→A6 under cw', () => {
    expect(nextPit(11, 'cw', ZEROS)).toBe(12);
  });

  it('opposite A3↔B3', () => {
    expect(opposite(9)).toBe(2);
    expect(opposite(2)).toBe(9);
  });

  it('CCW_RING is a full 14-cycle', () => {
    expect(CCW_RING).toHaveLength(14);
    expect(new Set(CCW_RING).size).toBe(14);
  });
});
