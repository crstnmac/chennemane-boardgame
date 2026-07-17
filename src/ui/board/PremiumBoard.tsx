import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getLegalMoves,
  INDEX_TO_LABEL,
  type PitIndex,
} from '../../engine';
import {
  dropMsForSpeed,
  prefersReducedMotion,
} from '../../session/animationPace';
import { useGameStore, type TurnPhase } from '../../session/store';
import {
  hopDurationMs,
  hopLiftPx2d,
  hopPoint2d,
  randomHopSkew,
  resolveHopBudgetMs,
} from '../hopMath';

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
  preview,
  previewKind,
  dimmed,
  blocked,
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
  preview?: boolean;
  previewKind?: 'none' | 'path' | 'saada' | 'capture';
  dimmed: boolean;
  /** Multi-round: pit closed this round (unfilled). */
  blocked: boolean;
  disabled: boolean;
  onSelect: (p: PitIndex) => void;
  side: 'north' | 'south';
  pitRef: (el: HTMLButtonElement | null) => void;
}) {
  const seeds = useMemo(() => seedLayout(pit, count), [pit, count]);
  const label = INDEX_TO_LABEL[pit] ?? String(pit);
  const grew = count > prevCount;
  const shrank = count < prevCount;
  const playable = !disabled && legal && !blocked;

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
        preview ? 'is-preview' : '',
        preview && previewKind === 'capture' ? 'is-preview-capture' : '',
        preview && previewKind === 'saada' ? 'is-preview-saada' : '',
        dimmed ? 'is-dimmed' : '',
        blocked ? 'is-blocked' : '',
        grew ? 'is-drop' : '',
        shrank ? 'is-pickup' : '',
        side,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={!playable}
      onClick={() => {
        if (playable) onSelect(pit);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (playable) onSelect(pit);
        }
      }}
      aria-label={
        blocked
          ? `${side} pit ${label}, closed this round`
          : `${side} pit ${label}, ${count} seeds${legal ? ', can play' : ''}`
      }
      aria-pressed={selected || aiPreview}
      aria-disabled={!playable}
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
  const displayProtected = useGameStore((s) => s.displayProtected);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const highlightPit = useGameStore((s) => s.highlightPit);
  const highlightKind = useGameStore((s) => s.highlightKind);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const inputLocked = useGameStore((s) => s.inputLocked);
  const thinking = useGameStore((s) => s.thinking);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);
  const selectPit = useGameStore((s) => s.selectPit);
  const pendingDirection = useGameStore((s) => s.pendingDirection);
  const statusMessage = useGameStore((s) => s.statusMessage);
  const hintsEnabled = useGameStore((s) => s.hintsEnabled);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const animBudgetMs = useGameStore((s) => s.animBudgetMs);
  const previewPits = useGameStore((s) => s.previewPits);
  const previewKind = useGameStore((s) => s.previewKind);
  const settings = useGameStore((s) => s.settings);
  const reducedMotion = prefersReducedMotion(settings);
  const previewSet = useMemo(() => new Set(previewPits), [previewPits]);

  const boardRef = useRef<HTMLDivElement>(null);
  const pitEls = useRef<Map<number, HTMLButtonElement>>(new Map());
  const prevHighlight = useRef<number | null>(null);
  const prevPits = useRef<number[]>(displayPits.slice());
  const [flyer, setFlyer] = useState<Flyer | null>(null);
  const [handBadge, setHandBadge] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );
  const flyerKey = useRef(0);
  const hopRaf = useRef(0);
  /** Last flyer position — mid-hop continuity (same idea as Blender progressRef). */
  const flyerPosRef = useRef<{ x: number; y: number } | null>(null);

  // Track previous pit counts for pop animations
  const [prevCounts, setPrevCounts] = useState<number[]>(() => displayPits.slice());
  useEffect(() => {
    const id = requestAnimationFrame(() => setPrevCounts(displayPits.slice()));
    return () => cancelAnimationFrame(id);
  }, [displayPits]);

  // Flying seed: same hop math/duration as 3D play (store dropMs → hopDurationMs)
  useEffect(() => {
    const board = boardRef.current;
    const animating = isAnimatingPhase(turnPhase) || turnPhase === 'ai-preview';

    // Batch sow sets highlightPit null while still animating — clear the flyer
    // so a stuck bead does not linger over the board.
    if (!board || highlightPit === null || !animating) {
      cancelAnimationFrame(hopRaf.current);
      prevHighlight.current = highlightPit;
      if (highlightPit === null || !animating) {
        setFlyer(null);
        flyerPosRef.current = null;
      }
      return;
    }

    const target = pitEls.current.get(highlightPit);
    if (!target) return;

    const br = board.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const to = {
      x: tr.left + tr.width / 2 - br.left,
      y: tr.top + tr.height / 2 - br.top,
    };

    const fromPit = prevHighlight.current;
    // Prefer store-committed budget; never invent a sow hop from the HUD.
    const dropMs = resolveHopBudgetMs(
      animBudgetMs,
      highlightKind,
      travelSpeed,
      reducedMotion,
      dropMsForSpeed,
    );
    // Match BlenderBoard: only pit-to-pit *drops* use a hop arc; pickup /
    // continue / capture / saada sit on the active pit.
    const isHop =
      highlightKind === 'drop' &&
      !reducedMotion &&
      dropMs > 0 &&
      fromPit !== null &&
      fromPit !== highlightPit;

    cancelAnimationFrame(hopRaf.current);

    if (isHop) {
      const fromEl = fromPit !== null ? pitEls.current.get(fromPit) : undefined;
      // Prefer live flyer position (mid-hop) so chained drops don't snap back.
      let from = flyerPosRef.current;
      if (!from && fromEl) {
        const fr = fromEl.getBoundingClientRect();
        from = {
          x: fr.left + fr.width / 2 - br.left,
          y: fr.top + fr.height / 2 - br.top,
        };
      }
      if (!from) from = { ...to };

      const key = ++flyerKey.current;
      const dur = hopDurationMs(dropMs);
      const liftPx = hopLiftPx2d(from, to);
      const skew = randomHopSkew();

      if (dur <= 0) {
        flyerPosRef.current = to;
        setFlyer({ x: to.x, y: to.y, key, capture: false });
      } else {
        const origin = from;
        const t0 = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - t0) / dur);
          const p = hopPoint2d(origin, to, t, liftPx, skew);
          flyerPosRef.current = p;
          setFlyer({ x: p.x, y: p.y, key, capture: false });
          if (t < 1) hopRaf.current = requestAnimationFrame(tick);
        };
        flyerPosRef.current = origin;
        setFlyer({ x: origin.x, y: origin.y, key, capture: false });
        hopRaf.current = requestAnimationFrame(tick);
      }
    } else {
      // Pickup / continue / capture / saada: bead rests on the lit pit
      flyerPosRef.current = to;
      setFlyer({
        x: to.x,
        y: to.y,
        key: flyerKey.current,
        capture: highlightKind === 'capture',
      });
    }

    prevHighlight.current = highlightPit;
    return () => cancelAnimationFrame(hopRaf.current);
  }, [highlightPit, highlightKind, turnPhase, animBudgetMs, reducedMotion]);

  // Hand badge tracks status text without restarting the hop rAF.
  useEffect(() => {
    const board = boardRef.current;
    const animating = isAnimatingPhase(turnPhase) || turnPhase === 'ai-preview';
    if (!board || highlightPit === null || !animating) {
      setHandBadge(null);
      return;
    }
    const target = pitEls.current.get(highlightPit);
    if (!target) return;
    const br = board.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const short =
      statusMessage.length > 28 ? statusMessage.slice(0, 26) + '…' : statusMessage;
    setHandBadge({
      x: tr.left + tr.width / 2 - br.left,
      y: tr.top + tr.height / 2 - br.top - tr.height * 0.65,
      text: short,
    });
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
    !pendingDirection &&
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
  // Row focus must respect human-as-North and hotseat (not hard-coded South-you).
  const northIsYou = mode === 'ai' && humanPlayer === 'N';
  const southIsYou = mode === 'ai' && humanPlayer === 'S';
  const matchOver = turnPhase === 'over';
  const northActive =
    !matchOver &&
    (mode === 'ai'
      ? (northIsYou && yourTurn) || (!northIsYou && aiActive)
      : committed.toMove === 'N');
  const southActive =
    !matchOver &&
    (mode === 'ai'
      ? (southIsYou && yourTurn) || (!southIsYou && aiActive)
      : committed.toMove === 'S');
  // Dim the row that is not acting so the active side reads clearly.
  const northDimmed = mode === 'ai' && (northIsYou ? aiActive : yourTurn);
  const southDimmed = mode === 'ai' && (southIsYou ? aiActive : yourTurn);

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

        <div className={`pit-row north ${northActive ? 'row-active' : ''}`}>
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
              preview={previewSet.has(pit)}
              previewKind={previewKind}
              dimmed={northDimmed}
              blocked={Boolean(displayProtected[pit])}
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

        <div className={`pit-row south ${southActive ? 'row-active' : ''}`}>
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
              preview={previewSet.has(pit)}
              previewKind={previewKind}
              dimmed={southDimmed}
              blocked={Boolean(displayProtected[pit])}
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
