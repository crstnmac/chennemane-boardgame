import { lazy, Suspense, useEffect, useState } from 'react';
import { isPearDesktop, isP2PAvailable, p2pTransportLabel } from '../session/p2p';
import { useGameStore } from '../session/store';

const HomeBoardHero = lazy(() =>
  import('./three/HomeBoardHero').then((m) => ({ default: m.HomeBoardHero })),
);

export function HomeScreen() {
  const newGame = useGameStore((s) => s.newGame);
  const setScreen = useGameStore((s) => s.setScreen);
  const aiDifficulty = useGameStore((s) => s.aiDifficulty);
  const coachSeen = useGameStore((s) => s.coachSeen);
  const p2pAvailable = useGameStore((s) => s.p2pAvailable);
  const p2pLobbyStatus = useGameStore((s) => s.p2pLobbyStatus);
  const p2pLobbyMessage = useGameStore((s) => s.p2pLobbyMessage);
  const p2pRoomCode = useGameStore((s) => s.p2pRoomCode);
  const p2pLocalName = useGameStore((s) => s.p2pLocalName);
  const hostP2P = useGameStore((s) => s.hostP2P);
  const joinP2P = useGameStore((s) => s.joinP2P);
  const leaveP2P = useGameStore((s) => s.leaveP2P);
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState(p2pLocalName || '');
  const setDiff = (d: 'easy' | 'medium' | 'hard') => {
    useGameStore.setState({ aiDifficulty: d });
  };

  useEffect(() => {
    // Defer asset warm to first home paint (and idle time on Electron)
    const warm = () => {
      void import('./three/sharedAssets').then((m) => m.preloadBoardAssets());
      void import('./three/HomeBoardHero');
    };
    const ric = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(warm, { timeout: 1200 });
    } else {
      window.setTimeout(warm, 200);
    }
  }, []);

  // Desktop bridge or browser WebRTC may not be visible at store init; re-detect.
  useEffect(() => {
    const available = isP2PAvailable();
    if (available !== useGameStore.getState().p2pAvailable) {
      useGameStore.setState({ p2pAvailable: available });
    }
    // Clear stuck connecting only — keep hosting/joining wait UI
    const st = useGameStore.getState().p2pLobbyStatus;
    if (st === 'connecting') {
      useGameStore.setState({
        p2pLobbyStatus: 'idle',
        p2pLobbyMessage: '',
      });
    }
    const saved = useGameStore.getState().p2pLocalName;
    if (saved && !playerName) setPlayerName(saved);
  }, []);

  const waitingPeer = p2pLobbyStatus === 'hosting' || p2pLobbyStatus === 'joining';
  const p2pBusy = p2pLobbyStatus === 'connecting' || waitingPeer;
  const nameOk = playerName.trim().length >= 1;

  return (
    <div className="home-screen">
      <div className="home-stage" aria-hidden>
        <div className="home-hero-fallback" />
        <Suspense fallback={null}>
          <HomeBoardHero />
        </Suspense>
        <div className="home-stage-scrim" />
      </div>

      <div className="home-hud">
        <div className="home-tl">
          <span className="home-kicker">
            {p2pAvailable
              ? `Ali Guli Mane · ${p2pTransportLabel()}`
              : 'Ali Guli Mane'}
          </span>
        </div>

        <nav className="home-tr" aria-label="Menu">
          <button type="button" className="hud-chip" onClick={() => setScreen('coach')}>
            Tour
          </button>
          <button type="button" className="hud-chip" onClick={() => setScreen('rules')}>
            Rules
          </button>
          <button type="button" className="hud-chip" onClick={() => setScreen('settings')}>
            Settings
          </button>
        </nav>

        <div className="home-center">
          <h1 className="home-title">Ali Guli Mane</h1>
          <p className="home-tagline">
            Mancala for two — ಅಳಿ ಗುಳಿ ಮಣೆ. Count seeds, plan captures, outscore the other side.
          </p>

          <div className="home-actions">
            {p2pAvailable && (
              <>
                <label className="home-p2p-name" htmlFor="p2p-player-name">
                  <span className="home-p2p-name-label">Your name</span>
                  <input
                    id="p2p-player-name"
                    type="text"
                    maxLength={24}
                    placeholder="Player name"
                    value={playerName}
                    disabled={p2pBusy}
                    autoComplete="nickname"
                    spellCheck={false}
                    onChange={(e) => setPlayerName(e.target.value.slice(0, 24))}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </label>

                {waitingPeer ? (
                  <div className="home-p2p-wait" role="status">
                    <p className="home-p2p-wait-title">
                      {p2pLobbyStatus === 'hosting' ? 'Waiting for opponent' : 'Connecting to host'}
                    </p>
                    {p2pRoomCode && (
                      <p className="home-p2p-wait-code" aria-label="Room code">
                        {p2pRoomCode}
                      </p>
                    )}
                    <p className="home-p2p-msg">
                      {p2pLobbyMessage ||
                        (p2pLobbyStatus === 'hosting'
                          ? 'Share this code — the match starts when they join.'
                          : 'Hang tight…')}
                    </p>
                    <p className="home-p2p-msg muted">Playing as {playerName.trim() || 'Player'}</p>
                    <button
                      type="button"
                      className="btn btn-ghost btn-block"
                      onClick={() => void leaveP2P()}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      disabled={p2pBusy || !nameOk}
                      onClick={() => void hostP2P(playerName)}
                    >
                      {p2pLobbyStatus === 'connecting'
                        ? 'Creating room…'
                        : 'Create room & invite (South)'}
                    </button>
                    <div className="home-p2p-join">
                      <input
                        id="p2p-room-code"
                        type="text"
                        inputMode="text"
                        maxLength={12}
                        placeholder="Room code"
                        value={roomCode}
                        disabled={p2pBusy || !nameOk}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) =>
                          setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                        }
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter' && roomCode.trim().length >= 4 && nameOk) {
                            e.preventDefault();
                            void joinP2P(roomCode, playerName);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="P2P room code"
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={p2pBusy || !nameOk || roomCode.trim().length < 4}
                        onClick={() => void joinP2P(roomCode, playerName)}
                      >
                        Join (North)
                      </button>
                    </div>
                  </>
                )}
                {p2pLobbyMessage && !waitingPeer ? (
                  <p className="home-p2p-msg" role="status">
                    {p2pLobbyMessage}
                  </p>
                ) : !waitingPeer ? (
                  <p className="home-p2p-msg muted">
                    Enter your name, then create or join. Match starts when both players are in.
                  </p>
                ) : null}
                <hr className="home-divider" />
              </>
            )}

            <label className="home-diff" htmlFor="diff">
              <span className="home-diff-label">Opponent</span>
              <select
                id="diff"
                value={aiDifficulty}
                onChange={(e) =>
                  setDiff(e.target.value as 'easy' | 'medium' | 'hard')
                }
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </label>

            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={waitingPeer}
              onClick={() => newGame('ai', { difficulty: useGameStore.getState().aiDifficulty })}
            >
              Play vs AI
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              disabled={waitingPeer}
              onClick={() => newGame('hotseat')}
            >
              Two players · same device
            </button>
          </div>

          {!coachSeen && (
            <button type="button" className="home-nudge" onClick={() => setScreen('coach')}>
              New here? Four short tips →
            </button>
          )}
        </div>

        <p className="home-bl">
          {p2pAvailable
            ? isPearDesktop()
              ? 'Desktop · Pear P2P multiplayer'
              : 'Browser · invite a friend with a room code'
            : 'Ali Guli Mane · works offline'}
        </p>
      </div>
    </div>
  );
}
