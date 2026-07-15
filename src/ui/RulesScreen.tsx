import { useGameStore } from '../session/store';

export function RulesScreen() {
  const setScreen = useGameStore((s) => s.setScreen);

  return (
    <div className="subpage rules-body">
      <div className="subpage-top">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setScreen('home')}
          aria-label="Back to home"
        >
          ←
        </button>
        <h1 className="screen-title" style={{ margin: 0 }}>
          How to play
        </h1>
      </div>
      <p className="subtitle">Ali Guli Mane (ಅಳಿ ಗುಳಿ ಮಣೆ)</p>

      <div className="card surface-paper">
        <h3>Setup</h3>
        <p>
          Two rows of seven pits. You own the near row (South). Default fill is{' '}
          <strong>5 seeds</strong> per pit (70 total). Captures add to your score off the board.
        </p>

        <h3>Your turn</h3>
        <ul>
          <li>Pick a non-empty pit on your row.</li>
          <li>Choose clockwise or anti-clockwise.</li>
          <li>Drop one seed in each pit along that path, both rows included.</li>
          <li>
            After the last drop, look at the <em>next</em> pit. If it has seeds, pick them up and
            continue (<strong>pussa kanawa</strong>).
          </li>
          <li>
            If that next pit is empty, the sowing ends. That is a <strong>saada</strong>.
          </li>
        </ul>

        <h3>Capture</h3>
        <p>
          On a saada, take seeds from the pit after the empty one and from the pit opposite it. If
          you took any seeds, you must sow a second time.
        </p>

        <h3>Pass and end</h3>
        <p>
          Empty row means you pass. When the board is empty of seeds (or a player resigns), higher
          score wins.
        </p>
      </div>
    </div>
  );
}
