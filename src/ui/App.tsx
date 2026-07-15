import { useGameStore } from '../session/store';
import { CoachScreen } from './CoachScreen';
import { GameScreen } from './GameScreen';
import { HomeScreen } from './HomeScreen';
import { RulesScreen } from './RulesScreen';
import { SettingsScreen } from './SettingsScreen';
import './theme.css';
import './styles.css';
import './play.css';

export function App() {
  const screen = useGameStore((s) => s.screen);

  const immersive = screen === 'game' || screen === 'home' || screen === 'coach';

  return (
    <div className={immersive ? 'app-shell app-shell-play' : 'app-shell'}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <main id="main-content" tabIndex={-1} className="app-main">
        {screen === 'home' && <HomeScreen />}
        {screen === 'game' && <GameScreen />}
        {screen === 'rules' && <RulesScreen />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'coach' && <CoachScreen />}
      </main>
    </div>
  );
}
