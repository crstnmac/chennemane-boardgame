import type {
  CaptureMode,
  DirectionMode,
  EmptySideMode,
  EngineFamily,
  MatchStructure,
  ResidualMode,
  SecondSowingMode,
  VariantConfig,
} from './types';

/** Ali Guli Mane (ಅಳಿ ಗುಳಿ ಮಣೆ) — the sole ruleset. */
export const DEFAULT_CONFIG: VariantConfig = {
  id: 'ali-guli-mane',
  displayName: 'Ali Guli Mane',
  engineFamily: 'bule-perga',
  rows: 2,
  pitsPerRow: 7,
  storesInCircuit: false,
  pitCount: 14,
  seedFill: 'uniform',
  initialSeedsPerPit: 5,
  directionMode: 'bidirectional',
  secondSowing: 'forced',
  capture: 'saada-pair',
  emptySide: 'pass',
  relay: true,
  matchStructure: 'single',
  residual: 'unclaimed',
  playerCount: 2,
};

const DIR_MODES = new Set<DirectionMode>([
  'bidirectional',
  'fixedCcw',
  'fixedCw',
  'openingCcwThenFree',
]);
const SECOND = new Set<SecondSowingMode>(['forced', 'optional', 'none']);
const CAPTURE = new Set<CaptureMode>(['saada-pair', 'own-row-only', 'profile-specific']);
const EMPTY = new Set<EmptySideMode>(['pass', 'end-match', 'opponent-continues']);
const MATCH = new Set<MatchStructure>([
  'single',
  'multi-round-protected',
  'best-of-n',
  'timed',
]);
const RESIDUAL = new Set<ResidualMode>(['unclaimed', 'to-last-mover']);
const FAMILIES = new Set<EngineFamily>([
  'bule-perga',
  'pallanguzhi',
  'kalah',
  'arasu',
  'seete',
]);

function clampSeeds(n: number): number {
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONFIG.initialSeedsPerPit;
  return Math.min(24, Math.floor(n));
}

/** Merge partial knobs onto defaults; coerce illegal values. */
export function mergeConfig(partial?: Partial<VariantConfig>): VariantConfig {
  const p = partial ?? {};
  const rows = p.rows ?? DEFAULT_CONFIG.rows;
  const pitsPerRow = p.pitsPerRow ?? DEFAULT_CONFIG.pitsPerRow;
  const storesInCircuit = p.storesInCircuit ?? false;
  // Kalah-style 2×6 + 2 stores still uses 14 slots (stores at ends of each row)
  const pitCount =
    p.pitCount ??
    (storesInCircuit ? rows * pitsPerRow + 2 : rows * pitsPerRow);

  const directionMode = DIR_MODES.has(p.directionMode as DirectionMode)
    ? (p.directionMode as DirectionMode)
    : DEFAULT_CONFIG.directionMode;
  const secondSowing = SECOND.has(p.secondSowing as SecondSowingMode)
    ? (p.secondSowing as SecondSowingMode)
    : DEFAULT_CONFIG.secondSowing;
  const capture = CAPTURE.has(p.capture as CaptureMode)
    ? (p.capture as CaptureMode)
    : DEFAULT_CONFIG.capture;
  const emptySide = EMPTY.has(p.emptySide as EmptySideMode)
    ? (p.emptySide as EmptySideMode)
    : DEFAULT_CONFIG.emptySide;
  const matchStructure = MATCH.has(p.matchStructure as MatchStructure)
    ? (p.matchStructure as MatchStructure)
    : DEFAULT_CONFIG.matchStructure;
  const residual = RESIDUAL.has(p.residual as ResidualMode)
    ? (p.residual as ResidualMode)
    : DEFAULT_CONFIG.residual;
  const engineFamily = FAMILIES.has(p.engineFamily as EngineFamily)
    ? (p.engineFamily as EngineFamily)
    : DEFAULT_CONFIG.engineFamily;

  let playerCount = p.playerCount ?? DEFAULT_CONFIG.playerCount;
  if (playerCount !== 1 && playerCount !== 2 && playerCount !== 3) {
    playerCount = 2;
  }
  if (engineFamily === 'seete') playerCount = 1;
  if (engineFamily === 'arasu') playerCount = 3;

  return {
    id: p.id || DEFAULT_CONFIG.id,
    displayName: p.displayName || DEFAULT_CONFIG.displayName,
    engineFamily,
    rows,
    pitsPerRow,
    storesInCircuit,
    pitCount,
    seedFill: p.seedFill === 'custom' ? 'custom' : 'uniform',
    initialSeedsPerPit: clampSeeds(
      p.initialSeedsPerPit ?? DEFAULT_CONFIG.initialSeedsPerPit,
    ),
    customLayout: p.customLayout?.slice(),
    directionMode,
    secondSowing,
    capture,
    emptySide,
    relay: p.relay ?? true,
    matchStructure,
    bestOf: p.bestOf,
    residual,
    playerCount,
    timeControlMs: p.timeControlMs,
  };
}
