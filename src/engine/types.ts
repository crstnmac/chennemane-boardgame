export type PlayerId = 'S' | 'N' | 'E';
export type PitIndex = number; // 0..pitCount-1
export type Direction = 'cw' | 'ccw';
export type DirectionMode =
  | 'bidirectional'
  | 'fixedCcw'
  | 'fixedCw'
  | 'openingCcwThenFree';

export type SecondSowingMode = 'forced' | 'optional' | 'none';
export type CaptureMode = 'saada-pair' | 'own-row-only' | 'profile-specific';
export type EmptySideMode = 'pass' | 'end-match' | 'opponent-continues';
export type MatchStructure =
  | 'single'
  | 'multi-round-protected'
  | 'best-of-n'
  | 'timed';
export type ResidualMode = 'unclaimed' | 'to-last-mover';
export type EngineFamily =
  | 'bule-perga'
  | 'pallanguzhi'
  | 'kalah'
  | 'arasu'
  | 'seete';

/**
 * Full engine-applied rules for a match.
 * Catalog RulesProfile maps 1:1 into this via `rulesToEngineConfig`.
 */
export interface VariantConfig {
  id: string;
  displayName: string;
  engineFamily: EngineFamily;

  /** Board topology (standard Chennamane = 2×7, 14 pits) */
  rows: number;
  pitsPerRow: number;
  storesInCircuit: boolean;
  pitCount: number;

  seedFill: 'uniform' | 'custom';
  initialSeedsPerPit: number;
  customLayout?: number[];

  directionMode: DirectionMode;
  secondSowing: SecondSowingMode;
  capture: CaptureMode;
  emptySide: EmptySideMode;
  relay: boolean;

  matchStructure: MatchStructure;
  bestOf?: number;
  residual: ResidualMode;
  playerCount: 1 | 2 | 3;

  /** Timed match: ms per player (session also tracks remaining). */
  timeControlMs?: number;
}

export interface GameState {
  pits: number[];
  score: Record<PlayerId, number>;
  toMove: PlayerId;
  /**
   * Sowings completed this turn that still leave the player to move.
   * 0 = first sowing opportunity.
   * 1 = first sowing captured; second sowing forced/optional.
   */
  sowingsUsedThisTurn: 0 | 1;
  protectedMask: boolean[];
  config: VariantConfig;
  resigned: PlayerId | null;
  initialTotal: number;
  /** True after the match’s first completed sowing (opening direction lock). */
  openingComplete: boolean;
  /** Multi-round series: 0-based round index */
  roundIndex: number;
  /** Seeds left in bank between multi-rounds (score is cumulative captured) */
  bank: Record<PlayerId, number>;
  /** True when multi-round match is fully over (not just end of a board) */
  seriesOver: boolean;
}

export interface Move {
  startPit: PitIndex;
  direction: Direction;
}

export type Action =
  | Move
  | { type: 'pass' }
  /** Optional second sowing: decline the extra turn */
  | { type: 'skipSecond' };

export type TurnEndReason =
  | 'saada-no-capture'
  | 'second-saada'
  | 'no-legal-second-sowing'
  | 'skip-second'
  | 'single-sowing-end'
  | 'pass'
  | 'resign'
  | 'terminal'
  | 'empty-side-end'
  | 'time-forfeit'
  | 'round-end'
  | 'extra-turn-used';

export type MoveEvent =
  | { type: 'pickup'; pit: PitIndex; count: number }
  | { type: 'drop'; pit: PitIndex; remainingInHand: number }
  | { type: 'continue'; pit: PitIndex; count: number }
  | { type: 'saada'; emptyPit: PitIndex }
  | { type: 'capture'; pits: PitIndex[]; amounts: number[] }
  | { type: 'pass'; player: PlayerId }
  | { type: 'skipSecond'; player: PlayerId }
  | { type: 'turnEnd'; player: PlayerId; reason: TurnEndReason }
  | { type: 'roundEnd'; roundIndex: number }
  | { type: 'matchEnd'; winner: PlayerId | 'draw'; scores: Record<PlayerId, number> };
