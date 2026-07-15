import { useEffect, useRef } from 'react';
import { animated, useSpring } from '@react-spring/web';

/** HUD score that springs + floats a delta when the value changes. */
export function AnimatedScore({
  value,
  className = '',
}: {
  value: number;
  className?: string;
}) {
  const prev = useRef(value);

  const [spring, api] = useSpring(() => ({
    scale: 1,
    deltaY: 0,
    deltaOpacity: 0,
    delta: 0,
    display: value,
    config: { tension: 380, friction: 16 },
  }));

  useEffect(() => {
    if (value === prev.current) {
      void api.start({ display: value });
      return;
    }
    const d = value - prev.current;
    prev.current = value;
    void api.start({
      from: { scale: 1, deltaY: 4, deltaOpacity: 1, delta: d, display: value },
      to: [
        { scale: 1.35, deltaY: -2, deltaOpacity: 1, display: value },
        { scale: 1, deltaY: -16, deltaOpacity: 0, display: value },
      ],
    });
  }, [value, api]);

  return (
    <span className={['anim-score', className].filter(Boolean).join(' ')}>
      <animated.span
        className="anim-score-num"
        style={{
          display: 'inline-block',
          transform: spring.scale.to((s) => `scale(${s})`),
          transformOrigin: 'center bottom',
        }}
      >
        {spring.display.to((n) => Math.round(n))}
      </animated.span>
      <animated.span
        className="anim-score-delta"
        aria-hidden
        style={{
          opacity: spring.deltaOpacity,
          transform: spring.deltaY.to((y) => `translateX(-50%) translateY(${y}px)`),
          color: spring.delta.to((d) => (d >= 0 ? '#b8f0a8' : '#f0a890')),
        }}
      >
        {spring.delta.to((d) => {
          const n = Math.round(d);
          if (n === 0) return '';
          return n > 0 ? `+${n}` : `${n}`;
        })}
      </animated.span>
    </span>
  );
}
