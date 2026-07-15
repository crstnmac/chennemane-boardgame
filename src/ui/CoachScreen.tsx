import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useGameStore } from '../session/store';
import { TravelSpeedSlider } from './TravelSpeedSlider';
import type { TourBoardProps, TourDemo, TourHighlight } from './three/TourBoard';

const TourBoard = lazy(() =>
  import('./three/TourBoard').then((m) => ({ default: m.TourBoard })),
);

const FULL = Array.from({ length: 14 }, () => 5);

/** Clear sowing demo: 4 beads from B2 (1) anti-clockwise. */
const SOW_INITIAL = (() => {
  const p = Array(14).fill(0) as number[];
  // Leave a readable trail of empty/light pits
  for (let i = 0; i < 14; i++) p[i] = i === 1 ? 4 : i < 7 ? 2 : 2;
  p[1] = 4;
  return p;
})();

/**
 * Capture demo — short path to saada + real capture.
 * South sows 1 from B1 (0) ccw → drop B2, peek B3 empty → capture B4 + A4.
 */
const CAPTURE_INITIAL = (() => {
  const p = Array(14).fill(1) as number[];
  p[0] = 1; // start
  p[1] = 0; // drop target (empty before drop)
  p[2] = 0; // peek empty → saada
  p[3] = 4; // capture
  p[10] = 3; // opposite of B4 (A4 = 10)
  // quiet rest of board
  for (const i of [4, 5, 6, 7, 8, 9, 11, 12, 13]) p[i] = 1;
  return p;
})();

const WIN_INITIAL = (() => {
  const p = Array(14).fill(0) as number[];
  p[3] = 1;
  return p;
})();

type Step = {
  title: string;
  body: string;
  kicker: string;
  demo: TourDemo;
  highlight?: TourHighlight;
  labels?: TourBoardProps['labels'];
  dimOthers?: boolean;
};

const STEPS: Step[] = [
  {
    title: 'The board',
    kicker: 'Fourteen pits · coral beads',
    body: 'Two rows of seven bowls. South (near) is yours; North (far) is the other side. Captures leave the board as score — not sown back into pits.',
    demo: { initial: FULL },
    highlight: { kind: 'rows', south: true, north: true },
    labels: [
      { pit: 3, text: 'B-row · you', tone: 'gold' },
      { pit: 10, text: 'A-row · North', tone: 'mute' },
    ],
    dimOthers: false,
  },
  {
    title: 'Sowing',
    kicker: 'Watch the beads travel',
    body: 'Lift every bead from one of your pits and drop one per pit around the loop. If the pit after your last drop still holds beads, pick those up and keep going.',
    demo: {
      initial: SOW_INITIAL,
      move: { startPit: 1, direction: 'ccw' },
      toMove: 'S',
      // Engine sowing always runs into a capture; captures are step 3's
      // lesson, so this demo ends at the saada instead of spoiling it.
      stopAt: 'saada',
    },
    highlight: { kind: 'pits', pits: [1], color: '#e0c989' },
    labels: [{ pit: 1, text: 'Start here', tone: 'gold' }],
    dimOthers: true,
  },
  {
    title: 'Saada and capture',
    kicker: 'Empty next · beads leave the board',
    body: 'If the pit after your last drop is empty, that is a saada. Capture beads from the next pit and the pit opposite it — they fly to your score. Any capture forces a second sowing when you still have a legal pit.',
    demo: {
      initial: CAPTURE_INITIAL,
      move: { startPit: 0, direction: 'ccw' },
      toMove: 'S',
    },
    highlight: { kind: 'pits', pits: [0, 2, 3, 10], color: '#d4a0c8' },
    labels: [
      { pit: 0, text: 'Sow', tone: 'gold' },
      { pit: 2, text: 'Saada', tone: 'accent' },
      { pit: 3, text: 'Capture', tone: 'gold' },
      { pit: 10, text: 'Opposite', tone: 'gold' },
    ],
    dimOthers: true,
  },
  {
    title: 'Winning',
    kicker: 'Higher score wins',
    body: 'Empty own row → you pass. When only a residual bead is left (or the board is clear), the match ends. Higher score wins; equal scores are a draw.',
    demo: { initial: WIN_INITIAL },
    highlight: { kind: 'pits', pits: [3], color: '#e0c989' },
    labels: [{ pit: 3, text: 'Last bead', tone: 'gold' }],
    dimOthers: true,
  },
];

export function CoachScreen() {
  const [i, setI] = useState(0);
  const [caption, setCaption] = useState('');
  const setCoachSeen = useGameStore((s) => s.setCoachSeen);
  const setScreen = useGameStore((s) => s.setScreen);
  const newGame = useGameStore((s) => s.newGame);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const step = STEPS[i]!;

  const goTo = (idx: number) => {
    if (idx < 0 || idx >= STEPS.length) return;
    setCaption('');
    setI(idx);
  };

  // Arrow keys page through steps; Escape leaves the tour. Skipped when a
  // control has focus so the speed slider keeps its native arrow behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, select, textarea, button, [contenteditable]')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goTo(i + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goTo(i - 1);
      } else if (e.key === 'Escape') {
        setScreen('home');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const boardProps = useMemo(
    () => ({
      demo: step.demo,
      highlight: step.highlight,
      labels: step.labels,
      dimOthers: step.dimOthers,
      onCaption: setCaption,
    }),
    [step],
  );

  return (
    <div className="tour-screen">
      <div className="tour-stage" aria-hidden>
        <Suspense
          fallback={
            <div className="home-hero-fallback">
              <div className="home-hero-fallback-board" />
            </div>
          }
        >
          <TourBoard {...boardProps} />
        </Suspense>
        <div className="tour-stage-scrim" />
      </div>

      <div className="tour-hud">
        <div className="tour-tl">
          <button
            type="button"
            className="hud-icon"
            onClick={() => setScreen('home')}
            aria-label="Back to home"
            title="Home"
          >
            ←
          </button>
          <div className="tour-meta">
            <span className="tour-meta-title">Quick tour</span>
            <span className="tour-meta-sub">
              Step {i + 1} of {STEPS.length}
            </span>
          </div>
        </div>

        <div className="tour-progress" role="tablist" aria-label="Tour steps">
          {STEPS.map((s, idx) => (
            <button
              key={idx}
              type="button"
              role="tab"
              aria-selected={idx === i}
              aria-label={`Step ${idx + 1}: ${s.title}`}
              className={`tour-dot ${idx === i ? 'is-on' : idx < i ? 'is-done' : ''}`}
              onClick={() => goTo(idx)}
            />
          ))}
        </div>

        {caption && (
          <p className="tour-live-caption" role="status" aria-live="polite">
            {caption}
          </p>
        )}

        <div className="tour-card" role="region" aria-labelledby="tour-step-title">
          <p className="tour-kicker">{step.kicker}</p>
          <h2 id="tour-step-title" className="tour-title">
            {step.title}
          </h2>
          <p className="tour-body">{step.body}</p>

          <div className="tour-speed-wrap">
            <TravelSpeedSlider
              id="tour-travel-speed"
              compact
              value={travelSpeed}
              onChange={(n) => updateSettings({ travelSpeed: n })}
            />
          </div>

          <div className="tour-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={i === 0}
              onClick={() => goTo(i - 1)}
            >
              Back
            </button>
            {i < STEPS.length - 1 ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => goTo(i + 1)}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setCoachSeen();
                  newGame('ai', {
                    difficulty: useGameStore.getState().aiDifficulty,
                  });
                }}
              >
                Start a game
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setCoachSeen();
                setScreen('home');
              }}
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
