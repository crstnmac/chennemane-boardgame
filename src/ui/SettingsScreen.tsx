import type { DirectionMode } from '../engine';
import { useGameStore } from '../session/store';
import type { Settings } from '../session/settings';
import { TravelSpeedSlider } from './TravelSpeedSlider';

export function SettingsScreen() {
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const setScreen = useGameStore((s) => s.setScreen);
  const failed = useGameStore((s) => s.settingsPersistFailed);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    updateSettings({ [key]: value });
  };

  return (
    <div className="subpage">
      <div className="subpage-top">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setScreen('home')}
          aria-label="Back to home"
        >
          ←
        </button>
        <div>
          <h1 className="screen-title" style={{ margin: 0 }}>
            Settings
          </h1>
        </div>
      </div>
      <p className="subtitle">
        Travel speed applies immediately. Seeds-per-pit and direction apply on the next new game.
      </p>

      {failed && (
        <p className="card" role="status" style={{ marginBottom: '1rem' }}>
          Settings could not be saved (storage blocked). Values stay in memory for this session.
        </p>
      )}

      <div className="card surface-paper">
        <div className="field">
          <TravelSpeedSlider
            id="settings-travel-speed"
            value={settings.travelSpeed}
            onChange={(n) => set('travelSpeed', n)}
          />
          <p className="field-hint">
            How fast beads move when sowing in a game and in the tour demos.
          </p>
        </div>

        <div className="field">
          <label htmlFor="seeds">Seeds per pit</label>
          <select
            id="seeds"
            value={settings.initialSeedsPerPit}
            onChange={(e) =>
              set('initialSeedsPerPit', Number(e.target.value) as Settings['initialSeedsPerPit'])
            }
          >
            <option value={4}>4 (56 total)</option>
            <option value={5}>5 (70 total) — default</option>
            <option value={6}>6 (84 total)</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="dir">Direction mode</label>
          <select
            id="dir"
            value={
              settings.directionMode === 'fixedCcw' || settings.directionMode === 'fixedCw'
                ? settings.directionMode
                : 'bidirectional'
            }
            onChange={(e) => set('directionMode', e.target.value as DirectionMode)}
          >
            <option value="bidirectional">Choose each sowing (recommended)</option>
            <option value="fixedCcw">Always anti-clockwise</option>
            <option value="fixedCw">Always clockwise</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="motion">Reduced motion</label>
          <select
            id="motion"
            value={settings.reducedMotionOverride}
            onChange={(e) =>
              set(
                'reducedMotionOverride',
                e.target.value as Settings['reducedMotionOverride'],
              )
            }
          >
            <option value="auto">Match system preference</option>
            <option value="always">Always reduce</option>
            <option value="never">Never reduce</option>
          </select>
        </div>

        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.55rem' }}>
          <input
            id="multiround"
            type="checkbox"
            checked={settings.multiRound}
            onChange={(e) => set('multiRound', e.target.checked)}
          />
          <label htmlFor="multiround" style={{ margin: 0 }}>
            Multi-round handicap — re-seed each round from winnings; unfilled pits
            close. Series ends when a player cannot fill a pit. (Applies to new games)
          </label>
        </div>

        <div className="field">
          <label htmlFor="residual">Residual seeds at match end</label>
          <select
            id="residual"
            value={settings.residual}
            onChange={(e) =>
              set('residual', e.target.value as Settings['residual'])
            }
          >
            <option value="unclaimed">Unclaimed (default) — leftover seed not scored</option>
            <option value="to-last-mover">To last mover — leftover seeds go to who just played</option>
          </select>
          <p className="field-hint">
            Applies to single matches and multi-round board ends. (New games)
          </p>
        </div>

        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.55rem' }}>
          <input
            id="sound"
            type="checkbox"
            checked={settings.soundEnabled}
            onChange={(e) => set('soundEnabled', e.target.checked)}
          />
          <label htmlFor="sound" style={{ margin: 0 }}>
            Sound effects
          </label>
        </div>

        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.55rem', marginBottom: 0 }}>
          <input
            id="hints"
            type="checkbox"
            checked={settings.hintsDefault}
            onChange={(e) => set('hintsDefault', e.target.checked)}
          />
          <label htmlFor="hints" style={{ margin: 0 }}>
            Show legal-pit rings by default (Hints)
          </label>
        </div>
      </div>
    </div>
  );
}
