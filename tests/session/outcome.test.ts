import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState } from '../../src/engine';
import { matchOutcome } from '../../src/session/outcome';

function terminal(partial: Partial<GameState> & { score: GameState['score'] }): GameState {
  return {
    pits: Array(14).fill(0),
    score: {
      S: partial.score.S ?? 0,
      N: partial.score.N ?? 0,
      E: partial.score.E ?? 0,
    },
    toMove: partial.toMove ?? 'S',
    sowingsUsedThisTurn: 0,
    protectedMask: Array(14).fill(false),
    resigned: partial.resigned ?? null,
    initialTotal: 70,
    config: { ...DEFAULT_CONFIG },
    openingComplete: true,
    roundIndex: 0,
    bank: { S: 0, N: 0, E: 0 },
    seriesOver: false,
  };
}

describe('matchOutcome', () => {
  it('ai mode you win', () => {
    const o = matchOutcome(terminal({ score: { S: 40, N: 30, E: 0 } }), {
      mode: 'ai',
      humanPlayer: 'S',
    });
    expect(o.kind).toBe('decisive');
    if (o.kind === 'decisive') {
      expect(o.title).toBe('You win');
      expect(o.southLabel).toBe('You');
      expect(o.northLabel).toBe('AI');
      expect(o.humanResult).toBe('win');
    }
  });

  it('ai mode loss', () => {
    const o = matchOutcome(terminal({ score: { S: 20, N: 50, E: 0 } }), {
      mode: 'ai',
      humanPlayer: 'S',
    });
    expect(o.kind).toBe('decisive');
    if (o.kind === 'decisive') {
      expect(o.title).toBe('AI wins');
      expect(o.humanResult).toBe('loss');
    }
  });

  it('draw', () => {
    const o = matchOutcome(terminal({ score: { S: 35, N: 35, E: 0 } }), {
      mode: 'hotseat',
      humanPlayer: 'S',
    });
    expect(o).toMatchObject({ kind: 'draw', title: 'Draw' });
  });

  it('hotseat south wins with side labels', () => {
    const o = matchOutcome(terminal({ score: { S: 40, N: 30, E: 0 } }), {
      mode: 'hotseat',
      humanPlayer: 'S',
    });
    expect(o.kind).toBe('decisive');
    if (o.kind === 'decisive') {
      expect(o.title).toBe('South wins');
      expect(o.southLabel).toBe('South');
      expect(o.northLabel).toBe('North');
    }
  });

  it('resign titles', () => {
    const ai = matchOutcome(terminal({ score: { S: 10, N: 10, E: 0 }, resigned: 'S' }), {
      mode: 'ai',
      humanPlayer: 'S',
    });
    expect(ai.kind).toBe('decisive');
    if (ai.kind === 'decisive') {
      expect(ai.title).toBe('You resigned');
      expect(ai.winner).toBe('N');
    }

    const hs = matchOutcome(terminal({ score: { S: 10, N: 10, E: 0 }, resigned: 'N' }), {
      mode: 'hotseat',
      humanPlayer: 'S',
    });
    expect(hs.kind).toBe('decisive');
    if (hs.kind === 'decisive') {
      expect(hs.title).toBe('North resigned');
      expect(hs.winner).toBe('S');
    }
  });
});
