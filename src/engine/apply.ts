import {
  isStorePit,
  nextPit,
  opposite,
  ownerOf,
} from './board';
import { EngineError } from './errors';
import { assertInvariants } from './invariants';
import { getLegalMoves, movesEqual } from './moves';
import { cloneState } from './state';
import { isTerminal } from './terminal';
import { afterSowing } from './turn';
import type { Direction, GameState, Move, MoveEvent, PitIndex } from './types';

const MAX_DROPS = 10_000;

function credit(
  s: GameState,
  player: GameState['toMove'],
  amount: number,
): void {
  s.score[player] = (s.score[player] ?? 0) + amount;
}

/** Classic Bule Perga / Ali Guli Mane sowing with relay + saada. */
function sowSaada(
  state: GameState,
  startPit: PitIndex,
  direction: Direction,
): { state: GameState; events: MoveEvent[]; capturedTotal: number; extraTurn: boolean } {
  const s = cloneState(state);
  const player = s.toMove;
  let hand = s.pits[startPit]!;
  if (hand <= 0) throw new EngineError('ILLEGAL_MOVE', 'empty start pit');
  s.pits[startPit] = 0;
  const events: MoveEvent[] = [{ type: 'pickup', pit: startPit, count: hand }];
  let current = startPit;
  let drops = 0;
  const nextOpts = { config: s.config, player };

  while (hand > 0) {
    drops += 1;
    if (drops > MAX_DROPS) {
      throw new EngineError('MAX_DROPS_EXCEEDED', 'sowing exceeded drop limit');
    }
    current = nextPit(current, direction, s.protectedMask, nextOpts);
    s.pits[current] = s.pits[current]! + 1;
    hand -= 1;
    events.push({ type: 'drop', pit: current, remainingInHand: hand });

    if (hand === 0) {
      if (!s.config.relay) {
        // Non-relay: stop; optional capture by mode
        const cap = captureAtEnd(s, player, current, direction, events);
        assertInvariants(s, 0);
        return { state: s, events, capturedTotal: cap.capturedTotal, extraTurn: cap.extraTurn };
      }

      const peek = nextPit(current, direction, s.protectedMask, nextOpts);
      if (s.pits[peek]! > 0) {
        hand = s.pits[peek]!;
        s.pits[peek] = 0;
        current = peek;
        events.push({ type: 'continue', pit: peek, count: hand });
      } else {
        events.push({ type: 'saada', emptyPit: peek });
        const cap = saadaCapture(s, player, peek, direction, events);
        assertInvariants(s, 0);
        return {
          state: s,
          events,
          capturedTotal: cap,
          extraTurn: false,
        };
      }
    }
  }

  throw new EngineError('SOWING_LOGIC', 'sowing loop exited without saada');
}

function saadaCapture(
  s: GameState,
  player: GameState['toMove'],
  emptyPeek: PitIndex,
  direction: Direction,
  events: MoveEvent[],
): number {
  const capturePit = nextPit(emptyPeek, direction, s.protectedMask, {
    config: s.config,
    player,
  });
  const mode = s.config.capture;

  if (mode === 'own-row-only') {
    const pits: PitIndex[] = [];
    const amounts: number[] = [];
    if (ownerOf(capturePit, s.config) === player) {
      const a = s.pits[capturePit]!;
      s.pits[capturePit] = 0;
      pits.push(capturePit);
      amounts.push(a);
    }
    const total = amounts.reduce((x, y) => x + y, 0);
    credit(s, player, total);
    events.push({ type: 'capture', pits, amounts });
    return total;
  }

  // saada-pair (default): capture next + opposite
  const opp = opposite(capturePit, s.pits.length);
  let pits = [capturePit, opp];
  let amounts = [s.pits[capturePit]!, s.pits[opp]!];

  if (mode === 'profile-specific' && s.config.engineFamily === 'pallanguzhi') {
    // Pallanguzhi approximation already handled in sowPallanguzhi
  }

  s.pits[capturePit] = 0;
  s.pits[opp] = 0;
  const capturedTotal = amounts[0]! + amounts[1]!;
  credit(s, player, capturedTotal);
  events.push({ type: 'capture', pits, amounts });
  return capturedTotal;
}

function captureAtEnd(
  s: GameState,
  player: GameState['toMove'],
  lastPit: PitIndex,
  _direction: Direction,
  events: MoveEvent[],
): { capturedTotal: number; extraTurn: boolean } {
  // Kalah: last seed in own store → extra turn; empty own pit → capture opposite
  if (s.config.engineFamily === 'kalah' || s.config.storesInCircuit) {
    if (isStorePit(lastPit, s.config) && ownerOf(lastPit, s.config) === player) {
      return { capturedTotal: 0, extraTurn: true };
    }
    if (
      ownerOf(lastPit, s.config) === player &&
      !isStorePit(lastPit, s.config) &&
      s.pits[lastPit] === 1
    ) {
      const opp = opposite(lastPit, s.pits.length);
      // Don't capture from a store pit
      if (s.pits[opp]! > 0 && !isStorePit(opp, s.config)) {
        const amountOwn = s.pits[lastPit]!;
        const amountOpp = s.pits[opp]!;
        s.pits[lastPit] = 0;
        s.pits[opp] = 0;
        credit(s, player, amountOwn + amountOpp);
        events.push({
          type: 'capture',
          pits: [lastPit, opp],
          amounts: [amountOwn, amountOpp],
        });
        return { capturedTotal: amountOwn + amountOpp, extraTurn: false };
      }
    }
    return { capturedTotal: 0, extraTurn: false };
  }

  return { capturedTotal: 0, extraTurn: false };
}

/**
 * Pallanguzhi-style: relay sowing; any pit that reaches exactly 4 after a drop
 * is captured by the sower (profile-specific).
 */
function sowPallanguzhi(
  state: GameState,
  startPit: PitIndex,
  direction: Direction,
): { state: GameState; events: MoveEvent[]; capturedTotal: number; extraTurn: boolean } {
  const s = cloneState(state);
  const player = s.toMove;
  let hand = s.pits[startPit]!;
  if (hand <= 0) throw new EngineError('ILLEGAL_MOVE', 'empty start pit');
  s.pits[startPit] = 0;
  const events: MoveEvent[] = [{ type: 'pickup', pit: startPit, count: hand }];
  let current = startPit;
  let drops = 0;
  let capturedTotal = 0;
  const nextOpts = { config: s.config, player };

  const harvestFours = (pit: PitIndex) => {
    if (s.pits[pit] === 4) {
      s.pits[pit] = 0;
      credit(s, player, 4);
      capturedTotal += 4;
      events.push({ type: 'capture', pits: [pit], amounts: [4] });
    }
  };

  while (hand > 0) {
    drops += 1;
    if (drops > MAX_DROPS) {
      throw new EngineError('MAX_DROPS_EXCEEDED', 'sowing exceeded drop limit');
    }
    current = nextPit(current, direction, s.protectedMask, nextOpts);
    s.pits[current] = s.pits[current]! + 1;
    hand -= 1;
    events.push({ type: 'drop', pit: current, remainingInHand: hand });
    harvestFours(current);

    if (hand === 0) {
      // Relay: if last pit still has seeds (after possible harvest), pick up
      if (s.config.relay && s.pits[current]! > 0) {
        hand = s.pits[current]!;
        s.pits[current] = 0;
        events.push({ type: 'continue', pit: current, count: hand });
      } else {
        events.push({ type: 'saada', emptyPit: current });
        assertInvariants(s, 0);
        return { state: s, events, capturedTotal, extraTurn: false };
      }
    }
  }

  throw new EngineError('SOWING_LOGIC', 'pallanguzhi loop exit');
}

/** Kalah single-pass sow (no relay). */
function sowKalah(
  state: GameState,
  startPit: PitIndex,
  direction: Direction,
): { state: GameState; events: MoveEvent[]; capturedTotal: number; extraTurn: boolean } {
  const s = cloneState(state);
  const player = s.toMove;
  let hand = s.pits[startPit]!;
  if (hand <= 0) throw new EngineError('ILLEGAL_MOVE', 'empty start pit');
  s.pits[startPit] = 0;
  const events: MoveEvent[] = [{ type: 'pickup', pit: startPit, count: hand }];
  let current = startPit;
  const nextOpts = { config: s.config, player };

  while (hand > 0) {
    current = nextPit(current, direction, s.protectedMask, nextOpts);
    s.pits[current] = s.pits[current]! + 1;
    hand -= 1;
    events.push({ type: 'drop', pit: current, remainingInHand: hand });
  }

  const cap = captureAtEnd(s, player, current, direction, events);
  assertInvariants(s, 0);
  return {
    state: s,
    events,
    capturedTotal: cap.capturedTotal,
    extraTurn: cap.extraTurn,
  };
}

export function executeSowing(
  state: GameState,
  startPit: PitIndex,
  direction: Direction,
): {
  state: GameState;
  events: MoveEvent[];
  capturedTotal: number;
  extraTurn: boolean;
} {
  const fam = state.config.engineFamily;
  if (fam === 'kalah' || state.config.storesInCircuit) {
    return sowKalah(state, startPit, direction);
  }
  if (fam === 'pallanguzhi' || state.config.capture === 'profile-specific') {
    if (fam === 'pallanguzhi') {
      return sowPallanguzhi(state, startPit, direction);
    }
  }
  return sowSaada(state, startPit, direction);
}

export function applyMove(
  state: GameState,
  move: Move,
): { state: GameState; events: MoveEvent[] } {
  if (isTerminal(state)) {
    throw new EngineError('ILLEGAL_MOVE', 'game already terminal');
  }
  const legal = getLegalMoves(state);
  if (!legal.some((m) => movesEqual(m, move))) {
    throw new EngineError('ILLEGAL_MOVE', 'move not legal');
  }
  const { state: after, events, capturedTotal, extraTurn } = executeSowing(
    state,
    move.startPit,
    move.direction,
  );
  return afterSowing(after, capturedTotal, events, { extraTurn });
}

export function applyMoveSilent(state: GameState, move: Move): GameState {
  return applyMove(state, move).state;
}
