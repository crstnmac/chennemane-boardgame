import { Suspense, useMemo } from 'react';
import { Cloud, Clouds, Sky, useGLTF } from '@react-three/drei';
import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import layout from '../../models/villageLayout.json';

type VillageInstance = {
  asset: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
};

const ASSET_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(layout.assets).map(([k, v]) => [k, (v as { file: string }).file]),
);

/** Target display heights (meters) so Poly Haven plants fit the board scale. */
const TARGET_HEIGHT: Record<string, number> = {
  fern: 0.55,
  shrub: 0.95,
  grass_mid: 0.45,
  grass_tall: 0.7,
  grass_small: 0.3,
  othonna: 2.4,
  searsia: 3.2,
};

function PlantInstance({
  url,
  nativeHeight,
  position,
  rotationY,
  scale,
  targetHeight,
}: {
  url: string;
  nativeHeight: number;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  targetHeight: number;
}) {
  const { scene } = useGLTF(url);
  const invalidate = useThree((s) => s.invalidate);
  const root = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        // Alpha-tested leaves (common on Poly Haven plants)
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const std = mat as THREE.MeshStandardMaterial;
          if (std.map) {
            std.map.colorSpace = THREE.SRGBColorSpace;
          }
          if (std.alphaMap || (std.map && std.transparent)) {
            std.transparent = true;
            std.alphaTest = 0.45;
            std.depthWrite = true;
            std.side = THREE.DoubleSide;
          }
        }
      }
    });
    return c;
  }, [scene]);

  useLayoutEffect(() => {
    invalidate();
  }, [root, invalidate]);

  const fit = targetHeight / Math.max(nativeHeight, 0.01);

  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={fit * scale}>
      <primitive object={root} />
    </group>
  );
}

function VillagePlants() {
  const instances = layout.instances as VillageInstance[];
  const assets = layout.assets as Record<
    string,
    { file: string; nativeHeight: number }
  >;

  return (
    <group>
      {instances.map((inst, i) => {
        const meta = assets[inst.asset];
        const url = ASSET_URLS[inst.asset];
        if (!meta || !url) return null;
        const th = TARGET_HEIGHT[inst.asset] ?? 1.2;
        return (
          <PlantInstance
            key={`${inst.asset}-${i}`}
            url={url}
            nativeHeight={meta.nativeHeight || 1}
            position={inst.position}
            rotationY={inst.rotationY}
            scale={inst.scale}
            targetHeight={th}
          />
        );
      })}
    </group>
  );
}

function VillageClouds() {
  return (
    <Clouds material={THREE.MeshLambertMaterial} limit={40} range={48}>
      <Cloud
        seed={2}
        segments={16}
        bounds={[14, 3, 10]}
        position={[-8, 10, -12]}
        volume={9}
        opacity={0.52}
        color="#f7f4ec"
        fade={20}
      />
      <Cloud
        seed={7}
        segments={14}
        bounds={[12, 2.8, 11]}
        position={[10, 11, -8]}
        volume={8}
        opacity={0.48}
        color="#fffaf2"
        fade={22}
      />
      <Cloud
        seed={11}
        segments={14}
        bounds={[16, 3.2, 10]}
        position={[1, 12, 10]}
        volume={10}
        opacity={0.42}
        color="#f2f0e8"
        fade={24}
      />
      <Cloud
        seed={19}
        segments={12}
        bounds={[10, 2.4, 8]}
        position={[-12, 9, 5]}
        volume={7}
        opacity={0.45}
        color="#faf6ee"
        fade={18}
      />
    </Clouds>
  );
}

/**
 * Outdoor village backdrop (sky / plants).
 * Not used in play mode — the game now uses HomeVeranda (indoor home setting).
 * Kept for optional outdoor experiments.
 */
export function VillageBackdrop() {
  return (
    <group>
      <Sky
        distance={450}
        sunPosition={[40, 18, 20]}
        inclination={0.48}
        azimuth={0.22}
        mieCoefficient={0.006}
        mieDirectionalG={0.85}
        rayleigh={1.8}
        turbidity={4.5}
      />
      <VillageClouds />
      <Suspense fallback={null}>
        <VillagePlants />
      </Suspense>
    </group>
  );
}

// Preload plant GLBs
for (const url of Object.values(ASSET_URLS)) {
  useGLTF.preload(url);
}
