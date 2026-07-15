import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getLegalMoves,
  INDEX_TO_LABEL,
  type PitIndex,
} from '../../engine';
import { useGameStore, type TurnPhase } from '../../session/store';

function isAiPhase(phase: TurnPhase): boolean {
  return phase === 'ai-thinking' || phase === 'ai-preview' || phase === 'ai-playing';
}

function isAnimatingPhase(phase: TurnPhase): boolean {
  return phase === 'animating' || phase === 'ai-playing';
}

/** Stable pseudo-random layout for seeds inside a pit */
function seedLayout(pit: number, count: number): { x: number; y: number; s: number }[] {
  const out: { x: number; y: number; s: number }[] = [];
  const n = Math.min(count, 14);
  for (let i = 0; i < n; i++) {
    const t = (i + 1) * (pit * 17 + 31);
    const a = (t * 2.399) % (Math.PI * 2);
    const r = 18 * Math.sqrt((i + 0.4) / Math.max(n, 1));
    out.push({
      x: 50 + Math.cos(a) * r,
      y: 50 + Math.sin(a) * r * 0.92,
      s: 0.88 + ((t % 7) / 7) * 0.22,
    });
  }
  return out;
}

function Seed({
  x,
  y,
  s,
  pop,
}: {
  x: number;
  y: number;
  s: number;
  pop?: boolean;
}) {
  return (
    <span
      className={`seed ${pop ? 'seed-pop' : ''}`}
      style={{
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) scale(${s})`,
      }}
      aria-hidden
    />
  );
}

function Pit({
  pit,
  count,
  prevCount,
  legal,
  showHint,
  selected,
  highlight,
  aiPreview,
  dimmed,
  disabled,
  onSelect,
  side,
  pitRef,
}: {
  pit: PitIndex;
  count: number;
  prevCount: number;
  legal: boolean;
  showHint: boolean;
  selected: boolean;
  highlight: boolean;
  aiPreview: boolean;
  dimmed: boolean;
  disabled: boolean;
  onSelect: (p: PitIndex) => void;
  side: 'north' | 'south';
  pitRef: (el: HTMLButtonElement | null) => void;
}) {
  const seeds = useMemo(() => seedLayout(pit, count), [pit, count]);
  const label = INDEX_TO_LABEL[pit] ?? String(pit);
  const grew = count > prevCount;
  const shrank = count < prevCount;

  return (
    <button
      ref={pitRef}
      type="button"
      data-pit={pit}
      className={[
        'pit-premium',
        showHint ? 'is-legal' : '',
        selected ? 'is-selected' : '',
        highlight ? 'is-highlight' : '',
        aiPreview ? 'is-ai-preview' : '',
        dimmed ? 'is-dimmed' : '',
        grew ? 'is-drop' : '',
        shrank ? 'is-pickup' : '',
        side,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || !legal}
      onClick={() => onSelect(pit)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!disabled && legal) onSelect(pit);
        }
      }}
      aria-label={`${side} pit ${label}, ${count} seeds${legal ? ', can play' : ''}`}
      aria-pressed={selected || aiPreview}
      aria-disabled={disabled || !legal}
    >
      <span className="pit-bowl">
        <span className="pit-seeds">
          {seeds.map((s, i) => (
            <Seed key={i} {...s} pop={grew && i === seeds.length - 1} />
          ))}
        </span>
        {count > 14 && <span className="pit-overflow">+{count - 14}</span>}
      </span>
      <span className={`pit-count ${grew ? 'count-bump' : ''}`} aria-hidden>
        {count}
      </span>
    </button>
  );
}

interface Flyer {
  x: number;
  y: number;
  key: number;
  capture?: boolean;
}

export function PremiumBoard() {
  const committed = useGameStore((s) => s.committed);
  const displayPits = useGameStore((s) => s.displayPits);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const highlightPit = useGameStore((s) => s.highlightPit);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const inputLocked = useGameStore((s) => s.inputLocked);
  const thinking = useGameStore((s) => s.thinking);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);
  const selectPit = useGameStore((s) => s.selectPit);
  const pendingDirection = useGameStore((s) => s.pendingDirection);
  const statusMessage = useGameStore((s) => s.statusMessage);
  const hintsEnabled = useGameStore((s) => s.hintsEnabled);

  const boardRef = useRef<HTMLDivElement>(null);
  const pitEls = useRef<Map<number, HTMLButtonElement>>(new Map());
  const prevHighlight = useRef<number | null>(null);
  const prevPits = useRef<number[]>(displayPits.slice());
  const [flyer, setFlyer] = useState<Flyer | null>(null);
  const [handBadge, setHandBadge] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );
  const flyerKey = useRef(0);

  // Track previous pit counts for pop animations
  const [prevCounts, setPrevCounts] = useState<number[]>(() => displayPits.slice());
  useEffect(() => {
    const id = requestAnimationFrame(() => setPrevCounts(displayPits.slice()));
    return () => cancelAnimationFrame(id);
  }, [displayPits]);

  // Flying seed when highlight moves during animation
  useEffect(() => {
    const board = boardRef.current;
    if (!board || highlightPit === null) {
      prevHighlight.current = highlightPit;
      setHandBadge(null);
      return;
    }

    const target = pitEls.current.get(highlightPit);
    if (!target) return;

    const br = board.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const toX = tr.left + tr.width / 2 - br.left;
    const toY = tr.top + tr.height / 2 - br.top;

    const animating = isAnimatingPhase(turnPhase) || turnPhase === 'ai-preview';
    const fromPit = prevHighlight.current;

    if (animating && fromPit !== null && fromPit !== highlightPit) {
      const fromEl = pitEls.current.get(fromPit);
      if (fromEl) {
        const fr = fromEl.getBoundingClientRect();
        const fromX = fr.left + fr.width / 2 - br.left;
        const fromY = fr.top + fr.height / 2 - br.top;
        const key = ++flyerKey.current;
        const isCapture = statusMessage.toLowerCase().includes('captur');

        // Start at previous pit, then next frame fly to target
        setFlyer({ x: fromX, y: fromY, key, capture: isCapture });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setFlyer({ x: toX, y: toY, key, capture: isCapture });
          });
        });
      }
    } else if (animating) {
      // Stay on current highlight (pickup)
      setFlyer({ x: toX, y: toY, key: flyerKey.current, capture: false });
    }

    // Hand / status badge near active pit while sowing / AI preview
    if (animating) {
      const short =
        statusMessage.length > 28 ? statusMessage.slice(0, 26) + '…' : statusMessage;
      setHandBadge({ x: toX, y: toY - tr.height * 0.65, text: short });
    } else {
      setHandBadge(null);
    }

    prevHighlight.current = highlightPit;
  }, [highlightPit, turnPhase, statusMessage]);

  // Clear flyer when animation ends
  useEffect(() => {
    if (!isAnimatingPhase(turnPhase) && turnPhase !== 'ai-preview') {
      const t = window.setTimeout(() => {
        setFlyer(null);
        setHandBadge(null);
        prevHighlight.current = null;
      }, 120);
      return () => clearTimeout(t);
    }
  }, [turnPhase]);

  useEffect(() => {
    prevPits.current = displayPits.slice();
  }, [displayPits]);

  if (!committed) return null;

  const canInput =
    !inputLocked &&
    !thinking &&
    !isAiPhase(turnPhase) &&
    turnPhase !== 'animating' &&
    turnPhase !== 'pass' &&
    turnPhase !== 'over' &&
    (mode !== 'ai' || committed.toMove === humanPlayer);

  const legal = new Set(
    canInput ? getLegalMoves(committed).map((m) => m.startPit) : [],
  );

  const aiActive = isAiPhase(turnPhase);
  const isAiPreview = turnPhase === 'ai-preview';
  const yourTurn = turnPhase === 'your-turn' && mode === 'ai';
  const sowing = isAnimatingPhase(turnPhase);

  const north = [7, 8, 9, 10, 11, 12, 13] as const;
  const south = [0, 1, 2, 3, 4, 5, 6] as const;

  const setPitRef = (pit: number) => (el: HTMLButtonElement | null) => {
    if (el) pitEls.current.set(pit, el);
    else pitEls.current.delete(pit);
  };

  return (
    <div
      className={[
        'premium-board-stage',
        aiActive ? 'phase-ai' : '',
        yourTurn ? 'phase-you' : '',
        sowing ? 'phase-sow' : '',
        pendingDirection ? 'choosing-dir' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="board-glow" aria-hidden />

      <div
        className="premium-board"
        ref={boardRef}
        role="group"
        aria-label="Chennamane board"
      >
        <div className="board-wood" aria-hidden />
        <div className="board-edge board-edge-outer" aria-hidden />
        <div className="board-edge board-edge-inner" aria-hidden />
        <div className="board-vignette" aria-hidden />

        <div className="board-row-label north-label">
          {mode === 'ai' ? (humanPlayer === 'N' ? 'You' : 'Opponent') : 'North'}
        </div>

        <div className={`pit-row north ${aiActive ? 'row-active' : ''}`}>
          {north.map((pit) => (
            <Pit
              key={pit}
              pit={pit}
              count={displayPits[pit] ?? 0}
              prevCount={prevCounts[pit] ?? 0}
              legal={legal.has(pit)}
              showHint={legal.has(pit) && hintsEnabled}
              selected={selectedPit === pit}
              highlight={highlightPit === pit && !isAiPreview}
              aiPreview={isAiPreview && highlightPit === pit}
              dimmed={yourTurn}
              disabled={!canInput}
              onSelect={selectPit}
              side="north"
              pitRef={setPitRef(pit)}
            />
          ))}
        </div>

        <div className="board-center-rail" aria-hidden>
          <span className="rail-mark" />
          <span className="rail-title">Chennamane</span>
          <span className="rail-mark" />
        </div>

        <div
          className={`pit-row south ${
            yourTurn || (mode === 'hotseat' && committed.toMove === 'S') ? 'row-active' : ''
          }`}
        >
          {south.map((pit) => (
            <Pit
              key={pit}
              pit={pit}
              count={displayPits[pit] ?? 0}
              prevCount={prevCounts[pit] ?? 0}
              legal={legal.has(pit)}
              showHint={legal.has(pit) && hintsEnabled}
              selected={selectedPit === pit}
              highlight={highlightPit === pit && !isAiPreview}
              aiPreview={isAiPreview && highlightPit === pit}
              dimmed={aiActive}
              disabled={!canInput}
              onSelect={selectPit}
              side="south"
              pitRef={setPitRef(pit)}
            />
          ))}
        </div>

        <div className="board-row-label south-label">
          {mode === 'ai' ? (humanPlayer === 'S' ? 'You' : 'Opponent') : 'South'}
        </div>

        {/* Flying seed during sow */}
        {flyer && (
          <span
            key={flyer.key}
            className={`seed-flyer ${flyer.capture ? 'is-capture' : ''}`}
            style={{
              left: flyer.x,
              top: flyer.y,
            }}
            aria-hidden
          />
        )}

        {handBadge && sowing && (
          <span
            className="sow-badge"
            style={{ left: handBadge.x, top: handBadge.y }}
            aria-hidden
          >
            {handBadge.text}
          </span>
        )}
      </div>
    </div>
  );
}
