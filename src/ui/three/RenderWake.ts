import { useLayoutEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';

/**
 * Demand-mode canvases stay black until invalidate() runs after assets mount.
 * Wake the renderer for a short burst so env/shadows/GLB settle, then idle.
 */
export function RenderWake({ frames = 45 }: { frames?: number }) {
  const { invalidate } = useThree();
  const left = useRef(frames);

  useLayoutEffect(() => {
    left.current = frames;
    invalidate();
  }, [invalidate, frames]);

  useFrame((state) => {
    if (left.current <= 0) return;
    left.current -= 1;
    state.invalidate();
  });

  return null;
}
