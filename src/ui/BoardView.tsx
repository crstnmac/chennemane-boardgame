import { Component, lazy, Suspense, type ReactNode } from 'react';
import { PremiumBoard } from './board/PremiumBoard';

const BlenderBoard = lazy(() =>
  import('./three/BlenderBoard').then((m) => ({ default: m.BlenderBoard })),
);

class BoardCrashBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error('[BoardView] falling back to 2D board', err);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="board-fallback board-viewport-fill">
          <PremiumBoard />
          <p className="board-fallback-note">Using simplified board (3D unavailable)</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/** High-quality Blender board; falls back to 2D if WebGL crashes. */
export function BoardView() {
  return (
    <BoardCrashBoundary>
      <Suspense
        fallback={
          <div className="shader-board-wrap board-viewport-fill shader-loading">
            <div className="shader-loading-inner">
              <span className="shader-loading-spin" />
              <p>Loading board…</p>
            </div>
          </div>
        }
      >
        <BlenderBoard />
      </Suspense>
    </BoardCrashBoundary>
  );
}
