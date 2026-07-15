import { useEffect, useRef } from 'react';
import { Html } from '@react-three/drei';
import { animated, useSpring } from '@react-spring/web';

export type PitCountTone = 'default' | 'legal' | 'hot' | 'ai' | 'mute' | 'accent' | 'gold';

const TONE_COLOR: Record<PitCountTone, string> = {
  default: '#f3ebe0',
  legal: '#e8d4a8',
  hot: '#f0d9a0',
  ai: '#c8bfd8',
  mute: '#a89888',
  accent: '#c8b0e0',
  gold: '#f0d9a0',
};

/**
 * 3D-space pit counter — react-spring pop + floating delta on change.
 */
export function AnimatedPitCount({
  count,
  pitId,
  tone = 'default',
  dim = false,
  caption,
  position = [0, 0.02, 0] as [number, number, number],
  distanceFactor = 1.15,
}: {
  count: number;
  pitId?: string;
  tone?: PitCountTone;
  dim?: boolean;
  caption?: string;
  position?: [number, number, number];
  distanceFactor?: number;
}) {
  const prev = useRef(count);
  const color = TONE_COLOR[tone];
  const empty = count === 0 && !caption;
  const row = pitId?.[0];

  const [spring, api] = useSpring(() => ({
    scale: 1,
    deltaY: 0,
    deltaOpacity: 0,
    delta: 0,
    config: { tension: 420, friction: 16 },
  }));

  useEffect(() => {
    if (count === prev.current) return;
    const d = count - prev.current;
    prev.current = count;
    void api.start({
      from: { scale: 1, deltaY: 6, deltaOpacity: 1, delta: d },
      to: [
        { scale: 1.42, deltaY: -2, deltaOpacity: 1 },
        { scale: 1, deltaY: -18, deltaOpacity: 0 },
      ],
      config: { tension: 380, friction: 14 },
    });
  }, [count, api]);

  return (
    <Html
      position={position}
      center
      distanceFactor={distanceFactor}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
      zIndexRange={[20, 0]}
    >
      <div
        className={[
          'pit-count',
          dim ? 'is-dim' : '',
          empty ? 'is-empty' : '',
          row === 'A' ? 'is-row-a' : '',
          row === 'B' ? 'is-row-b' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ color }}
      >
        {pitId && (
          <span className="pit-count-id" aria-hidden>
            <span className="pit-count-row">{pitId[0]}</span>
            <span className="pit-count-col">{pitId.slice(1)}</span>
          </span>
        )}
        {caption && <span className="pit-count-caption">{caption}</span>}
        <animated.span
          className="pit-count-num"
          aria-label={pitId ? `${pitId}, ${count} seeds` : `${count} seeds`}
          style={{
            display: 'block',
            transform: spring.scale.to((s) => `scale(${s})`),
            transformOrigin: 'center bottom',
          }}
        >
          {count}
        </animated.span>
        <animated.span
          className="pit-count-delta"
          aria-hidden
          style={{
            opacity: spring.deltaOpacity,
            transform: spring.deltaY.to((y) => `translateX(-50%) translateY(${y}px)`),
            color: spring.delta.to((d) => (d >= 0 ? '#b8f0a8' : '#f0a890')),
            pointerEvents: 'none',
          }}
        >
          {spring.delta.to((d) => {
            const n = Math.round(d);
            if (n === 0) return '';
            return n > 0 ? `+${n}` : `${n}`;
          })}
        </animated.span>
      </div>
    </Html>
  );
}

/** Floating A-row / B-row legend beside the board. */
export function RowInitialMarker({
  row,
  position,
  subtitle,
}: {
  row: 'A' | 'B';
  position: [number, number, number];
  subtitle: string;
}) {
  const spring = useSpring({
    from: { opacity: 0, y: 8 },
    to: { opacity: 1, y: 0 },
    config: { tension: 180, friction: 20 },
  });

  return (
    <Html
      position={position}
      center
      distanceFactor={1.35}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
      zIndexRange={[15, 0]}
    >
      <animated.div
        className={`row-initial row-initial-${row.toLowerCase()}`}
        style={{
          opacity: spring.opacity,
          transform: spring.y.to((y) => `translateY(${y}px)`),
        }}
      >
        <span className="row-initial-letter">{row}</span>
        <span className="row-initial-sub">{subtitle}</span>
      </animated.div>
    </Html>
  );
}
