import { describe, expect, it } from 'vitest';
import {
  createGame,
  isTerminal,
  getWinner,
  mergeConfig,
  nextPit,
  type GameState,
} from '../../src/engine';
import { tryAdvanceMultiRound } from '../../src/engine/multiRound';
import { appendMatchEndIfTerminal } from '../../src/engine/turn';

const MULTI = { matchStructure: 'multi-round-protected' as const };

/** Multi-round game with a hand-crafted end-of-round position. */
function roundEndState(
  overrides: Partial<GameState> & { score: GameState['score'] },
): GameState {
  const base = createGame(mergeConfig({ ...MULTI, initialSeedsPerPit: 5 }), {
    firstPlayer: 'S',
  });
  const boardSeeds = (overrides.pits ?? Array(14).fill(0)).reduce(
    (a: number, b: number) => a + b,
    0,
  );
  const total =
    boardSeeds + overrides.score.S + overrides.score.N + (overrides.score.E ?? 0);
  return {
    ...base,
    pits: Array(14).fill(0),
    sowingsUsedThisTurn: 0,
    initialTotal: total,
    ...overrides,
  };
}

describe('multi-round reseed (docs Appendix E)', () => {
  it('refills each row from winnings; leftovers stay banked as score', () => {
    // 70 seeds, 5/pit. S captured 38, N captured 32.
    const state = roundEndState({ score: { S: 38, N: 32, E: 0 } });
    const adv = tryAdvanceMultiRound(state);
    expect(adv).not.toBeNull();
    const next = adv!.state;

    // S fills all 7 pits (35), banks 3. N fills 6 pits (30), 1 pit protected, banks 2.
    expect(next.pits.slice(0, 7)).toEqual([5, 5, 5, 5, 5, 5, 5]);
    expect(next.pits.slice(7).filter((n) => n === 5)).toHaveLength(6);
    expect(next.protectedMask.slice(0, 7).every((p) => !p)).toBe(true);
    expect(next.protectedMask.slice(7).filter(Boolean)).toHaveLength(1);
    expect(next.score.S).toBe(3);
    expect(next.score.N).toBe(2);
    expect(next.roundIndex).toBe(1);

    // Conservation: board + banks = original total
    const onBoard = next.pits.reduce((a, b) => a + b, 0);
    expect(onBoard + next.score.S + next.score.N).toBe(70);
  });

  it('drops an unclaimed residual seed from conservation', () => {
    // One stranded seed on the board at round end (residual: 'unclaimed').
    const pits = Array(14).fill(0);
    pits[3] = 1;
    const state = roundEndState({ pits, score: { S: 39, N: 30, E: 0 } });
    expect(state.config.residual).toBe('unclaimed');
    const adv = tryAdvanceMultiRound(state);
    expect(adv).not.toBeNull();
    const next = adv!.state;
    expect(next.initialTotal).toBe(69); // 70 - 1 unclaimed
    const onBoard = next.pits.reduce((a, b) => a + b, 0);
    expect(onBoard + next.score.S + next.score.N).toBe(69);
  });

  it('ends the series when a player cannot fill a single pit', () => {
    // N banked only 4 seeds (< 5 per pit): N cannot field the board.
    const state = roundEndState({ score: { S: 66, N: 4, E: 0 } });
    expect(tryAdvanceMultiRound(state)).toBeNull();

    // appendMatchEndIfTerminal turns that into a decisive matchEnd for S.
    const { state: final, events } = appendMatchEndIfTerminal(state, []);
    expect(final.seriesOver).toBe(true);
    const end = events.find((e) => e.type === 'matchEnd');
    expect(end).toBeDefined();
    expect(end && 'winner' in end ? end.winner : null).toBe('S');
    expect(isTerminal(final)).toBe(true);
    expect(getWinner(final)).toBe('S');
  });

  it('continues the series (roundEnd, no matchEnd) while both can field', () => {
    const state = roundEndState({ score: { S: 35, N: 35, E: 0 } });
    const { state: next, events } = appendMatchEndIfTerminal(state, []);
    expect(events.some((e) => e.type === 'roundEnd')).toBe(true);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(false);
    expect(next.roundIndex).toBe(1);
    expect(next.seriesOver).toBe(false);
    // Both filled exactly 7 pits, no protection anywhere.
    expect(next.protectedMask.every((p) => !p)).toBe(true);
  });

  it('sowing skips protected pits', () => {
    const state = roundEndState({ score: { S: 40, N: 30, E: 0 } });
    const adv = tryAdvanceMultiRound(state)!;
    const next = adv.state;
    // N filled 6 pits, exactly one protected; the ring must skip it.
    const blocked = next.protectedMask.findIndex(Boolean);
    expect(blocked).toBeGreaterThanOrEqual(7);
    for (let from = 0; from < 14; from++) {
      if (from === blocked) continue;
      expect(nextPit(from, 'ccw', next.protectedMask)).not.toBe(blocked);
      expect(nextPit(from, 'cw', next.protectedMask)).not.toBe(blocked);
    }
  });

  it('single-round games never reseed', () => {
    const single = createGame(
      mergeConfig({ matchStructure: 'single', initialSeedsPerPit: 5 }),
      { firstPlayer: 'S' },
    );
    const spent: GameState = {
      ...single,
      pits: Array(14).fill(0),
      score: { S: 40, N: 30, E: 0 },
    };
    expect(tryAdvanceMultiRound(spent)).toBeNull();
    const { state: final, events } = appendMatchEndIfTerminal(spent, []);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
    expect(final.seriesOver).toBe(true);
  });

  it('series-end still credits to-last-mover residual into final scores', () => {
    // S cannot field (3 < 5). One residual seed; last mover was S (toMove already N).
    const pits = Array(14).fill(0);
    pits[2] = 1;
    const state = roundEndState({
      pits,
      score: { S: 3, N: 66, E: 0 },
      toMove: 'N',
      config: mergeConfig({
        ...MULTI,
        residual: 'to-last-mover',
        initialSeedsPerPit: 5,
      }),
    });
    expect(tryAdvanceMultiRound(state)).toBeNull();
    const { state: final, events } = appendMatchEndIfTerminal(state, []);
    expect(final.seriesOver).toBe(true);
    expect(final.pits.every((n) => n === 0)).toBe(true);
    // Residual 1 goes to S (previous of N)
    expect(final.score.S).toBe(4);
    expect(final.score.N).toBe(66);
    const end = events.find((e) => e.type === 'matchEnd');
    expect(end && 'scores' in end ? end.scores.S : null).toBe(4);
    expect(getWinner(final)).toBe('N');
  });

  it('series-end unclaimed residual drops from conservation', () => {
    const pits = Array(14).fill(0);
    pits[2] = 1;
    const state = roundEndState({
      pits,
      score: { S: 3, N: 66, E: 0 },
      // initialTotal 70 via roundEndState helper
    });
    expect(state.config.residual).toBe('unclaimed');
    const { state: final } = appendMatchEndIfTerminal(state, []);
    expect(final.score.S).toBe(3);
    expect(final.score.N).toBe(66);
    expect(final.pits.every((n) => n === 0)).toBe(true);
    expect(final.initialTotal).toBe(69);
  });
});
