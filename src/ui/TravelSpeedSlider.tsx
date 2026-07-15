import {
  clampTravelSpeed,
  TRAVEL_SPEED_MAX,
  TRAVEL_SPEED_MIN,
  travelSpeedLabel,
} from '../session/animationPace';

export function TravelSpeedSlider({
  value,
  onChange,
  id = 'travel-speed',
  compact = false,
  className = '',
}: {
  value: number;
  onChange: (n: number) => void;
  id?: string;
  /** Smaller chrome for in-game / tour HUD */
  compact?: boolean;
  className?: string;
}) {
  const level = clampTravelSpeed(value);
  const label = travelSpeedLabel(level);

  return (
    <div className={`travel-speed ${compact ? 'is-compact' : ''} ${className}`.trim()}>
      <div className="travel-speed-head">
        <label htmlFor={id}>{compact ? 'Speed' : 'Bead travel speed'}</label>
        <span className="travel-speed-value" aria-live="polite">
          {label}
          {!compact && <span className="travel-speed-num"> · {level}</span>}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={TRAVEL_SPEED_MIN}
        max={TRAVEL_SPEED_MAX}
        step={1}
        value={level}
        onChange={(e) => onChange(clampTravelSpeed(Number(e.target.value)))}
        aria-valuemin={TRAVEL_SPEED_MIN}
        aria-valuemax={TRAVEL_SPEED_MAX}
        aria-valuenow={level}
        aria-valuetext={`${label}, ${level} of ${TRAVEL_SPEED_MAX}`}
      />
      {!compact && (
        <div className="travel-speed-ends" aria-hidden>
          <span>Slow</span>
          <span>Fast</span>
        </div>
      )}
    </div>
  );
}
