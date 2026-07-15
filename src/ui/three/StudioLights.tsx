import { Suspense, useLayoutEffect } from 'react';
import { Environment, useEnvironment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';

export type LightQuality = 'hero' | 'play';

/**
 * Indoor IBL — Poly Haven wooden_lounge (CC0).
 * Play mode adds static board-readable fill; home relies more on lamp flicker.
 * @see public/hdr/SOURCE.txt
 */
export const PLAY_ENV_HDR = '/hdr/wooden_lounge_1k.hdr';

export const OUTDOOR_ENV_HDR = '/hdr/kloofendal_48d_partly_cloudy_puresky_1k.hdr';

/** Demand-mode: redraw after HDR loads. */
function EnvLoadWake({ files }: { files: string }) {
  const invalidate = useThree((s) => s.invalidate);
  const tex = useEnvironment({ files });
  useLayoutEffect(() => {
    invalidate();
    const a = requestAnimationFrame(() => invalidate());
    const b = window.setTimeout(() => invalidate(), 80);
    return () => {
      cancelAnimationFrame(a);
      window.clearTimeout(b);
    };
  }, [tex, invalidate]);
  return null;
}

/**
 * Indoor lighting.
 * - hero: lamp-heavy (home dynamic lamps)
 * - play: static board key/fill so pits stay readable (no flicker)
 */
export function StudioLights({
  quality = 'play',
  envIntensity,
}: {
  quality?: LightQuality;
  envIntensity?: number;
  showBackground?: boolean;
}) {
  const play = quality === 'play';
  // Low env on wood surfaces — high IBL makes light timber flash
  const envI = envIntensity ?? (play ? 0.14 : 0.1);

  return (
    <>
      {play ? (
        <>
          {/* Soft diffuse base — prefer ambient over harsh point hotspots */}
          <ambientLight intensity={0.42} color="#4a3828" />
          <hemisphereLight args={['#6a5848', '#1a120c', 0.38]} />
          {/* Softer, farther key — less specular punch on kitchen_wood */}
          <pointLight
            color="#f0d0a0"
            intensity={1.85}
            distance={7}
            decay={2}
            position={[0.2, 1.55, 1.35]}
          />
          <pointLight
            color="#e0b888"
            intensity={1.1}
            distance={6.5}
            decay={2}
            position={[-1.0, 1.35, 0.45]}
          />
          <pointLight
            color="#e8c090"
            intensity={0.75}
            distance={6}
            decay={2}
            position={[0.85, 1.2, -0.35]}
          />
        </>
      ) : (
        // Home: tiny base only — living lamps do the work
        <ambientLight intensity={0.08} color="#2a1c10" />
      )}

      <Suspense fallback={null}>
        <EnvLoadWake files={PLAY_ENV_HDR} />
        <Environment
          files={PLAY_ENV_HDR}
          background={false}
          environmentIntensity={Math.min(Math.max(envI, 0.06), 0.22)}
          environmentRotation={[0, Math.PI * 0.35, 0]}
        />
      </Suspense>
    </>
  );
}

export function preloadPlayEnvironment() {
  try {
    useEnvironment.preload({ files: PLAY_ENV_HDR });
  } catch {
    void fetch(PLAY_ENV_HDR, { method: 'GET', cache: 'force-cache' }).catch(() => {
      /* offline */
    });
  }
}
