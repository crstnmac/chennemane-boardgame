import type { GameState, MatchEndReason } from '../engine';
import { INDEX_TO_LABEL } from '../engine';
import type { GameMode } from './outcome';
import type { Difficulty } from '../ai';

/** Compact reproducible snapshot for bug reports and support. */
export function buildMatchReport(opts: {
  committed: GameState | null;
  mode: GameMode;
  humanPlayer: string;
  aiDifficulty: Difficulty;
  endReason?: MatchEndReason | null;
}): string {
  const { committed, mode, humanPlayer, aiDifficulty, endReason } = opts;
  if (!committed) return 'No active game.';
  const pits = committed.pits
    .map((n, i) => `${INDEX_TO_LABEL[i] ?? i}:${n}`)
    .join(' ');
  const lines = [
    'Chennamane match report',
    `mode=${mode} human=${humanPlayer} ai=${aiDifficulty}`,
    `toMove=${committed.toMove} second=${committed.sowingsUsedThisTurn} quiet=${committed.quietTurns}`,
    `round=${committed.roundIndex} seriesOver=${committed.seriesOver}`,
    `score S=${committed.score.S} N=${committed.score.N} E=${committed.score.E ?? 0}`,
    `bank S=${committed.bank.S} N=${committed.bank.N}`,
    `config seeds=${committed.config.initialSeedsPerPit} dir=${committed.config.directionMode} multi=${committed.config.matchStructure} residual=${committed.config.residual}`,
    `pits ${pits}`,
    endReason ? `endReason=${endReason}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function copyMatchReport(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}
