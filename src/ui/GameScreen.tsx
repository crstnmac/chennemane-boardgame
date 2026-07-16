import { useEffect, useRef, useState } from 'react';
import { isTerminal } from '../engine';
import { matchOutcome } from '../session/outcome';
import { useGameStore } from '../session/store';
import { trapFocus } from './a11y/focusTrap';
import { AnimatedScore } from './AnimatedScore';
import { BoardView } from './BoardView';
import { DirectionChooser } from './DirectionChooser';
import { ResultOverlay } from './ResultOverlay';
import { TravelSpeedSlider } from './TravelSpeedSlider';

export function GameScreen() {
  const committed = useGameStore((s) => s.committed);
  const displayScore = useGameStore((s) => s.displayScore);
  const displayRound = useGameStore((s) => s.displayRound);
  const statusMessage = useGameStore((s) => s.statusMessage);
  const statusDetail = useGameStore((s) => s.statusDetail);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const showResult = useGameStore((s) => s.showResult);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);
  const historyPast = useGameStore((s) => s.historyPast);
  const historyFuture = useGameStore((s) => s.historyFuture);
  const inputLocked = useGameStore((s) => s.inputLocked);
  const thinking = useGameStore((s) => s.thinking);
  const hintsEnabled = useGameStore((s) => s.hintsEnabled);
  const aiDifficulty = useGameStore((s) => s.aiDifficulty);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const displayHand = useGameStore((s) => s.displayHand);
  const updateSettings = useGameStore((s) => s.updateSettings);

  const undo = useGameStore((s) => s.undo);
  const redo = useGameStore((s) => s.redo);
  const resign = useGameStore((s) => s.resign);
  const skipAnimation = useGameStore((s) => s.skipAnimation);
  const toggleHints = useGameStore((s) => s.toggleHints);
  const setScreen = useGameStore((s) => s.setScreen);
  const newGame = useGameStore((s) => s.newGame);
  const dismissResult = useGameStore((s) => s.dismissResult);

  const [leaveOpen, setLeaveOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);
  const leaveDialogRef = useRef<HTMLDivElement>(null);
  const resignDialogRef = useRef<HTMLDivElement>(null);
  const leaveConfirmRef = useRef<HTMLButtonElement>(null);
  const resignConfirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!leaveOpen) return;
    const root = leaveDialogRef.current;
    if (!root) return;
    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, leaveConfirmRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setLeaveOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('a11y-modal-open');
      release();
    };
  }, [leaveOpen]);

  useEffect(() => {
    if (!resignOpen) return;
    const root = resignDialogRef.current;
    if (!root) return;
    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, resignConfirmRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setResignOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('a11y-modal-open');
      release();
    };
  }, [resignOpen]);

  if (!committed) {
    return (
      <div className="play-empty">
        <p>No active game.</p>
        <button type="button" className="btn btn-primary" onClick={() => setScreen('home')}>
          Back home
        </button>
      </div>
    );
  }

  const terminal = isTerminal(committed);
  const outcome = matchOutcome(committed, { mode, humanPlayer });
  const aiPhase =
    turnPhase === 'ai-thinking' ||
    turnPhase === 'ai-preview' ||
    turnPhase === 'ai-playing';
  const yourTurn = turnPhase === 'your-turn' && mode === 'ai';
  const canSkip = inputLocked || thinking || aiPhase;

  const northIsYou = mode === 'ai' && humanPlayer === 'N';
  const southIsYou = mode === 'ai' && humanPlayer === 'S';
  const northActive =
    !terminal &&
    ((mode === 'ai' && humanPlayer === 'S' && aiPhase) ||
      (mode === 'ai' && humanPlayer === 'N' && yourTurn) ||
      (mode !== 'ai' && committed.toMove === 'N'));
  const southActive =
    !terminal &&
    ((mode === 'ai' && humanPlayer === 'S' && yourTurn) ||
      (mode === 'ai' && humanPlayer === 'N' && aiPhase) ||
      (mode !== 'ai' && committed.toMove === 'S'));

  const statusTone = aiPhase
    ? 'ai'
    : yourTurn
      ? 'you'
      : turnPhase === 'pass'
        ? 'pass'
        : 'neutral';

  const northLabel = northIsYou
    ? 'You · A'
    : mode === 'ai'
      ? 'AI · A'
      : 'North · A';
  const southLabel = southIsYou
    ? 'You · B'
    : mode === 'ai'
      ? 'AI · B'
      : 'South · B';

  const midMatch = !terminal && historyPast.length > 0;

  const requestLeave = () => {
    if (midMatch) setLeaveOpen(true);
    else setScreen('home');
  };

  const contextHint = yourTurn
    ? 'Choose a pit, then a direction'
    : aiPhase
      ? 'Opponent is sowing'
      : mode === 'hotseat'
        ? `${committed.toMove === 'S' ? 'South' : 'North'} to move`
        : 'Orbit · zoom · tap a pit';

  return (
    <div className="play-screen">
      {/* Soft CSS fallback while WebGL / HDR loads */}
      <div className="play-bg" aria-hidden />

      <div
        className={[
          'play-viewport',
          aiPhase ? 'board-ai-turn' : '',
          yourTurn ? 'board-your-turn' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <BoardView />
      </div>

      <div className="play-hud">
        <div className="hud-tl">
          <button
            type="button"
            className="hud-icon"
            onClick={requestLeave}
            aria-label="Leave game"
            title="Home"
          >
            ←
          </button>
          <div className="hud-meta">
            <span className="hud-meta-title">Ali Guli Mane</span>
            <span className="hud-meta-sub">
              {mode === 'ai' ? `AI · ${aiDifficulty}` : 'Local'}
              {committed.config.matchStructure === 'multi-round-protected'
                ? ` · Round ${displayRound + 1}`
                : ''}
            </span>
          </div>
        </div>

        <div className="hud-tr">
          <button
            type="button"
            className="hud-icon"
            onClick={undo}
            disabled={historyPast.length === 0}
            aria-label="Undo"
            title="Undo"
          >
            ↩
          </button>
          <button
            type="button"
            className="hud-icon"
            onClick={redo}
            disabled={historyFuture.length === 0}
            aria-label="Redo"
            title="Redo"
          >
            ↪
          </button>
          <button
            type="button"
            className="hud-icon"
            onClick={skipAnimation}
            disabled={!canSkip}
            aria-label="Skip animation"
            title="Skip"
          >
            ⏭
          </button>
          <button
            type="button"
            className={`hud-chip ${hintsEnabled ? 'is-on' : ''}`}
            onClick={toggleHints}
            title={
              hintsEnabled
                ? 'Hide legal-pit rings'
                : 'Show legal-pit rings'
            }
            aria-pressed={hintsEnabled}
            aria-label={
              hintsEnabled
                ? 'Hints on: hide legal-move highlights'
                : 'Hints off: show legal-move highlights'
            }
          >
            Hints
          </button>
          <button
            type="button"
            className="hud-chip is-danger"
            onClick={() => setResignOpen(true)}
            disabled={terminal}
            title="Resign"
          >
            Resign
          </button>
        </div>

        <div className="hud-speed">
          <TravelSpeedSlider
            id="game-travel-speed"
            compact
            value={travelSpeed}
            onChange={(n) => updateSettings({ travelSpeed: n })}
          />
        </div>

        {displayHand !== null && displayHand > 0 && (
          <div
            className="hand-tray"
            role="status"
            aria-live="polite"
            aria-label={`${displayHand} seed${displayHand === 1 ? '' : 's'} remaining`}
          >
            <span className="hand-tray-kicker">Remaining</span>
            <span className="hand-tray-count">{displayHand}</span>
          </div>
        )}

        <div
          className={[
            'hud-score',
            'hud-score-n',
            northActive ? 'is-active' : '',
            northIsYou ? 'is-you' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="hud-score-label">{northLabel}</span>
          <AnimatedScore value={displayScore.N} className="hud-score-value" />
          {northActive && <span className="hud-score-cue">Turn</span>}
        </div>

        <div
          className={[
            'hud-score',
            'hud-score-s',
            southActive ? 'is-active' : '',
            southIsYou ? 'is-you' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="hud-score-label">{southLabel}</span>
          <AnimatedScore value={displayScore.S} className="hud-score-value" />
          {southActive && <span className="hud-score-cue">Turn</span>}
        </div>

        <div
          className={`hud-objective tone-${statusTone}`}
          role="status"
          aria-live="polite"
        >
          {(turnPhase === 'ai-thinking' || thinking) && (
            <span className="hud-objective-pulse" aria-hidden />
          )}
          <p className="hud-objective-main">{statusMessage || 'Play'}</p>
          {(statusDetail || contextHint) && (
            <p className="hud-objective-sub">{statusDetail || contextHint}</p>
          )}
        </div>
      </div>

      <DirectionChooser />

      {leaveOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setLeaveOpen(false)}>
          <div
            ref={leaveDialogRef}
            className="modal card surface-paper"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            aria-describedby="leave-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="leave-title" className="modal-title">
              Leave match?
            </h2>
            <p id="leave-desc" className="modal-body">
              Progress on this board will be lost.
            </p>
            <div className="modal-actions">
              <button
                ref={leaveConfirmRef}
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setLeaveOpen(false);
                  setScreen('home');
                }}
              >
                Leave
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setLeaveOpen(false)}>
                Stay
              </button>
            </div>
          </div>
        </div>
      )}

      {resignOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setResignOpen(false)}>
          <div
            ref={resignDialogRef}
            className="modal card surface-paper"
            role="dialog"
            aria-modal="true"
            aria-labelledby="resign-title"
            aria-describedby="resign-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="resign-title" className="modal-title">
              Resign?
            </h2>
            <p id="resign-desc" className="modal-body">
              Your opponent wins this match.
            </p>
            <div className="modal-actions">
              <button
                ref={resignConfirmRef}
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setResignOpen(false);
                  resign();
                }}
              >
                Resign
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setResignOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showResult && outcome.kind !== 'ongoing' && (
        <ResultOverlay
          outcome={outcome}
          onPlayAgain={() => {
            dismissResult();
            newGame(mode, {
              difficulty: aiDifficulty,
              human: humanPlayer,
            });
          }}
          onHome={() => {
            dismissResult();
            setScreen('home');
          }}
        />
      )}
    </div>
  );
}
