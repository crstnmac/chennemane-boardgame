import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  isTerminal,
  totalBoardSeeds,
  type GameState,
  type MoveEvent,
} from '../../src/engine';

function total(s: GameState) {
  return totalBoardSeeds(s) + s.score.S + s.score.N + (s.score.E ?? 0);
}

function replayPits(start: number[], events: MoveEvent[]): number[] {
  const pits = start.slice();
  for (const e of events) {
    if (e.type === 'pickup' || e.type === 'continue') {
      pits[e.pit] = 0;
    } else if (e.type === 'drop') {
      pits[e.pit] = (pits[e.pit] ?? 0) + 1;
    } else if (e.type === 'capture') {
      for (const p of e.pits) pits[p] = 0;
    }
  }
  return pits;
}

function replayHandCheck(start: number[], events: MoveEvent[]): string | null {
  const pits = start.slice();
  let hand = 0;
  for (const e of events) {
    if (e.type === 'pickup') {
      if (pits[e.pit] !== e.count) return `pickup count ${e.count} vs pit ${pits[e.pit]}`;
      hand = e.count;
      pits[e.pit] = 0;
    } else if (e.type === 'continue') {
      if (pits[e.pit] !== e.count) return `continue count ${e.count} vs pit ${pits[e.pit]}`;
      hand = e.count;
      pits[e.pit] = 0;
    } else if (e.type === 'drop') {
      pits[e.pit]++;
      hand--;
      if (hand !== e.remainingInHand) return `hand ${hand} vs remaining ${e.remainingInHand}`;
      if (hand < 0) return 'negative hand';
    } else if (e.type === 'capture') {
      for (let i = 0; i < e.pits.length; i++) {
        const p = e.pits[i]!;
        const a = e.amounts[i]!;
        if (pits[p] !== a) return `capture pit ${p}: amount ${a} vs ${pits[p]}`;
        pits[p] = 0;
      }
    }
  }
  if (hand !== 0) return `hand leftover ${hand}`;
  return null;
}

describe('bead logic fuzz', () => {
  it('conserves seeds and event-replays match across 300 random games', () => {
    let maxPit = 0;
    let maxScore = 0;
    let zeroCap = 0;
    let games = 0;

    for (let g = 0; g < 300; g++) {
      let s = createGame(undefined, {
        firstPlayer: g % 2 === 0 ? 'S' : 'N',
      });
      const initial = s.initialTotal;
      let moves = 0;
      while (!isTerminal(s) && moves < 500) {
        const legal = getLegalMoves(s);
        if (legal.length === 0) {
          s = applyPass(s).state;
          moves++;
          continue;
        }
        const m = legal[(g * 17 + moves * 3) % legal.length]!;
        const before = s.pits.slice();
        const { state, events } = applyMove(s, m);

        expect(total(state)).toBe(initial);

        const handErr = replayHandCheck(before, events);
        expect(handErr).toBeNull();

        const replayed = replayPits(before, events);
        expect(replayed).toEqual(state.pits);

        for (const n of state.pits) maxPit = Math.max(maxPit, n);
        maxScore = Math.max(maxScore, state.score.S, state.score.N);
        for (const e of events) {
          if (e.type === 'capture' && e.amounts.every((a) => a === 0)) zeroCap++;
        }

        s = state;
        moves++;
      }
      games++;
    }

    // Report for humans — not assertions
    expect(games).toBe(300);
    expect(maxPit).toBeGreaterThan(5);
    // Visual caps in UI: pit shows ≤12 beads, seedOffsets ≤16 — flag if exceeded often
    console.log({ maxPit, maxScore, zeroCap, games });
  });
});
