import { useLayoutEffect, useMemo, useRef } from 'react';
import { Html, useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { animated, useSpring } from '@react-spring/three';
import * as THREE from 'three';
import type { PlayerId } from '../../engine';
import { COCONUT_SHELL_URL, SEED_URL } from './assetUrls';
import { useBoardMaterialMaps } from './boardMaterialMaps';
import {
  extractSeedGeometry,
  getSharedSeedMaterial,
  getStudioShellRoot,
} from './sharedAssets';
import {
  MAX_SHELL_SEEDS_DRAWN,
  shellSeedOffsets,
  storeWorldPosition,
  storeYaw,
  STORES,
  type StoreSide,
} from './storeLayout';

const MAX_SHELL_SEEDS = MAX_SHELL_SEEDS_DRAWN;

function ShellMesh({ side }: { side: StoreSide }) {
  const { scene } = useGLTF(COCONUT_SHELL_URL);
  const maps = useBoardMaterialMaps();
  // Fresh clone per side so both shells can mount together
  const root = useMemo(() => getStudioShellRoot(scene, maps), [scene, maps, side]);
  const [wx, wy, wz] = storeWorldPosition(side);
  const yaw = storeYaw(side);
  const tilt = side === 'S' ? -0.15 : 0.15;

  return (
    <group position={[wx, wy, wz]} rotation={[tilt, yaw, 0]}>
      <primitive object={root} />
    </group>
  );
}

function ShellSeeds({ side, count }: { side: StoreSide; count: number }) {
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const { invalidate } = useThree();
  const meta = STORES[side];
  const [wx, wy, wz] = storeWorldPosition(side);
  const yaw = storeYaw(side);
  const tilt = side === 'S' ? -0.15 : 0.15;

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const nShow = Math.min(count, MAX_SHELL_SEEDS_DRAWN);
    const offsets = shellSeedOffsets(nShow, meta.seedPackRadius, meta.seedRestZ);

    const parent = new THREE.Object3D();
    parent.position.set(wx, wy, wz);
    parent.rotation.set(tilt, yaw, 0);
    parent.updateMatrixWorld(true);

    let n = 0;
    for (const o of offsets) {
      dummy.position.set(o[0], o[1], o[2]);
      dummy.rotation.set(0, (n * 0.9) % Math.PI, n * 0.15);
      dummy.scale.setScalar(0.95);
      dummy.updateMatrix();
      const m = dummy.matrix.clone();
      m.premultiply(parent.matrixWorld);
      mesh.setMatrixAt(n, m);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [count, meta, wx, wy, wz, yaw, tilt, dummy, invalidate]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_SHELL_SEEDS]}
      castShadow
      receiveShadow={false}
      frustumCulled={false}
    />
  );
}

function ShellLabel({
  side,
  score,
  title,
}: {
  side: StoreSide;
  score: number;
  title: string;
}) {
  const [wx, wy, wz] = storeWorldPosition(side);
  // Park the label beside the bowl (not in the opening) so the husk rim
  // stays readable — especially on small mobile viewports where a centered
  // Html badge used to cover the shell and read as a flat dark disc.
  const sideNudge = side === 'S' ? 0.075 : -0.075;
  return (
    <Html
      position={[wx + sideNudge, wy + 0.11, wz]}
      center
      distanceFactor={1.5}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
      zIndexRange={[12, 0]}
    >
      <div className="shell-label">
        <span className="shell-label-title">{title}</span>
        <span className="shell-label-score">{score}</span>
      </div>
    </Html>
  );
}

/**
 * Two PBR coconut score bowls + stacked capture beads for South/North.
 */
export function CoconutStores({
  scoreS,
  scoreN,
  southTitle = 'B · captures',
  northTitle = 'A · captures',
  pulseSide = null,
}: {
  scoreS: number;
  scoreN: number;
  southTitle?: string;
  northTitle?: string;
  pulseSide?: PlayerId | null;
}) {
  const pulseS = useSpring({
    scale: pulseSide === 'S' ? 1.05 : 1,
    config: { tension: 280, friction: 16 },
  });
  const pulseN = useSpring({
    scale: pulseSide === 'N' ? 1.05 : 1,
    config: { tension: 280, friction: 16 },
  });

  return (
    <group>
      <animated.group scale={pulseS.scale}>
        <ShellMesh side="S" />
        <ShellSeeds side="S" count={scoreS} />
        <ShellLabel side="S" score={scoreS} title={southTitle} />
      </animated.group>
      <animated.group scale={pulseN.scale}>
        <ShellMesh side="N" />
        <ShellSeeds side="N" count={scoreN} />
        <ShellLabel side="N" score={scoreN} title={northTitle} />
      </animated.group>
    </group>
  );
}

/** World-space landing point for capture bead flight. */
export function storeCaptureWorldPos(side: StoreSide): THREE.Vector3 {
  const [x, y, z] = storeWorldPosition(side);
  const rest = STORES[side].seedRestZ + 0.025;
  return new THREE.Vector3(x, y + rest, z);
}
