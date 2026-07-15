import type { DirectionMode } from '../engine';
import {
  normalizeTravelSpeed,
  TRAVEL_SPEED_DEFAULT,
} from './animationPace';

export type SettingsSeedCount = 4 | 5 | 6;

export interface Settings {
  initialSeedsPerPit: SettingsSeedCount;
  directionMode: DirectionMode;
  /**
   * Multi-round handicap (traditional series play): after each round players
   * re-seed their row from captured winnings; unfilled pits are protected.
   * The series ends when a player cannot fill a single pit.
   */
  multiRound: boolean;
  /**
   * Bead travel speed 1 (slowest) … 10 (fastest).
   * Applies to in-game sowing and the tour demos.
   */
  travelSpeed: number;
  soundEnabled: boolean;
  hintsDefault: boolean;
  reducedMotionOverride: 'auto' | 'always' | 'never';
  theme: 'wood' | 'wood-dark';
}

export const DEFAULT_SETTINGS: Settings = {
  initialSeedsPerPit: 5,
  directionMode: 'bidirectional',
  multiRound: false,
  travelSpeed: TRAVEL_SPEED_DEFAULT,
  soundEnabled: true,
  hintsDefault: true,
  reducedMotionOverride: 'auto',
  theme: 'wood',
};

const KEY = 'chennamane-settings-v3';

function coerce(partial: Record<string, unknown>): Settings {
  const legacySpeed = partial.travelSpeed ?? partial.animationSpeed;
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    travelSpeed: normalizeTravelSpeed(legacySpeed),
    initialSeedsPerPit: ([4, 5, 6] as const).includes(
      partial.initialSeedsPerPit as SettingsSeedCount,
    )
      ? (partial.initialSeedsPerPit as SettingsSeedCount)
      : DEFAULT_SETTINGS.initialSeedsPerPit,
    directionMode:
      partial.directionMode === 'fixedCcw' ||
      partial.directionMode === 'fixedCw' ||
      partial.directionMode === 'bidirectional'
        ? partial.directionMode
        : DEFAULT_SETTINGS.directionMode,
    multiRound:
      typeof partial.multiRound === 'boolean'
        ? partial.multiRound
        : DEFAULT_SETTINGS.multiRound,
    soundEnabled:
      typeof partial.soundEnabled === 'boolean'
        ? partial.soundEnabled
        : DEFAULT_SETTINGS.soundEnabled,
    hintsDefault:
      typeof partial.hintsDefault === 'boolean'
        ? partial.hintsDefault
        : DEFAULT_SETTINGS.hintsDefault,
    reducedMotionOverride:
      partial.reducedMotionOverride === 'always' ||
      partial.reducedMotionOverride === 'never' ||
      partial.reducedMotionOverride === 'auto'
        ? partial.reducedMotionOverride
        : DEFAULT_SETTINGS.reducedMotionOverride,
    theme: partial.theme === 'wood-dark' ? 'wood-dark' : 'wood',
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      // migrate v2 / v1
      for (const legacyKey of ['chennamane-settings-v2', 'chennamane-settings-v1']) {
        const legacy = localStorage.getItem(legacyKey);
        if (!legacy) continue;
        const parsed = JSON.parse(legacy) as Record<string, unknown>;
        const migrated = coerce(parsed);
        saveSettings(migrated);
        return migrated;
      }
      return { ...DEFAULT_SETTINGS };
    }
    return coerce(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): boolean {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...s, travelSpeed: normalizeTravelSpeed(s.travelSpeed) }),
    );
    return true;
  } catch {
    return false;
  }
}
