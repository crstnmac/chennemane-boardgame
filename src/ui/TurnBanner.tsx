import { needsSecondSowing } from '../engine';
import { useGameStore, type TurnPhase } from '../session/store';

function phaseClass(phase: TurnPhase, second: boolean): string {
  if (second && (phase === 'your-turn' || phase === 'hotseat-turn')) {
    return 'turn-banner turn-second';
  }
  switch (phase) {
    case 'your-turn':
      return 'turn-banner turn-you';
    case 'ai-thinking':
    case 'ai-preview':
    case 'ai-playing':
      return 'turn-banner turn-ai';
    case 'pass':
      return 'turn-banner turn-pass';
    case 'over':
      return 'turn-banner turn-over';
    default:
      return 'turn-banner turn-hotseat';
  }
}

function phaseTitle(phase: TurnPhase, statusMessage: string): string {
  switch (phase) {
    case 'ai-thinking':
      return 'AI thinking';
    case 'ai-preview':
      return 'AI move';
    case 'ai-playing':
      return statusMessage || 'AI sowing';
    case 'your-turn':
      return statusMessage || 'Your turn';
    case 'pass':
      return statusMessage || 'Pass';
    case 'over':
      return statusMessage || 'Game over';
    default:
      return statusMessage;
  }
}

export function TurnBanner() {
  const turnPhase = useGameStore((s) => s.turnPhase);
  const statusMessage = useGameStore((s) => s.statusMessage);
  const statusDetail = useGameStore((s) => s.statusDetail);
  const thinking = useGameStore((s) => s.thinking);
  const mode = useGameStore((s) => s.mode);
  const committed = useGameStore((s) => s.committed);
  const humanPlayer = useGameStore((s) => s.humanPlayer);

  if (!committed) return null;

  const second = needsSecondSowing(committed);
  const aiSide = mode === 'ai' ? (humanPlayer === 'S' ? 'North' : 'South') : null;
  const youSide = mode === 'ai' ? (humanPlayer === 'S' ? 'South' : 'North') : null;

  return (
    <div className={phaseClass(turnPhase, second)} role="status" aria-live="polite">
      <div className="turn-banner-inner">
        {(turnPhase === 'ai-thinking' || thinking) && (
          <span className="turn-spinner" aria-hidden />
        )}
        <div className="turn-text">
          {second && (turnPhase === 'your-turn' || turnPhase === 'hotseat-turn') && (
            <div className="turn-second-chip">Must sow again</div>
          )}
          <div className="turn-title">{phaseTitle(turnPhase, statusMessage)}</div>
          {statusDetail && <div className="turn-detail">{statusDetail}</div>}
          {mode === 'ai' && (
            <div className="turn-sides">
              <span className={turnPhase === 'your-turn' ? 'side-chip active-you' : 'side-chip'}>
                You · {youSide}
              </span>
              <span
                className={
                  turnPhase.startsWith('ai') ? 'side-chip active-ai' : 'side-chip'
                }
              >
                AI · {aiSide}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
