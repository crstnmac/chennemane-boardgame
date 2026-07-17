import { useEffect, useRef, useState } from 'react';
import { isTerminal, needsSecondSowing } from '../engine';
import { buildMatchReport, copyMatchReport } from '../session/matchReport';
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
  const p2pRoomCode = useGameStore((s) => s.p2pRoomCode);
  const p2pConnected = useGameStore((s) => s.p2pConnected);
  const p2pReconnecting = useGameStore((s) => s.p2pReconnecting);
  const p2pLocalName = useGameStore((s) => s.p2pLocalName);
  const p2pRemoteName = useGameStore((s) => s.p2pRemoteName);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const displayHand = useGameStore((s) => s.displayHand);
  const lastMatchEndReason = useGameStore((s) => s.lastMatchEndReason);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const [reportCopied, setReportCopied] = useState(false);

  const undo = useGameStore((s) => s.undo);
  const redo = useGameStore((s) => s.redo);
  const resign = useGameStore((s) => s.resign);
  const skipAnimation = useGameStore((s) => s.skipAnimation);
  const toggleHints = useGameStore((s) => s.toggleHints);
  const setScreen = useGameStore((s) => s.setScreen);
  const newGame = useGameStore((s) => s.newGame);
  const leaveP2P = useGameStore((s) => s.leaveP2P);
  const reconnectP2P = useGameStore((s) => s.reconnectP2P);
  const dismissResult = useGameStore((s) => s.dismissResult);

  const [leaveOpen, setLeaveOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const leaveDialogRef = useRef<HTMLDivElement>(null);
  const resignDialogRef = useRef<HTMLDivElement>(null);
  const menuDialogRef = useRef<HTMLDivElement>(null);
  /** Safe action gets initial focus — not the destructive one. */
  const leaveStayRef = useRef<HTMLButtonElement>(null);
  const resignCancelRef = useRef<HTMLButtonElement>(null);
  const menuCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!leaveOpen) return;
    const root = leaveDialogRef.current;
    if (!root) return;
    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, leaveStayRef.current);
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
    const release = trapFocus(root, resignCancelRef.current);
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

  useEffect(() => {
    if (!menuOpen) return;
    const root = menuDialogRef.current;
    if (!root) return;
    document.body.classList.add('a11y-modal-open');
    const release = trapFocus(root, menuCloseRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('a11y-modal-open');
      release();
    };
  }, [menuOpen]);

  if (!committed) {
    if (mode === 'p2p') {
      return (
        <div className="play-empty">
          <p>Connecting to P2P room…</p>
          {p2pRoomCode && <p className="play-empty-code">{p2pRoomCode}</p>}
          <p className="play-empty-sub">
            {p2pConnected
              ? 'Syncing board…'
              : p2pReconnecting
                ? 'Reconnecting…'
                : 'Looking for opponent…'}
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => void leaveP2P()}>
            Cancel
          </button>
        </div>
      );
    }
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
  const outcome = matchOutcome(committed, {
    mode,
    humanPlayer,
    endReason: lastMatchEndReason,
    names: { local: p2pLocalName, remote: p2pRemoteName },
  });
  const aiPhase =
    turnPhase === 'ai-thinking' ||
    turnPhase === 'ai-preview' ||
    turnPhase === 'ai-playing';
  const yourTurn =
    turnPhase === 'your-turn' && (mode === 'ai' || mode === 'p2p');
  // Only enable Skip while an animation / AI sow is actually running.
  const animRunning =
    inputLocked ||
    thinking ||
    turnPhase === 'animating' ||
    turnPhase === 'ai-playing' ||
    turnPhase === 'ai-preview' ||
    turnPhase === 'ai-thinking' ||
    turnPhase === 'pass';
  const canSkip = animRunning && !terminal;
  const forcedSecond =
    needsSecondSowing(committed) &&
    !terminal &&
    (turnPhase === 'your-turn' || turnPhase === 'hotseat-turn');

  const northIsYou =
    (mode === 'ai' || mode === 'p2p') && humanPlayer === 'N';
  const southIsYou =
    (mode === 'ai' || mode === 'p2p') && humanPlayer === 'S';
  const opponentPhase =
    mode === 'p2p' && !yourTurn && !terminal && turnPhase !== 'animating';
  const northActive =
    !terminal &&
    ((mode === 'ai' && humanPlayer === 'S' && aiPhase) ||
      (mode === 'ai' && humanPlayer === 'N' && yourTurn) ||
      (mode === 'p2p' && committed.toMove === 'N') ||
      (mode === 'hotseat' && committed.toMove === 'N'));
  const southActive =
    !terminal &&
    ((mode === 'ai' && humanPlayer === 'S' && yourTurn) ||
      (mode === 'ai' && humanPlayer === 'N' && aiPhase) ||
      (mode === 'p2p' && committed.toMove === 'S') ||
      (mode === 'hotseat' && committed.toMove === 'S'));

  const statusTone = forcedSecond
    ? 'second'
    : aiPhase || opponentPhase
      ? 'ai'
      : yourTurn
        ? 'you'
        : turnPhase === 'pass'
          ? 'pass'
          : 'neutral';

  const northLabel = northIsYou
    ? `${mode === 'p2p' ? p2pLocalName || 'You' : 'You'} · A`
    : mode === 'ai'
      ? 'AI · A'
      : mode === 'p2p'
        ? `${p2pRemoteName || 'Opponent'} · A`
        : 'North · A';
  const southLabel = southIsYou
    ? `${mode === 'p2p' ? p2pLocalName || 'You' : 'You'} · B`
    : mode === 'ai'
      ? 'AI · B'
      : mode === 'p2p'
        ? `${p2pRemoteName || 'Opponent'} · B`
        : 'South · B';

  const midMatch = !terminal && (historyPast.length > 0 || mode === 'p2p');

  const requestLeave = () => {
    if (midMatch) setLeaveOpen(true);
    else if (mode === 'p2p') void leaveP2P();
    else setScreen('home');
  };

  const confirmLeave = () => {
    setLeaveOpen(false);
    if (mode === 'p2p') void leaveP2P();
    else setScreen('home');
  };

  const dirFixed =
    committed.config.directionMode === 'fixedCcw' ||
    committed.config.directionMode === 'fixedCw';
  const contextHint = yourTurn
    ? dirFixed
      ? 'Tap a legal pit on your row'
      : 'Choose a pit, then a direction'
    : aiPhase
      ? 'Opponent is sowing'
      : mode === 'p2p'
        ? p2pConnected
          ? `${p2pRemoteName || 'Opponent'}'s turn`
          : p2pReconnecting
            ? `Reconnecting to room ${p2pRoomCode || '—'}…`
            : `Room ${p2pRoomCode || '—'} · waiting for peer`
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
          forcedSecond ? 'board-second-sowing' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <BoardView />
      </div>

      {/* Forced-second uses objective tone only — avoid stacked banners. */}

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
              {mode === 'ai'
                ? `AI · ${aiDifficulty}`
                : mode === 'p2p'
                  ? `P2P · ${p2pRoomCode || '…'}${
                      p2pConnected
                        ? p2pRemoteName
                          ? ` · vs ${p2pRemoteName}`
                          : ''
                        : p2pReconnecting
                          ? ' · reconnecting'
                          : ' · disconnected'
                    }`
                  : 'Local'}
              {committed.config.matchStructure === 'multi-round-protected'
                ? ` · Round ${displayRound + 1}`
                : ''}
            </span>
          </div>
        </div>

        {/* Desktop / wide: full utility strip */}
        <div className="hud-tr hud-tr-wide" aria-label="Match controls">
          <button
            type="button"
            className="hud-icon"
            onClick={undo}
            disabled={mode === 'p2p' || historyPast.length === 0}
            aria-label="Undo"
            title={mode === 'p2p' ? 'Undo disabled online' : 'Undo'}
          >
            ↩
          </button>
          <button
            type="button"
            className="hud-icon"
            onClick={redo}
            disabled={mode === 'p2p' || historyFuture.length === 0}
            aria-label="Redo"
            title={mode === 'p2p' ? 'Redo disabled online' : 'Redo'}
          >
            ↪
          </button>
          <button
            type="button"
            className={`hud-icon ${canSkip ? 'is-active-skip' : ''}`}
            onClick={skipAnimation}
            disabled={!canSkip}
            aria-label={canSkip ? 'Skip animation' : 'No animation to skip'}
            title={canSkip ? 'Skip animation' : 'Nothing to skip'}
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

        {/* Narrow: single Menu control to avoid top-right collision */}
        <div className="hud-tr hud-tr-narrow">
          {canSkip && (
            <button
              type="button"
              className="hud-icon is-active-skip"
              onClick={skipAnimation}
              aria-label="Skip animation"
              title="Skip animation"
            >
              ⏭
            </button>
          )}
          <button
            type="button"
            className="hud-chip"
            onClick={() => setMenuOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-label="Match menu"
            title="Menu"
          >
            Menu
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
          className={`hud-objective tone-${statusTone}${
            mode === 'p2p' && !p2pConnected ? ' tone-pass' : ''
          }`}
          role="status"
          aria-live="polite"
        >
          {(turnPhase === 'ai-thinking' || thinking || p2pReconnecting) && (
            <span className="hud-objective-pulse" aria-hidden />
          )}
          <p className="hud-objective-main">{statusMessage || 'Play'}</p>
          {(statusDetail || contextHint) && (
            <p className="hud-objective-sub">{statusDetail || contextHint}</p>
          )}
          {mode === 'p2p' && !p2pConnected && !terminal && (
            <div className="hud-reconnect">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={p2pReconnecting}
                onClick={() => void reconnectP2P()}
              >
                {p2pReconnecting ? 'Reconnecting…' : 'Reconnect now'}
              </button>
              <p className="hud-reconnect-hint">
                {humanPlayer === 'S'
                  ? 'You are the host — stay here; they rejoin with the same room code.'
                  : 'Guest will auto-retry; use the button to try immediately.'}
              </p>
            </div>
          )}
        </div>
      </div>

      <DirectionChooser />

      {menuOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setMenuOpen(false)}
        >
          <div
            ref={menuDialogRef}
            className="modal card surface-paper hud-menu-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="match-menu-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="match-menu-title" className="modal-title">
              Match menu
            </h2>
            <div className="hud-menu-actions">
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={historyPast.length === 0}
                onClick={() => {
                  undo();
                  setMenuOpen(false);
                }}
              >
                Undo
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={historyFuture.length === 0}
                onClick={() => {
                  redo();
                  setMenuOpen(false);
                }}
              >
                Redo
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-block ${canSkip ? 'is-skip-ready' : ''}`}
                disabled={!canSkip}
                onClick={() => {
                  skipAnimation();
                  setMenuOpen(false);
                }}
              >
                {canSkip ? 'Skip animation' : 'Nothing to skip'}
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-block ${hintsEnabled ? 'is-on-soft' : ''}`}
                aria-pressed={hintsEnabled}
                onClick={() => {
                  toggleHints();
                }}
              >
                {hintsEnabled ? 'Hints on' : 'Hints off'}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-block"
                disabled={terminal}
                onClick={() => {
                  setMenuOpen(false);
                  setResignOpen(true);
                }}
              >
                Resign
              </button>
              <button
                ref={menuCloseRef}
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => setMenuOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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
                ref={leaveStayRef}
                type="button"
                className="btn btn-primary"
                onClick={() => setLeaveOpen(false)}
              >
                Stay
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={confirmLeave}
              >
                Leave
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
                ref={resignCancelRef}
                type="button"
                className="btn btn-primary"
                onClick={() => setResignOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setResignOpen(false);
                  resign();
                }}
              >
                Resign
              </button>
            </div>
          </div>
        </div>
      )}

      {showResult && outcome.kind !== 'ongoing' && (
        <ResultOverlay
          outcome={outcome}
          reportCopied={reportCopied}
          onCopyReport={() => {
            const text = buildMatchReport({
              committed,
              mode,
              humanPlayer,
              aiDifficulty,
              endReason: lastMatchEndReason,
            });
            void copyMatchReport(text).then((ok) => {
              if (ok) {
                setReportCopied(true);
                window.setTimeout(() => setReportCopied(false), 2000);
              }
            });
          }}
          onPlayAgain={() => {
            dismissResult();
            if (mode === 'p2p') {
              void leaveP2P();
              return;
            }
            newGame(mode, {
              difficulty: aiDifficulty,
              human: humanPlayer,
            });
          }}
          onHome={() => {
            dismissResult();
            if (mode === 'p2p') void leaveP2P();
            else setScreen('home');
          }}
        />
      )}
    </div>
  );
}
