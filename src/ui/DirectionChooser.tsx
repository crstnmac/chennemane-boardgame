import { useEffect, useRef } from 'react';
import { useGameStore } from '../session/store';
import { trapFocus } from './a11y/focusTrap';

export function DirectionChooser() {
  const pending = useGameStore((s) => s.pendingDirection);
  const chooseDirection = useGameStore((s) => s.chooseDirection);
  const clearSelection = useGameStore((s) => s.clearSelection);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pending) return;
    const root = dialogRef.current;
    if (!root) return;

    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, firstBtnRef.current);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        chooseDirection('ccw');
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
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
          Pit {selectedPit !== null ? selectedPit + 1 : ''}
        </p>
        <h3 id="dir-dialog-title" className="dir-sheet-title">
          Direction
        </h3>
        <p id="dir-dialog-desc" className="dir-sheet-sub">
          One seed per pit along this path. Use ← / A or → / D, or Escape to cancel.
        </p>
        <div className="dir-sheet-actions">
          <button
            ref={firstBtnRef}
            type="button"
            className="dir-btn"
            onClick={() => chooseDirection('ccw')}
          >
            <span className="dir-arrow" aria-hidden>
              ↺
            </span>
            <span className="dir-btn-label">Anti-clockwise</span>
            <span className="dir-btn-hint">← or A</span>
          </button>
          <button type="button" className="dir-btn" onClick={() => chooseDirection('cw')}>
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
