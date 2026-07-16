import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  isTerminal,
  QUIET_TURN_LIMIT_LOW_SEEDS,
  type GameState,
  type MoveEvent,
} from '../../src/engine';

/** 1 bead on each side at the given pits, everything else empty. */
function twoBeadGame(
  sPit: number,
  nPit: number,
  first: 'S' | 'N',
  extra?: Partial<Parameters<typeof createGame>[0] & object>,
): GameState {
  const layout = Array(14).fill(0) as number[];
  layout[sPit] = 1;
  layout[nPit] = 1;
  return createGame(
    { seedFill: 'custom', customLayout: layout, ...extra },
    { firstPlayer: first },
  );
}

/** Both players dodge: prefer moves that do NOT end the game. */
function playAvoiding(s: GameState, maxPlies: number): {
  state: GameState;
  plies: number;
  events: MoveEvent[];
} {
  let plies = 0;
  let lastEvents: MoveEvent[] = [];
  while (!isTerminal(s) && plies < maxPlies) {
    const legal = getLegalMoves(s);
    if (legal.length === 0) {
      const r = applyPass(s);
      s = r.state;
      lastEvents = r.events;
    } else {
      let pick = legal[0]!;
      for (const m of legal) {
        if (!isTerminal(applyMove(s, m).state)) {
          pick = m;
          break;
        }
      }
      const r = applyMove(s, pick);
      s = r.state;
      lastEvents = r.events;
    }
    plies++;
  }
  return { state: s, plies, events: lastEvents };
}

describe('deadlock rule (no-capture cycles terminate)', () => {
  it('one bead per side always terminates, even with both players dodging', () => {
    // Without the quiet-turn rule these positions cycle forever
    // (verified exhaustively: 210 of 242 reachable 2-seed states).
    const bound = 4 * QUIET_TURN_LIMIT_LOW_SEEDS + 20;
    for (let sPit = 0; sPit < 7; sPit++) {
      for (let nPit = 7; nPit < 14; nPit++) {
        for (const first of ['S', 'N'] as const) {
          const { state, plies } = playAvoiding(
            twoBeadGame(sPit, nPit, first),
            bound,
          );
          expect(
            isTerminal(state),
            `S@${sPit} N@${nPit} ${first} to move: still running after ${plies} plies`,
          ).toBe(true);
        }
      }
    }
  });

  it('emits matchEnd when the deadlock fires (single match)', () => {
    const { state, events } = playAvoiding(twoBeadGame(0, 7, 'S'), 200);
    expect(isTerminal(state)).toBe(true);
    expect(state.seriesOver).toBe(true);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
  });

  it('a capture resets the quiet counter', () => {
    // S sows 1 from pit 0: drop pit 1, peek pit 2 empty -> saada,
    // capture pit 3 + opposite. Guaranteed capture > 0.
    const layout = [1, 0, 0, 5, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0];
    let s = createGame(
      { seedFill: 'custom', customLayout: layout },
      { firstPlayer: 'S' },
    );
    s = { ...s, quietTurns: QUIET_TURN_LIMIT_LOW_SEEDS - 1 };
    const { state } = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(state.quietTurns).toBe(0);
    expect(isTerminal(state)).toBe(false);
  });

  it('a capture-less turn increments the quiet counter', () => {
    const s = twoBeadGame(0, 13, 'S');
    const { state } = applyMove(s, { startPit: 0, direction: 'ccw' });
    expect(state.quietTurns).toBe(1);
  });

  it('multi-round: deadlock ends the board and reseeds from scores', () => {
    let s = twoBeadGame(0, 7, 'S', {
      matchStructure: 'multi-round-protected',
    });
    // Both players hold winnings that can field pits next round.
    s = {
      ...s,
      score: { S: 30, N: 30, E: 0 },
      initialTotal: 62,
      openingComplete: true,
    };
    let plies = 0;
    let sawRoundEnd = false;
    while (!isTerminal(s) && plies < 200 && s.roundIndex === 0) {
      const legal = getLegalMoves(s);
      let r;
      if (legal.length === 0) {
        r = applyPass(s);
      } else {
        let pick = legal[0]!;
        for (const m of legal) {
          const child = applyMove(s, m).state;
          if (!isTerminal(child) && child.roundIndex === s.roundIndex) {
            pick = m;
            break;
          }
        }
        r = applyMove(s, pick);
      }
      s = r.state;
      if (r.events.some((e) => e.type === 'roundEnd')) sawRoundEnd = true;
      plies++;
    }
    expect(sawRoundEnd).toBe(true);
    expect(s.roundIndex).toBe(1);
    expect(s.seriesOver).toBe(false);
    expect(s.quietTurns).toBe(0);
    // Reseeded: 30 seeds per side fund 6 pits of 5, one pit protected.
    expect(s.pits.reduce((a, b) => a + b, 0)).toBe(60);
    expect(s.protectedMask.filter(Boolean).length).toBe(2);
  });
});
