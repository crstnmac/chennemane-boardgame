import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatchOutcome } from '../session/outcome';
import { sfx } from '../audio/sfx';
import { trapFocus } from './a11y/focusTrap';

interface ResultOverlayProps {
  outcome: Exclude<MatchOutcome, { kind: 'ongoing' }>;
  onPlayAgain: () => void;
  onHome: () => void;
  onCopyReport?: () => void;
  reportCopied?: boolean;
}

type Variant = 'win' | 'lose' | 'draw';

/**
 * Arcade-style staged reveal (the Candy Crush / Clash Royale pattern):
 * banner slams in → stars stamp one-by-one → scores count up with ticks →
 * buttons arrive last. Wins get sunburst rays + falling seeds; defeats get
 * the muted version. Reduced-motion users see everything immediately.
 */
const STAGE_TIMES = { banner: 120, stars: 650, starGap: 320, count: 700, actions: 1900 };

function variantOf(outcome: ResultOverlayProps['outcome']): Variant {
  if (outcome.kind === 'draw') return 'draw';
  // Hot-seat decisive games are a win for someone at the table — celebrate.
  return outcome.humanResult === 'loss' ? 'lose' : 'win';
}

function starsOf(outcome: ResultOverlayProps['outcome']): number {
  if (outcome.kind === 'draw') return 0;
  const margin = Math.abs(outcome.scores.S - outcome.scores.N);
  return 1 + (margin >= 8 ? 1 : 0) + (margin >= 16 ? 1 : 0);
}

const BANNER_TEXT: Record<Variant, string> = {
  win: 'Victory',
  lose: 'Defeat',
  draw: 'Draw',
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Count from 0 to target once `active`, ticking the counter sfx as it climbs. */
function useCountUp(target: number, active: boolean, mute: boolean): number {
  const [value, setValue] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    const t0 = performance.now();
    const dur = 900;
    let lastInt = 0;
    let ticks = 0;
    const step = (now: number) => {
      const p = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(target * eased);
      setValue(v);
      if (!mute && v > lastInt && v % 3 === 0) {
        sfx.counterTick(ticks++);
      }
      lastInt = Math.max(lastInt, v);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, active, mute]);
  return active ? value : 0;
}

interface ConfettiPiece {
  left: number;
  delay: number;
  duration: number;
  size: number;
  color: string;
  sway: number;
}

/** Falling gulaganji-seed confetti: reds and golds, matching the board. */
function makeConfetti(count: number): ConfettiPiece[] {
  const colors = ['#d9a441', '#c1272d', '#e8c884', '#a31f24', '#f0e0b8'];
  return Array.from({ length: count }, () => ({
    left: Math.random() * 100,
    delay: Math.random() * 2.4,
    duration: 2.6 + Math.random() * 2,
    size: 5 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)]!,
    sway: 20 + Math.random() * 50,
  }));
}

export function ResultOverlay({
  outcome,
  onPlayAgain,
  onHome,
  onCopyReport,
  reportCopied,
}: ResultOverlayProps) {
  const variant = variantOf(outcome);
  const stars = variantOf(outcome) === 'win' ? starsOf(outcome) : 0;
  const reduced = prefersReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  const playAgainRef = useRef<HTMLButtonElement>(null);

  // Staged reveal driven by a single elapsed-stage counter.
  const [shown, setShown] = useState({
    banner: reduced,
    stars: reduced ? stars : 0,
    count: reduced,
    actions: reduced,
  });

  useEffect(() => {
    if (reduced) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        sfx.banner(variant);
        setShown((s) => ({ ...s, banner: true }));
      }, STAGE_TIMES.banner),
    );
    for (let i = 0; i < stars; i++) {
      timers.push(
        setTimeout(() => {
          sfx.star(i);
          setShown((s) => ({ ...s, stars: i + 1 }));
        }, STAGE_TIMES.stars + i * STAGE_TIMES.starGap),
      );
    }
    timers.push(
      setTimeout(() => setShown((s) => ({ ...s, count: true })), STAGE_TIMES.count),
    );
    timers.push(
      setTimeout(() => setShown((s) => ({ ...s, actions: true })), STAGE_TIMES.actions),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus trap once actions are available (or immediately if reduced motion)
  useEffect(() => {
    if (!shown.actions) return;
    const root = dialogRef.current;
    if (!root) return;
    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, playAgainRef.current);
    return () => {
      document.body.classList.remove('a11y-modal-open');
      release();
    };
  }, [shown.actions]);

  const south = useCountUp(outcome.scores.S, shown.count, variant === 'lose');
  const north = useCountUp(outcome.scores.N, shown.count, true);

  const confetti = useMemo(
    () => (variant === 'win' && !reduced ? makeConfetti(26) : []),
    [variant, reduced],
  );

  return (
    <div className={`result-overlay ro-${variant}`} role="presentation">
      {variant === 'win' && <div className="ro-rays" aria-hidden />}
      {confetti.length > 0 && (
        <div className="ro-confetti" aria-hidden>
          {confetti.map((c, i) => (
            <span
              key={i}
              style={{
                left: `${c.left}%`,
                animationDelay: `${c.delay}s`,
                animationDuration: `${c.duration}s`,
                width: c.size,
                height: c.size * 0.72,
                background: c.color,
                ['--sway' as string]: `${c.sway}px`,
              }}
            />
          ))}
        </div>
      )}

      <div
        ref={dialogRef}
        className={`result-card ${shown.banner ? 'ro-in' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-title"
        aria-describedby="result-scores"
      >
        <p className="result-kicker">{outcome.title}</p>
        <h2 id="result-title" className={`ro-banner ro-banner-${variant}`}>
          {BANNER_TEXT[variant]}
        </h2>

        {stars > 0 && (
          <div className="ro-stars" role="img" aria-label={`${stars} of 3 stars`}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={[
                  'ro-star',
                  i < stars ? 'ro-star-earned' : 'ro-star-empty',
                  i < shown.stars ? 'ro-star-in' : '',
                ].join(' ')}
              >
                ★
              </span>
            ))}
          </div>
        )}

        <div
          id="result-scores"
          className={`result-scores ${shown.count ? 'ro-in' : 'ro-pending'}`}
        >
          <div>
            <span>{outcome.southLabel}</span>
            <strong>{south}</strong>
          </div>
          <div className="result-vs">—</div>
          <div>
            <span>{outcome.northLabel}</span>
            <strong>{north}</strong>
          </div>
        </div>

        <p className="result-end-reason" role="status">
          {outcome.endReasonCopy}
        </p>

        <div className={`result-actions ${shown.actions ? 'ro-in' : 'ro-pending'}`}>
          <button
            ref={playAgainRef}
            type="button"
            className={`btn btn-primary ${variant === 'win' ? 'ro-pulse' : ''}`}
            onClick={onPlayAgain}
            tabIndex={shown.actions ? 0 : -1}
          >
            Play again
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onHome}
            tabIndex={shown.actions ? 0 : -1}
          >
            Home
          </button>
          {onCopyReport && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCopyReport}
              tabIndex={shown.actions ? 0 : -1}
            >
              {reportCopied ? 'Copied report' : 'Copy match report'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
