import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTexture } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

type Maps = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
};

function usePbrMaps(urls: [string, string, string], invalidate: () => void): Maps {
  const [map, normalMap, roughnessMap] = useTexture(urls, (loaded) => {
    for (const t of Array.isArray(loaded) ? loaded : [loaded]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
    invalidate();
  });

  useLayoutEffect(() => {
    map.colorSpace = THREE.SRGBColorSpace;
    for (const t of [map, normalMap, roughnessMap]) {
      t.needsUpdate = true;
    }
    invalidate();
  }, [map, normalMap, roughnessMap, invalidate]);

  return { map, normalMap, roughnessMap };
}

/** Clone maps so each material can have its own UV repeat without fighting. */
function cloneMaps(src: Maps, tilesU: number, tilesV: number): Maps {
  const map = src.map.clone();
  const normalMap = src.normalMap.clone();
  const roughnessMap = src.roughnessMap.clone();
  for (const t of [map, normalMap, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(tilesU, tilesV);
    t.needsUpdate = true;
  }
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, normalMap, roughnessMap };
}

function useStdMat(
  src: Maps,
  opts: {
    tilesU: number;
    tilesV: number;
    color: string;
    roughness?: number;
    metalness?: number;
    env?: number;
    normalScale?: number;
    side?: THREE.Side;
  },
) {
  return useMemo(() => {
    const m = cloneMaps(src, opts.tilesU, opts.tilesV);
    const mat = new THREE.MeshStandardMaterial({
      map: m.map,
      normalMap: m.normalMap,
      roughnessMap: m.roughnessMap,
      color: new THREE.Color(opts.color),
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0,
      envMapIntensity: opts.env ?? 0.3,
      normalScale: new THREE.Vector2(opts.normalScale ?? 0.5, opts.normalScale ?? 0.5),
      side: opts.side ?? THREE.FrontSide,
    });
    // stash clones for dispose
    (mat as THREE.MeshStandardMaterial & { __clones?: THREE.Texture[] }).__clones = [
      m.map,
      m.normalMap,
      m.roughnessMap,
    ];
    return mat;
  }, [src.map, src.normalMap, src.roughnessMap, opts.tilesU, opts.tilesV, opts.color]);
}

function disposeMat(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial & { __clones?: THREE.Texture[] };
  m.__clones?.forEach((t) => t.dispose());
  mat.dispose();
}

/**
 * Shared room pulse + per-lamp phase so all home lamps feel like one coherent fire
 * (same draft in the room) while each wick still has its own personality.
 */
function lampFlicker(t: number, phase: number): { flick: number; room: number } {
  // Room-wide slow pulse — shared across lamps for consistency
  const room =
    0.92 +
    Math.sin(t * 1.15) * 0.06 +
    Math.sin(t * 0.37) * 0.04;
  // Local wick: mid flutter + crackle + rare gutter, phase-offset per lamp
  const mid =
    Math.sin(t * 5.8 + phase) * 0.35 + Math.sin(t * 9.1 + phase * 1.4) * 0.25;
  const crackle = Math.sin(t * 16.5 + phase * 2.1) * 0.1 + Math.sin(t * 27 + phase) * 0.05;
  const gutter = Math.pow(Math.max(0, Math.sin(t * 0.33 + phase * 1.7)), 16) * 0.22;
  const local = 0.88 + mid * 0.12 + crackle * 0.08 - gutter;
  const flick = THREE.MathUtils.clamp(room * local, 0.55, 1.14);
  return { flick, room };
}

const LAMP_COLOR_DIM = new THREE.Color('#ff6a14');
const LAMP_COLOR_MID = new THREE.Color('#ff9a38');
const LAMP_COLOR_HOT = new THREE.Color('#ffd090');
const _lampColor = new THREE.Color();
const _fillColor = new THREE.Color();

/** Shared brass/oil — one set for all lamps (static). */
let sharedBrass: THREE.MeshStandardMaterial | null = null;
let sharedOil: THREE.MeshStandardMaterial | null = null;
function getLampVesselMats() {
  if (!sharedBrass) {
    sharedBrass = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#c4922e'),
      roughness: 0.35,
      metalness: 0.85,
      envMapIntensity: 0.22,
    });
  }
  if (!sharedOil) {
    sharedOil = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#2a1c0c'),
      roughness: 0.5,
      metalness: 0.05,
      envMapIntensity: 0.1,
    });
  }
  return { brass: sharedBrass, oil: sharedOil };
}

/** Stable phase per lamp index so reloads look the same. */
const LAMP_PHASES = [0.4, 1.9, 3.3, 5.1];

/**
 * Coconut-oil lamp — scene lights.
 * `dynamic` (home): continuous multi-layer flicker. Game: static single light.
 */
function OilLamp({
  position,
  intensity = 1.8,
  distance = 6.5,
  dynamic = false,
  lampIndex = 0,
}: {
  position: [number, number, number];
  intensity?: number;
  distance?: number;
  /** Home page: animated. Game page: static. */
  dynamic?: boolean;
  lampIndex?: number;
}) {
  const flameRef = useRef<THREE.Mesh>(null);
  const coreFlameRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const mainRef = useRef<THREE.PointLight>(null);
  const fillRef = useRef<THREE.PointLight>(null);
  const phase = LAMP_PHASES[lampIndex % LAMP_PHASES.length]!;
  const baseI = intensity;
  const { brass, oil } = getLampVesselMats();

  const outerFlame = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ff8a30'),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const innerFlame = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#fff0c0'),
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const glow = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ffb050'),
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useLayoutEffect(
    () => () => {
      outerFlame.dispose();
      innerFlame.dispose();
      glow.dispose();
    },
    [outerFlame, innerFlame, glow],
  );

  useFrame(({ clock }) => {
    if (!dynamic) return;
    const t = clock.elapsedTime;
    const { flick } = lampFlicker(t, phase);

    // Color temp: dim orange ↔ hot yellow (smooth, shared palette)
    const temp = THREE.MathUtils.smoothstep(flick, 0.55, 1.08);
    if (temp < 0.5) {
      _lampColor.lerpColors(LAMP_COLOR_DIM, LAMP_COLOR_MID, temp * 2);
    } else {
      _lampColor.lerpColors(LAMP_COLOR_MID, LAMP_COLOR_HOT, (temp - 0.5) * 2);
    }
    _fillColor.copy(_lampColor).multiplyScalar(0.9);

    // Draft sway — same room wind frequency, phase per lamp
    const swayX =
      Math.sin(t * 3.6 + phase) * 0.011 + Math.sin(t * 9.8 + phase * 1.6) * 0.005;
    const swayZ =
      Math.cos(t * 3.1 + phase * 1.2) * 0.01 + Math.sin(t * 11.2 + phase) * 0.004;
    const leanX = swayZ * 6;
    const leanZ = -swayX * 6;

    if (flameRef.current) {
      const h = 0.74 + flick * 0.4;
      const w = 0.86 + (1.06 - flick) * 0.22;
      flameRef.current.scale.set(w, h, w);
      flameRef.current.position.set(swayX, 0.078 + (h - 1) * 0.018, swayZ);
      flameRef.current.rotation.set(leanX * 0.3, 0, leanZ * 0.3);
      outerFlame.opacity = 0.72 + flick * 0.24;
      outerFlame.color.copy(_lampColor);
    }
    if (coreFlameRef.current) {
      const h = 0.68 + flick * 0.42;
      coreFlameRef.current.scale.set(0.72 + (1.05 - flick) * 0.12, h, 0.72);
      coreFlameRef.current.position.set(swayX * 0.55, 0.07 + (h - 1) * 0.012, swayZ * 0.55);
      coreFlameRef.current.rotation.set(leanX * 0.2, 0, leanZ * 0.2);
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(0.88 + flick * 0.42);
      glowRef.current.position.set(swayX * 0.35, 0.1 + flick * 0.015, swayZ * 0.35);
      glow.opacity = 0.12 + flick * 0.2;
      glow.color.copy(_lampColor);
    }

    const tipY = 0.14 + flick * 0.03;
    if (mainRef.current) {
      mainRef.current.intensity = baseI * flick;
      mainRef.current.color.copy(_lampColor);
      mainRef.current.position.set(swayX * 0.6, tipY, swayZ * 0.6);
    }
    if (fillRef.current) {
      // Soft secondary: lags slightly so the room “breathes”
      const soft = 0.62 + flick * 0.45;
      fillRef.current.intensity = baseI * 0.38 * soft;
      fillRef.current.color.copy(_fillColor);
      fillRef.current.position.set(swayX * 0.25, 0.48 + flick * 0.06, swayZ * 0.25);
    }
  });

  return (
    <group position={position}>
      <mesh position={[0, 0.012, 0]} material={brass}>
        <cylinderGeometry args={[0.07, 0.086, 0.018, 12]} />
      </mesh>
      <mesh position={[0, 0.036, 0]} material={brass}>
        <sphereGeometry args={[0.055, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
      </mesh>
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} material={oil}>
        <circleGeometry args={[0.042, 12]} />
      </mesh>
      <mesh position={[0, 0.062, 0]} material={oil}>
        <cylinderGeometry args={[0.0035, 0.005, 0.02, 6]} />
      </mesh>

      <mesh ref={flameRef} position={[0, 0.078, 0]} material={outerFlame}>
        <coneGeometry args={[0.021, 0.07, 8]} />
      </mesh>
      <mesh ref={coreFlameRef} position={[0, 0.07, 0]} material={innerFlame}>
        <coneGeometry args={[0.01, 0.042, 6]} />
      </mesh>
      <mesh ref={glowRef} position={[0, 0.1, 0]} material={glow}>
        <sphereGeometry args={[0.08, 10, 8]} />
      </mesh>

      <pointLight
        ref={mainRef}
        color="#ff9a38"
        intensity={baseI}
        distance={distance}
        decay={2}
        position={[0, 0.16, 0]}
      />
      {/* Home dynamic only — soft fill for depth (still cheap: no shadows) */}
      {dynamic ? (
        <pointLight
          ref={fillRef}
          color="#e88840"
          intensity={baseI * 0.38}
          distance={distance * 0.85}
          decay={2}
          position={[0, 0.5, 0]}
        />
      ) : null}
    </group>
  );
}

/** Thick wall slab with clean scale (local X = width, Y = height, Z = thickness). */
function WallSlab({
  width,
  height,
  thickness = 0.16,
  position,
  rotationY = 0,
  material,
  castShadow = true,
}: {
  width: number;
  height: number;
  thickness?: number;
  position: [number, number, number];
  rotationY?: number;
  material: THREE.Material;
  castShadow?: boolean;
}) {
  return (
    <mesh
      position={position}
      rotation={[0, rotationY, 0]}
      castShadow={castShadow}
      receiveShadow
      material={material}
    >
      <boxGeometry args={[width, height, thickness]} />
    </mesh>
  );
}

/** Multi-panel wooden door leaf (stiles, rails, raised panels). */
function DoorLeaf({
  width,
  height,
  woodMat,
  panelMat,
  ajar = -0.5,
}: {
  width: number;
  height: number;
  woodMat: THREE.Material;
  panelMat: THREE.Material;
  ajar?: number;
}) {
  const t = 0.042; // leaf thickness
  const stile = 0.09;
  const rail = 0.1;
  const midRail = 0.08;
  const panelInset = 0.012;
  const panelT = 0.018;

  // Panel layout: upper + lower
  const innerW = width - stile * 2;
  const upperH = height * 0.42;
  const lowerH = height * 0.36;
  const gap = height - rail * 2 - midRail - upperH - lowerH;
  const upperY = rail + lowerH + midRail + gap / 2 + upperH / 2;
  const lowerY = rail + lowerH / 2;

  return (
    // Hinge on local -X edge; rotate ajar around hinge
    <group position={[-width / 2, 0, 0]} rotation={[0, ajar, 0]}>
      <group position={[width / 2, height / 2, 0]}>
        {/* Core slab */}
        <mesh castShadow receiveShadow material={woodMat} position={[0, 0, 0]}>
          <boxGeometry args={[width, height, t * 0.7]} />
        </mesh>
        {/* Stiles */}
        <mesh castShadow material={woodMat} position={[-width / 2 + stile / 2, 0, t * 0.15]}>
          <boxGeometry args={[stile, height, t]} />
        </mesh>
        <mesh castShadow material={woodMat} position={[width / 2 - stile / 2, 0, t * 0.15]}>
          <boxGeometry args={[stile, height, t]} />
        </mesh>
        {/* Rails */}
        <mesh
          castShadow
          material={woodMat}
          position={[0, -height / 2 + rail / 2, t * 0.15]}
        >
          <boxGeometry args={[innerW, rail, t]} />
        </mesh>
        <mesh castShadow material={woodMat} position={[0, height / 2 - rail / 2, t * 0.15]}>
          <boxGeometry args={[innerW, rail, t]} />
        </mesh>
        <mesh
          castShadow
          material={woodMat}
          position={[0, -height / 2 + rail + lowerH + midRail / 2, t * 0.15]}
        >
          <boxGeometry args={[innerW, midRail, t]} />
        </mesh>
        {/* Raised panels */}
        <mesh
          castShadow
          material={panelMat}
          position={[0, -height / 2 + upperY, t * 0.35]}
        >
          <boxGeometry args={[innerW - panelInset * 2, upperH - panelInset, panelT]} />
        </mesh>
        <mesh
          castShadow
          material={panelMat}
          position={[0, -height / 2 + lowerY, t * 0.35]}
        >
          <boxGeometry args={[innerW - panelInset * 2, lowerH - panelInset, panelT]} />
        </mesh>
        {/* Handle */}
        <mesh
          castShadow
          position={[width / 2 - stile * 0.55, 0, t * 0.55]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <cylinderGeometry args={[0.012, 0.012, 0.1, 10]} />
          <meshStandardMaterial color="#8a7040" metalness={0.65} roughness={0.35} />
        </mesh>
        <mesh position={[width / 2 - stile * 0.55, 0, t * 0.72]}>
          <sphereGeometry args={[0.018, 10, 10]} />
          <meshStandardMaterial color="#c9a050" metalness={0.8} roughness={0.3} />
        </mesh>
      </group>
    </group>
  );
}

/** Complete door unit: lintel wall, frame, threshold, panel leaf. */
function DoorUnit({
  position,
  rotationY = 0,
  width,
  height,
  wallT,
  wallH,
  wallMat,
  frameMat,
  woodMat,
  panelMat,
  darkMat,
  ajar = -0.48,
}: {
  position: [number, number, number];
  rotationY?: number;
  width: number;
  height: number;
  wallT: number;
  wallH: number;
  wallMat: THREE.Material;
  frameMat: THREE.Material;
  woodMat: THREE.Material;
  panelMat: THREE.Material;
  darkMat: THREE.Material;
  ajar?: number;
}) {
  const jamb = 0.08;
  const head = 0.1;
  const thrH = 0.06;
  const lintelH = wallH - height;
  const roomSide = wallT / 2 + 0.01;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <WallSlab
        width={width + jamb * 2 + 0.04}
        height={lintelH}
        thickness={wallT}
        position={[0, height + lintelH / 2, 0]}
        material={wallMat}
      />
      <mesh position={[0, height / 2, -wallT * 0.6]} material={darkMat}>
        <boxGeometry args={[width - 0.02, height - 0.02, 0.04]} />
      </mesh>
      <mesh position={[-(width / 2 + jamb / 2), height / 2, roomSide]} castShadow material={frameMat}>
        <boxGeometry args={[jamb, height, 0.1]} />
      </mesh>
      <mesh position={[width / 2 + jamb / 2, height / 2, roomSide]} castShadow material={frameMat}>
        <boxGeometry args={[jamb, height, 0.1]} />
      </mesh>
      <mesh position={[0, height + head / 2, roomSide]} castShadow material={frameMat}>
        <boxGeometry args={[width + jamb * 2, head, 0.1]} />
      </mesh>
      <mesh position={[0, thrH / 2, roomSide]} receiveShadow material={frameMat}>
        <boxGeometry args={[width + jamb * 2, thrH, 0.14]} />
      </mesh>
      <mesh position={[0, height / 2, roomSide + 0.04]} material={frameMat}>
        <boxGeometry args={[width + 0.02, height - 0.02, 0.02]} />
      </mesh>
      <group position={[0, thrH, roomSide + 0.06]}>
        <DoorLeaf
          width={width - 0.02}
          height={height - thrH - 0.02}
          woodMat={woodMat}
          panelMat={panelMat}
          ajar={ajar}
        />
      </group>
    </group>
  );
}

/**
 * Traditional South Indian home room for Ali Guli Mane.
 * Proper enclosed structure: thick walls, panel door, window, plinth, skirting, cornice.
 * Poly Haven CC0 textures — public/textures/home/
 */
/**
 * @param dynamicLights — home page only: animated lamp flicker + low-rate redraw.
 *   Game page keeps this false for static lights and demand-mode idle performance.
 */
export function HomeVeranda({
  floorSize = 7.2,
  dynamicLights = false,
}: {
  floorSize?: number;
  dynamicLights?: boolean;
}) {
  const invalidate = useThree((s) => s.invalidate);

  const plaster = usePbrMaps(
    [
      '/textures/home/painted_plaster_wall/painted_plaster_wall_diff_1k.jpg',
      '/textures/home/painted_plaster_wall/painted_plaster_wall_nor_gl_1k.jpg',
      '/textures/home/painted_plaster_wall/painted_plaster_wall_rough_1k.jpg',
    ],
    invalidate,
  );
  const plasterWarm = usePbrMaps(
    [
      '/textures/home/yellow_plaster/yellow_plaster_diff_1k.jpg',
      '/textures/home/yellow_plaster/yellow_plaster_nor_gl_1k.jpg',
      '/textures/home/yellow_plaster/yellow_plaster_rough_1k.jpg',
    ],
    invalidate,
  );
  const floorMaps = usePbrMaps(
    [
      '/textures/home/terracotta_floor_tiles/terracotta_floor_tiles_diff_1k.jpg',
      '/textures/home/terracotta_floor_tiles/terracotta_floor_tiles_nor_gl_1k.jpg',
      '/textures/home/terracotta_floor_tiles/terracotta_floor_tiles_rough_1k.jpg',
    ],
    invalidate,
  );
  const matMaps = usePbrMaps(
    [
      '/textures/home/rough_linen/rough_linen_diff_1k.jpg',
      '/textures/home/rough_linen/rough_linen_nor_gl_1k.jpg',
      '/textures/home/rough_linen/rough_linen_rough_1k.jpg',
    ],
    invalidate,
  );
  const doorMaps = usePbrMaps(
    [
      '/textures/home/rough_pine_door/rough_pine_door_diff_1k.jpg',
      '/textures/home/rough_pine_door/rough_pine_door_nor_gl_1k.jpg',
      '/textures/home/rough_pine_door/rough_pine_door_rough_1k.jpg',
    ],
    invalidate,
  );
  const panelMaps = usePbrMaps(
    [
      '/textures/home/wooden_panels/wooden_panels_diff_1k.jpg',
      '/textures/home/wooden_panels/wooden_panels_nor_gl_1k.jpg',
      '/textures/home/wooden_panels/wooden_panels_rough_1k.jpg',
    ],
    invalidate,
  );
  const ceilMaps = usePbrMaps(
    [
      '/textures/home/ceiling_interior/ceiling_interior_diff_1k.jpg',
      '/textures/home/ceiling_interior/ceiling_interior_nor_gl_1k.jpg',
      '/textures/home/ceiling_interior/ceiling_interior_rough_1k.jpg',
    ],
    invalidate,
  );

  // UV tiles ≈ meters of texture repeat (1k maps look good ~1.2–1.8 m)
  const wallMat = useStdMat(plaster, {
    tilesU: 3.2,
    tilesV: 1.6,
    color: '#f2ebe0',
    roughness: 0.92,
    env: 0.28,
    normalScale: 0.35,
  });
  const wallWarmMat = useStdMat(plasterWarm, {
    tilesU: 3.0,
    tilesV: 1.5,
    color: '#f0e4c8',
    roughness: 0.93,
    env: 0.26,
    normalScale: 0.4,
  });
  const floorMat = useStdMat(floorMaps, {
    tilesU: floorSize * 0.5,
    tilesV: floorSize * 0.5,
    color: '#c4784a',
    roughness: 0.86,
    env: 0.35,
    normalScale: 0.55,
  });
  const rugMat = useStdMat(matMaps, {
    tilesU: 1.5,
    tilesV: 1.0,
    color: '#d8c4a0',
    roughness: 0.95,
    env: 0.2,
    normalScale: 0.65,
  });
  const doorWoodMat = useStdMat(doorMaps, {
    tilesU: 1.1,
    tilesV: 2.0,
    color: '#6a4a28',
    roughness: 0.78,
    metalness: 0.04,
    env: 0.45,
    normalScale: 0.55,
  });
  const panelMat = useStdMat(panelMaps, {
    tilesU: 0.9,
    tilesV: 1.2,
    color: '#5c3e22',
    roughness: 0.8,
    env: 0.4,
    normalScale: 0.5,
  });
  const frameMat = useStdMat(doorMaps, {
    tilesU: 0.6,
    tilesV: 2.2,
    color: '#4a3018',
    roughness: 0.75,
    env: 0.4,
    normalScale: 0.45,
  });
  const ceilMat = useStdMat(ceilMaps, {
    tilesU: 3.5,
    tilesV: 3.5,
    color: '#e8dfd0',
    roughness: 0.95,
    env: 0.18,
    normalScale: 0.3,
    side: THREE.DoubleSide,
  });

  const plinthMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#a88860'),
        roughness: 0.92,
        metalness: 0.02,
        envMapIntensity: 0.2,
      }),
    [],
  );
  const skirtingMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#e8dcc8'),
        roughness: 0.88,
        metalness: 0,
        envMapIntensity: 0.22,
      }),
    [],
  );
  const darkMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#14100c'),
        roughness: 1,
        metalness: 0,
      }),
    [],
  );
  const glassMat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#b8d0e0'),
        roughness: 0.08,
        metalness: 0,
        transmission: 0.65,
        thickness: 0.02,
        transparent: true,
        opacity: 0.32,
        envMapIntensity: 0.7,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const grassMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#5e7040'),
        roughness: 0.95,
        metalness: 0,
      }),
    [],
  );

  useLayoutEffect(() => {
    return () => {
      [
        wallMat,
        wallWarmMat,
        floorMat,
        rugMat,
        doorWoodMat,
        panelMat,
        frameMat,
        ceilMat,
      ].forEach(disposeMat);
      plinthMat.dispose();
      skirtingMat.dispose();
      darkMat.dispose();
      glassMat.dispose();
      grassMat.dispose();
    };
  }, [
    wallMat,
    wallWarmMat,
    floorMat,
    rugMat,
    doorWoodMat,
    panelMat,
    frameMat,
    ceilMat,
    plinthMat,
    skirtingMat,
    darkMat,
    glassMat,
    grassMat,
  ]);

  // —— Room metrics (meters) ——
  const half = floorSize / 2;
  const wallH = 2.75;
  const wallT = 0.18;
  const plinthH = 0.14;
  const skirtingH = 0.12;
  const corniceH = 0.1;

  const backZ = -half + wallT / 2;
  const frontZ = half - wallT / 2;
  const leftX = -half + wallT / 2;
  const rightX = half - wallT / 2;
  const sideLen = floorSize; // full-length sides

  // Door (back wall, into house)
  const doorW = 0.92;
  const doorH = 2.1;
  const doorX = -0.45;
  const backLeftW = half + doorX - doorW / 2;
  const backRightW = half - doorX - doorW / 2;

  // Window (front wall)
  const winW = 1.7;
  const winH = 1.2;
  const winSill = 0.9;
  const frontLeftW = (floorSize - winW) / 2;
  const frontRightW = frontLeftW;

  // Side window on +X wall for depth
  const sideWinW = 1.1;
  const sideWinH = 1.0;
  const sideWinSill = 1.0;
  const sideWinZ = 0.35;
  const sideFrontLen = half - sideWinZ - sideWinW / 2;
  const sideBackLen = half + sideWinZ - sideWinW / 2;

  // Ledge
  const ledgeH = 0.36;
  const ledgeD = 0.5;
  const ledgeZ = -half + wallT + ledgeD / 2 + 0.02;

  return (
    <group>
      {/* —— Raised plinth / foundation —— */}
      <mesh position={[0, -plinthH / 2 - 0.01, 0]} receiveShadow material={plinthMat}>
        <boxGeometry args={[floorSize + 0.35, plinthH, floorSize + 0.35]} />
      </mesh>

      {/* —— Floor —— */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.001, 0]}
        receiveShadow
        material={floorMat}
        frustumCulled={false}
      >
        <planeGeometry args={[floorSize - 0.02, floorSize - 0.02]} />
      </mesh>

      {/* Play mat */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.006, 0.05]}
        receiveShadow
        material={rugMat}
        frustumCulled={false}
      >
        <planeGeometry args={[1.9, 1.2]} />
      </mesh>

      {/* —— BACK WALL (split for door) —— */}
      <WallSlab
        width={backLeftW}
        height={wallH}
        thickness={wallT}
        position={[-half + backLeftW / 2, wallH / 2, backZ]}
        material={wallMat}
      />
      <WallSlab
        width={backRightW}
        height={wallH}
        thickness={wallT}
        position={[half - backRightW / 2, wallH / 2, backZ]}
        material={wallMat}
      />
      <DoorUnit
        position={[doorX, 0, backZ]}
        width={doorW}
        height={doorH}
        wallT={wallT}
        wallH={wallH}
        wallMat={wallMat}
        frameMat={frameMat}
        woodMat={doorWoodMat}
        panelMat={panelMat}
        darkMat={darkMat}
        ajar={-0.52}
      />

      {/* —— FRONT WALL (split for window) —— */}
      <WallSlab
        width={frontLeftW}
        height={wallH}
        thickness={wallT}
        position={[-half + frontLeftW / 2, wallH / 2, frontZ]}
        material={wallWarmMat}
      />
      <WallSlab
        width={frontRightW}
        height={wallH}
        thickness={wallT}
        position={[half - frontRightW / 2, wallH / 2, frontZ]}
        material={wallWarmMat}
      />
      {/* Below sill */}
      <WallSlab
        width={winW}
        height={winSill}
        thickness={wallT}
        position={[0, winSill / 2, frontZ]}
        material={wallWarmMat}
      />
      {/* Above window */}
      <WallSlab
        width={winW}
        height={wallH - winSill - winH}
        thickness={wallT}
        position={[0, winSill + winH + (wallH - winSill - winH) / 2, frontZ]}
        material={wallWarmMat}
      />
      {/* Window frame + glass */}
      <group position={[0, winSill + winH / 2, frontZ + wallT / 2 + 0.02]}>
        {/* jambs / head / sill lip */}
        <mesh position={[-winW / 2, 0, 0]} castShadow material={frameMat}>
          <boxGeometry args={[0.07, winH + 0.1, 0.09]} />
        </mesh>
        <mesh position={[winW / 2, 0, 0]} castShadow material={frameMat}>
          <boxGeometry args={[0.07, winH + 0.1, 0.09]} />
        </mesh>
        <mesh position={[0, winH / 2, 0]} castShadow material={frameMat}>
          <boxGeometry args={[winW + 0.08, 0.07, 0.09]} />
        </mesh>
        <mesh position={[0, -winH / 2, 0.02]} castShadow material={frameMat}>
          <boxGeometry args={[winW + 0.12, 0.08, 0.12]} />
        </mesh>
        {/* Cross mullions */}
        <mesh position={[0, 0, 0.01]} castShadow material={frameMat}>
          <boxGeometry args={[0.05, winH - 0.06, 0.05]} />
        </mesh>
        <mesh position={[0, 0.05, 0.01]} castShadow material={frameMat}>
          <boxGeometry args={[winW - 0.1, 0.04, 0.05]} />
        </mesh>
        {/* Four panes */}
        {(
          [
            [-0.38, 0.28],
            [0.38, 0.28],
            [-0.38, -0.28],
            [0.38, -0.28],
          ] as [number, number][]
        ).map(([px, py], i) => (
          <mesh key={i} position={[px, py, 0]} material={glassMat}>
            <boxGeometry args={[winW * 0.38, winH * 0.38, 0.015]} />
          </mesh>
        ))}
      </group>

      {/* —— LEFT WALL (solid, warm plaster) —— */}
      <WallSlab
        width={sideLen}
        height={wallH}
        thickness={wallT}
        position={[leftX, wallH / 2, 0]}
        rotationY={Math.PI / 2}
        material={wallMat}
      />

      {/* —— RIGHT WALL (with side window) —— */}
      <WallSlab
        width={sideBackLen}
        height={wallH}
        thickness={wallT}
        position={[rightX, wallH / 2, -half + sideBackLen / 2]}
        rotationY={Math.PI / 2}
        material={wallWarmMat}
      />
      <WallSlab
        width={sideFrontLen}
        height={wallH}
        thickness={wallT}
        position={[rightX, wallH / 2, half - sideFrontLen / 2]}
        rotationY={Math.PI / 2}
        material={wallWarmMat}
      />
      <WallSlab
        width={sideWinW}
        height={sideWinSill}
        thickness={wallT}
        position={[rightX, sideWinSill / 2, sideWinZ]}
        rotationY={Math.PI / 2}
        material={wallWarmMat}
      />
      <WallSlab
        width={sideWinW}
        height={wallH - sideWinSill - sideWinH}
        thickness={wallT}
        position={[
          rightX,
          sideWinSill + sideWinH + (wallH - sideWinSill - sideWinH) / 2,
          sideWinZ,
        ]}
        rotationY={Math.PI / 2}
        material={wallWarmMat}
      />
      {/* Side window frame */}
      <group position={[rightX + wallT / 2 + 0.02, sideWinSill + sideWinH / 2, sideWinZ]}>
        <mesh castShadow material={frameMat} position={[0, 0, -sideWinW / 2]}>
          <boxGeometry args={[0.08, sideWinH + 0.08, 0.06]} />
        </mesh>
        <mesh castShadow material={frameMat} position={[0, 0, sideWinW / 2]}>
          <boxGeometry args={[0.08, sideWinH + 0.08, 0.06]} />
        </mesh>
        <mesh castShadow material={frameMat} position={[0, sideWinH / 2, 0]}>
          <boxGeometry args={[0.08, 0.06, sideWinW + 0.06]} />
        </mesh>
        <mesh castShadow material={frameMat} position={[0, -sideWinH / 2, 0]}>
          <boxGeometry args={[0.08, 0.06, sideWinW + 0.06]} />
        </mesh>
        <mesh material={glassMat}>
          <boxGeometry args={[0.02, sideWinH - 0.08, sideWinW - 0.1]} />
        </mesh>
      </group>

      {/* —— Skirting boards (all four walls) —— */}
      <mesh position={[0, skirtingH / 2, backZ + wallT / 2 + 0.02]} material={skirtingMat} receiveShadow>
        <boxGeometry args={[floorSize - wallT * 2, skirtingH, 0.04]} />
      </mesh>
      <mesh position={[0, skirtingH / 2, frontZ - wallT / 2 - 0.02]} material={skirtingMat} receiveShadow>
        <boxGeometry args={[floorSize - wallT * 2, skirtingH, 0.04]} />
      </mesh>
      <mesh position={[leftX + wallT / 2 + 0.02, skirtingH / 2, 0]} material={skirtingMat} receiveShadow>
        <boxGeometry args={[0.04, skirtingH, floorSize - wallT * 2]} />
      </mesh>
      <mesh position={[rightX - wallT / 2 - 0.02, skirtingH / 2, 0]} material={skirtingMat} receiveShadow>
        <boxGeometry args={[0.04, skirtingH, floorSize - wallT * 2]} />
      </mesh>

      {/* —— Cornice under ceiling —— */}
      <mesh position={[0, wallH - corniceH / 2, backZ + wallT / 2 + 0.03]} material={skirtingMat}>
        <boxGeometry args={[floorSize - wallT, corniceH, 0.06]} />
      </mesh>
      <mesh position={[0, wallH - corniceH / 2, frontZ - wallT / 2 - 0.03]} material={skirtingMat}>
        <boxGeometry args={[floorSize - wallT, corniceH, 0.06]} />
      </mesh>
      <mesh position={[leftX + wallT / 2 + 0.03, wallH - corniceH / 2, 0]} material={skirtingMat}>
        <boxGeometry args={[0.06, corniceH, floorSize - wallT]} />
      </mesh>
      <mesh position={[rightX - wallT / 2 - 0.03, wallH - corniceH / 2, 0]} material={skirtingMat}>
        <boxGeometry args={[0.06, corniceH, floorSize - wallT]} />
      </mesh>

      {/* —— Thinnai ledges —— */}
      <mesh
        position={[-half + backLeftW / 2, ledgeH / 2, ledgeZ]}
        castShadow
        receiveShadow
        material={wallMat}
      >
        <boxGeometry args={[Math.max(0.25, backLeftW - 0.1), ledgeH, ledgeD]} />
      </mesh>
      <mesh
        position={[half - backRightW / 2, ledgeH / 2, ledgeZ]}
        castShadow
        receiveShadow
        material={wallMat}
      >
        <boxGeometry args={[Math.max(0.25, backRightW - 0.1), ledgeH, ledgeD]} />
      </mesh>
      <mesh position={[doorX, 0.05, ledgeZ - 0.08]} receiveShadow material={frameMat}>
        <boxGeometry args={[doorW + 0.15, 0.1, 0.28]} />
      </mesh>
      <mesh
        position={[leftX + 0.28, ledgeH / 2, -0.4]}
        castShadow
        receiveShadow
        material={wallMat}
      >
        <boxGeometry args={[0.4, ledgeH, floorSize * 0.45]} />
      </mesh>
      <mesh
        position={[rightX - 0.28, ledgeH / 2, -0.4]}
        castShadow
        receiveShadow
        material={wallWarmMat}
      >
        <boxGeometry args={[0.4, ledgeH, floorSize * 0.45]} />
      </mesh>

      {/* —— Ceiling —— */}
      <mesh
        position={[0, wallH - 0.02, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={ceilMat}
        receiveShadow
      >
        <planeGeometry args={[floorSize - wallT, floorSize - wallT]} />
      </mesh>
      {/* Beams */}
      {[-1.4, 0, 1.4].map((z) => (
        <mesh key={z} position={[0, wallH - 0.09, z]} castShadow material={frameMat}>
          <boxGeometry args={[floorSize - wallT * 2 - 0.2, 0.1, 0.12]} />
        </mesh>
      ))}

      {/* Oil lamps — flicker on home; static + brighter near board on play */}
      <OilLamp
        lampIndex={0}
        position={[doorX + doorW / 2 + 0.32, ledgeH + 0.02, ledgeZ + 0.04]}
        intensity={dynamicLights ? 2.4 : 2.8}
        distance={7.5}
        dynamic={dynamicLights}
      />
      <OilLamp
        lampIndex={1}
        position={[-half + 0.55, ledgeH + 0.02, -half + 0.72]}
        intensity={dynamicLights ? 2.0 : 2.4}
        distance={6.5}
        dynamic={dynamicLights}
      />
      <OilLamp
        lampIndex={2}
        position={[half - 0.58, ledgeH + 0.02, half - 0.85]}
        intensity={dynamicLights ? 2.1 : 2.5}
        distance={6.6}
        dynamic={dynamicLights}
      />
      {/* Closest to board / camera — strongest static fill when not dynamic */}
      <OilLamp
        lampIndex={3}
        position={[0.55, 0.02, 0.62]}
        intensity={dynamicLights ? 2.9 : 3.6}
        distance={6.2}
        dynamic={dynamicLights}
      />

      {/* Outside ground beyond front window */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, half + 1.5]} receiveShadow material={grassMat}>
        <planeGeometry args={[floorSize + 2, 3]} />
      </mesh>
    </group>
  );
}
