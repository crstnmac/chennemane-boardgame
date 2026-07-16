import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { TEXTURE_ANISOTROPY, textureUrl } from './quality';

export type PbrMaps = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap?: THREE.Texture;
};

export type BoardMaterialMaps = {
  wood: PbrMaps;
  bronze: PbrMaps;
  iron: PbrMaps;
  seed: PbrMaps;
  coconutHusk: PbrMaps;
  coconutFlesh: PbrMaps;
};

/**
 * Poly Haven CC0 — see SOURCE.txt under each textures folder.
 * Wood: kitchen_wood (https://polyhaven.com/a/kitchen_wood) — light for red bead contrast
 */
const RAW_PATHS = {
  woodMap: '/textures/wood/wood_diff.jpg',
  woodNormal: '/textures/wood/wood_nor.jpg',
  woodRough: '/textures/wood/wood_rough.jpg',
  bronzeMap: '/textures/bronze/bronze_diff.jpg',
  bronzeNormal: '/textures/bronze/bronze_nor_gl.jpg',
  bronzeRough: '/textures/bronze/bronze_rough.jpg',
  ironMap: '/textures/iron/iron_diff.jpg',
  ironNormal: '/textures/iron/iron_nor_gl.jpg',
  ironRough: '/textures/iron/iron_rough.jpg',
  ironMetal: '/textures/iron/iron_metal.jpg',
  // leather_red_03 — https://polyhaven.com/a/leather_red_03
  seedMap: '/textures/seed/seed_diff.jpg',
  seedNormal: '/textures/seed/seed_nor_gl.jpg',
  seedRough: '/textures/seed/seed_rough.jpg',
  huskMap: '/textures/coconut/husk_diff.jpg',
  huskNormal: '/textures/coconut/husk_nor.jpg',
  huskRough: '/textures/coconut/husk_rough.jpg',
  fleshMap: '/textures/coconut/flesh_diff.jpg',
  fleshNormal: '/textures/coconut/flesh_nor.jpg',
  fleshRough: '/textures/coconut/flesh_rough.jpg',
} as const;

/** Same keys, mobile devices get the 512px variants. */
const PATHS = Object.fromEntries(
  Object.entries(RAW_PATHS).map(([key, url]) => [key, textureUrl(url)]),
) as Record<keyof typeof RAW_PATHS, string>;

const ALL_URLS = Object.values(PATHS);

function configure(
  tex: THREE.Texture,
  opts: {
    colorSpace: THREE.ColorSpace;
    /** UV repeat. Board wood uses [1,1] — GLB TEXCOORD_0 is already 0–1 unwrapped. */
    repeat: [number, number];
    anisotropy?: number;
    /**
     * glTF meshes expect flipY=false. Image textures default to true, which
     * mirrors V and misplaces Poly Haven maps on the board UVs.
     */
    flipY?: boolean;
    rotation?: number;
    center?: [number, number];
    offset?: [number, number];
  },
) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  tex.flipY = opts.flipY ?? false;
  tex.rotation = opts.rotation ?? 0;
  tex.center.set(opts.center?.[0] ?? 0.5, opts.center?.[1] ?? 0.5);
  tex.offset.set(opts.offset?.[0] ?? 0, opts.offset?.[1] ?? 0);
  // Cap anisotropy — each tap costs texture bandwidth on mobile GPUs
  tex.anisotropy = opts.anisotropy ?? TEXTURE_ANISOTROPY;
  tex.colorSpace = opts.colorSpace;
  tex.needsUpdate = true;
}

/**
 * Load all board PBR sets. Must run under <Suspense>.
 * Returns a **stable** object identity after first configure so board/seed
 * meshes do not re-clone materials every React render.
 */
export function useBoardMaterialMaps(): BoardMaterialMaps {
  const t = useTexture(PATHS);

  return useMemo(() => {
    // Always re-apply sampling — glTF UVs need flipY=false.
    // kitchen_wood: cube UVs from Blender (~0.48 m / UV unit) — sample 1:1
    configure(t.woodMap, { colorSpace: THREE.SRGBColorSpace, repeat: [1, 1], flipY: false });
    configure(t.woodNormal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.woodRough, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });

    configure(t.bronzeMap, { colorSpace: THREE.SRGBColorSpace, repeat: [1, 1], flipY: false });
    configure(t.bronzeNormal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.bronzeRough, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });

    configure(t.ironMap, { colorSpace: THREE.SRGBColorSpace, repeat: [1, 1], flipY: false });
    configure(t.ironNormal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.ironRough, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.ironMetal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });

    configure(t.seedMap, { colorSpace: THREE.SRGBColorSpace, repeat: [1, 1], flipY: false });
    configure(t.seedNormal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.seedRough, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });

    configure(t.huskMap, { colorSpace: THREE.SRGBColorSpace, repeat: [1, 1], flipY: false });
    configure(t.huskNormal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.huskRough, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });

    configure(t.fleshMap, { colorSpace: THREE.SRGBColorSpace, repeat: [1, 1], flipY: false });
    configure(t.fleshNormal, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });
    configure(t.fleshRough, { colorSpace: THREE.NoColorSpace, repeat: [1, 1], flipY: false });

    return {
      wood: {
        map: t.woodMap,
        normalMap: t.woodNormal,
        roughnessMap: t.woodRough,
      },
      bronze: {
        map: t.bronzeMap,
        normalMap: t.bronzeNormal,
        roughnessMap: t.bronzeRough,
      },
      iron: {
        map: t.ironMap,
        normalMap: t.ironNormal,
        roughnessMap: t.ironRough,
        metalnessMap: t.ironMetal,
      },
      seed: {
        map: t.seedMap,
        normalMap: t.seedNormal,
        roughnessMap: t.seedRough,
      },
      coconutHusk: {
        map: t.huskMap,
        normalMap: t.huskNormal,
        roughnessMap: t.huskRough,
      },
      coconutFlesh: {
        map: t.fleshMap,
        normalMap: t.fleshNormal,
        roughnessMap: t.fleshRough,
      },
    };
    // useTexture returns a stable bag of Texture refs for the same PATHS
    // eslint-disable-next-line react-hooks/exhaustive-deps -- configure once per texture bag
  }, [
    t.woodMap,
    t.woodNormal,
    t.woodRough,
    t.bronzeMap,
    t.bronzeNormal,
    t.bronzeRough,
    t.ironMap,
    t.ironNormal,
    t.ironRough,
    t.ironMetal,
    t.seedMap,
    t.seedNormal,
    t.seedRough,
    t.huskMap,
    t.huskNormal,
    t.huskRough,
    t.fleshMap,
    t.fleshNormal,
    t.fleshRough,
  ]);
}

export function preloadBoardMaterialMaps() {
  for (const url of ALL_URLS) {
    useTexture.preload(url);
  }
}
