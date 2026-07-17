import { useEffect, useRef } from 'react';
import {
  defaultPreviewDirection,
  INDEX_TO_LABEL,
  previewMoveConsequences,
  type Direction,
} from '../engine';
import { useGameStore } from '../session/store';
import { trapFocus } from './a11y/focusTrap';

export function DirectionChooser() {
  const pending = useGameStore((s) => s.pendingDirection);
  const chooseDirection = useGameStore((s) => s.chooseDirection);
  const clearSelection = useGameStore((s) => s.clearSelection);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const displayHand = useGameStore((s) => s.displayHand);
  const committed = useGameStore((s) => s.committed);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstBtnRef = useRef<HTMLButtonElement>(null);
  const pitLabel =
    selectedPit !== null ? (INDEX_TO_LABEL[selectedPit] ?? `pit ${selectedPit}`) : null;

  const showPreview = (dir: Direction) => {
    const state = useGameStore.getState().committed;
    const pit = useGameStore.getState().selectedPit;
    if (!state || pit === null) return;
    const prev = previewMoveConsequences(state, { startPit: pit, direction: dir });
    if (!prev) {
      useGameStore.setState({ previewPits: [], previewKind: 'none' });
      return;
    }
    const pits = [
      ...(prev.saadaEmpty !== null ? [prev.saadaEmpty] : []),
      ...prev.capturePits,
    ];
    useGameStore.setState({
      previewPits: pits,
      previewKind:
        prev.capturePits.length > 0
          ? 'capture'
          : prev.saadaEmpty !== null
            ? 'saada'
            : 'path',
      statusDetail:
        prev.captureTotal > 0
          ? `${dir === 'ccw' ? 'Anti-clockwise' : 'Clockwise'} · capture +${prev.captureTotal}`
          : prev.saadaEmpty !== null
            ? `${dir === 'ccw' ? 'Anti-clockwise' : 'Clockwise'} · saada (empty capture)`
            : `${dir === 'ccw' ? 'Anti-clockwise' : 'Clockwise'} · relay continues`,
    });
  };

  useEffect(() => {
    if (!pending || selectedPit === null || !committed) return;
    showPreview(defaultPreviewDirection(committed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, selectedPit, committed]);

  useEffect(() => {
    if (!pending) return;
    const root = dialogRef.current;
    if (!root) return;

    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, firstBtnRef.current);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        showPreview('ccw');
        chooseDirection('ccw');
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        showPreview('cw');
        chooseDirection('cw');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('a11y-modal-open');
      release();
    };
  }, [pending, chooseDirection, clearSelection]);

  if (!pending) return null;

  return (
    <div
      className="dir-sheet"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) clearSelection();
      }}
    >
      <div
        ref={dialogRef}
        className="dir-sheet-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dir-dialog-title"
        aria-describedby="dir-dialog-desc"
      >
        <p className="dir-sheet-kicker">
          {pitLabel ? `From ${pitLabel}` : 'Sowing'}
          {displayHand !== null && displayHand > 0
            ? ` · ${displayHand} remaining`
            : ''}
        </p>
        <h3 id="dir-dialog-title" className="dir-sheet-title">
          Direction
        </h3>
        <p id="dir-dialog-desc" className="dir-sheet-sub">
          {displayHand !== null && displayHand > 0
            ? `${displayHand} seed${displayHand === 1 ? '' : 's'} — one per pit. `
            : ''}
          Use ← / A or → / D, or Escape to cancel.
        </p>
        <div className="dir-sheet-actions">
          <button
            ref={firstBtnRef}
            type="button"
            className="dir-btn"
            onMouseEnter={() => showPreview('ccw')}
            onFocus={() => showPreview('ccw')}
            onClick={() => chooseDirection('ccw')}
          >
            <span className="dir-arrow" aria-hidden>
              ↺
            </span>
            <span className="dir-btn-label">Anti-clockwise</span>
            <span className="dir-btn-hint">← or A</span>
          </button>
          <button
            type="button"
            className="dir-btn"
            onMouseEnter={() => showPreview('cw')}
            onFocus={() => showPreview('cw')}
            onClick={() => chooseDirection('cw')}
          >
            <span className="dir-arrow" aria-hidden>
              ↻
            </span>
            <span className="dir-btn-label">Clockwise</span>
            <span className="dir-btn-hint">→ or D</span>
          </button>
        </div>
        <button type="button" className="dir-cancel" onClick={clearSelection}>
          Cancel
        </button>
      </div>
    </div>
  );
}
