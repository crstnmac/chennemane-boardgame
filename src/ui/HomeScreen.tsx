import { lazy, Suspense, useEffect } from 'react';
import { useGameStore } from '../session/store';

const HomeBoardHero = lazy(() =>
  import('./three/HomeBoardHero').then((m) => ({ default: m.HomeBoardHero })),
);

// Start fetching hero chunk + GLBs as soon as home mounts
void import('./three/HomeBoardHero');
void import('./three/sharedAssets').then((m) => m.preloadBoardAssets());

export function HomeScreen() {
  const newGame = useGameStore((s) => s.newGame);
  const setScreen = useGameStore((s) => s.setScreen);
  const aiDifficulty = useGameStore((s) => s.aiDifficulty);
  const coachSeen = useGameStore((s) => s.coachSeen);
  const setDiff = (d: 'easy' | 'medium' | 'hard') => {
    useGameStore.setState({ aiDifficulty: d });
  };

  useEffect(() => {
    void import('./three/sharedAssets').then((m) => m.preloadBoardAssets());
  }, []);

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
          <span className="home-kicker">Ali Guli Mane</span>
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
              onClick={() => newGame('ai', { difficulty: useGameStore.getState().aiDifficulty })}
            >
              Play vs AI
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
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

        <p className="home-bl">Ali Guli Mane · works offline</p>
      </div>
    </div>
  );
}
