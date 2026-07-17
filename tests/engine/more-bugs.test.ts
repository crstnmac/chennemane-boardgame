import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  getWinner,
  isTerminal,
  mergeConfig,
  resign,
  totalBoardSeeds,
  type GameState,
} from '../../src/engine';
import { tryAdvanceMultiRound } from '../../src/engine/multiRound';

function total(s: GameState) {
  return totalBoardSeeds(s) + s.score.S + s.score.N + (s.score.E ?? 0);
}

describe('more mechanics bugs', () => {
  it('resign mid-second-sowing ends match for opponent', () => {
    const layout = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    let s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    s = {
      ...s,
      sowingsUsedThisTurn: 1,
      score: { S: 20, N: 20, E: 0 },
      initialTotal: 41,
    };
    expect(isTerminal(s)).toBe(false);
    const { state, events } = resign(s, 'S');
    expect(isTerminal(state)).toBe(true);
    expect(getWinner(state)).toBe('N');
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
  });

  it('consecutive passes with one side empty still conserves', () => {
    // S empty, N has seeds
    const layout = [0, 0, 0, 0, 0, 0, 0, 5, 5, 0, 0, 0, 0, 0];
    let s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    s = { ...s, score: { S: 30, N: 30, E: 0 }, initialTotal: 70 };
    expect(getLegalMoves(s).length).toBe(0);
    const r = applyPass(s);
    expect(r.state.toMove).toBe('N');
    expect(total(r.state)).toBe(70);
    // N plays
    const legal = getLegalMoves(r.state);
    expect(legal.length).toBeGreaterThan(0);
    const r2 = applyMove(r.state, legal[0]!);
    expect(total(r2.state)).toBe(70);
  });

  it('multi-round deadlock residual bank handling conserves or drops consistently', () => {
    const layout = Array(14).fill(0);
    layout[0] = 1;
    layout[7] = 1;
    let s = createGame(
      mergeConfig({
        matchStructure: 'multi-round-protected',
        seedFill: 'custom',
        customLayout: layout,
      }),
      { firstPlayer: 'S' },
    );
    s = {
      ...s,
      score: { S: 30, N: 30, E: 0 },
      initialTotal: 62,
      quietTurns: 12,
      openingComplete: true,
    };
    expect(isTerminal(s)).toBe(true);
    const adv = tryAdvanceMultiRound(s);
    expect(adv).not.toBeNull();
    const next = adv!.state;
    // unclaimed residual: 2 seeds dropped from conservation
    expect(next.initialTotal).toBe(60);
    expect(
      next.pits.reduce((a, b) => a + b, 0) + next.score.S + next.score.N,
    ).toBe(60);
  });

  it('to-last-mover residual credits the player who just moved, not the next', () => {
    // After endTurnSwitch, toMove is N (next). Last mover was S.
    // Residual 1 seed must go to S's bank under to-last-mover.
    const pits = Array(14).fill(0);
    pits[3] = 1;
    const s = createGame(
      mergeConfig({
        matchStructure: 'multi-round-protected',
        residual: 'to-last-mover',
        seedFill: 'custom',
        customLayout: pits,
      }),
      { firstPlayer: 'S' },
    );
    const endState = {
      ...s,
      pits,
      score: { S: 34, N: 35, E: 0 },
      initialTotal: 70,
      toMove: 'N' as const, // next player after S ended the board
      sowingsUsedThisTurn: 0 as const,
      openingComplete: true,
    };
    const adv = tryAdvanceMultiRound(endState);
    expect(adv).not.toBeNull();
    // S had 34 + 1 residual = 35 → fills exactly 7 pits, bank 0
    // N had 35 → fills 7 pits, bank 0
    expect(adv!.state.score.S).toBe(0);
    expect(adv!.state.score.N).toBe(0);
    expect(adv!.state.pits.reduce((a, b) => a + b, 0)).toBe(70);
  });
});
