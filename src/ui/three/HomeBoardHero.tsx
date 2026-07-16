import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { BOARD_URL, SEED_URL } from './assetUrls';
import { useBoardMaterialMaps } from './boardMaterialMaps';
import { BOARD_META, PITS, pitPosition, seedOffsets } from './layout';
import { RenderWake } from './RenderWake';
import {
  extractSeedGeometry,
  getSharedSeedMaterial,
  getStudioBoardRoot,
  preloadBoardAssets,
} from './sharedAssets';
import { GroundContactShadow } from './GroundContactShadow';
import { HomeVeranda } from './HomeVeranda';
import { CONTACT_SHADOW_RESOLUTION, HERO_DPR, IS_MOBILE } from './quality';
import { StudioLights } from './StudioLights';

const HERO_PITS = Array.from({ length: 14 }, () => 5);
const MAX_SEEDS = 80;

const ISO_POS: [number, number, number] = [1.15, 1.25, 1.15];
const ISO_TARGET: [number, number, number] = [0, 0.03, 0.0];

function BoardMesh() {
  const { scene } = useGLTF(BOARD_URL);
  const maps = useBoardMaterialMaps();
  const root = useMemo(() => getStudioBoardRoot(scene, maps), [scene, maps]);
  return <primitive object={root} />;
}

function SeedInstances() {
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const positions = useMemo(() => {
    const list: [number, number, number][] = [];
    for (let i = 0; i < 14; i++) {
      const count = HERO_PITS[i] ?? 0;
      const [px, py, pz] = pitPosition(i);
      const r = PITS[i]?.radius ?? BOARD_META.pitRadius;
      for (const o of seedOffsets(count, r)) {
        list.push([px + o[0], py + o[1], pz + o[2]]);
        if (list.length >= MAX_SEEDS) return list;
      }
    }
    return list;
  }, []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const n = positions.length;
    for (let i = 0; i < n; i++) {
      const p = positions[i]!;
      dummy.position.set(p[0], p[1], p[2]);
      dummy.scale.setScalar(1);
      dummy.rotation.set(0, (i * 0.7) % Math.PI, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }, [positions, dummy]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_SEEDS]}
      castShadow
      receiveShadow={false}
      frustumCulled={false}
    />
  );
}

/** Signals parent when GLTF/textures are loaded and a frame has painted. */
function ReadySignal({ onReady }: { onReady: () => void }) {
  const { active, progress } = useProgress();
  const { invalidate } = useThree();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (active || progress < 100) return;
    // Let demand frames settle shadows/materials before fade-in
    invalidate();
    const t = window.setTimeout(() => {
      if (fired.current) return;
      fired.current = true;
      invalidate();
      onReady();
    }, 120);
    return () => clearTimeout(t);
  }, [active, progress, invalidate, onReady]);

  return null;
}

function HeroScene({ onReady }: { onReady: () => void }) {
  return (
    <>
      <RenderWake frames={60} />
      <ReadySignal onReady={onReady} />
      <color attach="background" args={['#1a120c']} />
      <fog attach="fog" args={['#1a120c', 4, 12]} />
      <StudioLights quality="hero" envIntensity={0.12} />
      <Suspense fallback={null}>
        {/* Continuous lamp flicker on desktop; static lamps on mobile (battery) */}
        <HomeVeranda floorSize={6.5} dynamicLights={!IS_MOBILE} />
      </Suspense>
      <group>
        <BoardMesh />
        <SeedInstances />
      </group>
      <GroundContactShadow
        position={[0, 0.002, 0]}
        opacity={0.48}
        scale={3.2}
        blur={2.6}
        far={1.2}
        color="#1a1008"
        resolution={CONTACT_SHADOW_RESOLUTION}
        frames={40}
      />
    </>
  );
}

/** Home logo: Blender board + living oil-lamp light (always-render for smooth flicker). */
export function HomeBoardHero() {
  const [ready, setReady] = useState(false);

  return (
    <div className={`home-hero-3d ${ready ? 'is-ready' : ''}`} aria-hidden>
      <div className="home-hero-fallback" />
      <Suspense fallback={null}>
        <Canvas
          shadows={false}
          dpr={HERO_DPR}
          // Desktop: always-on so lamp flicker stays smooth on home.
          // Mobile: lamps are static, so stay demand-driven and idle at 0 fps.
          frameloop={ready && !IS_MOBILE ? 'always' : 'demand'}
          gl={{
            antialias: true,
            alpha: false,
            powerPreference: 'default',
            failIfMajorPerformanceCaveat: false,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 0.95,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
          camera={{
            position: ISO_POS,
            fov: 32,
            near: 0.05,
            far: 24,
          }}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            position: 'absolute',
            inset: 0,
          }}
          onCreated={({ camera, gl, invalidate }) => {
            camera.lookAt(...ISO_TARGET);
            gl.setClearColor(0x1a120c, 1);
            gl.shadowMap.enabled = false;
            gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
            invalidate();
          }}
        >
          <HeroScene onReady={() => setReady(true)} />
        </Canvas>
      </Suspense>
    </div>
  );
}

// Warm cache as soon as this module loads (also called from main)
preloadBoardAssets();
