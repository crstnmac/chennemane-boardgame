import * as THREE from 'three';
import type { BoardMaterialMaps, PbrMaps } from './boardMaterialMaps';

function matKey(mat: THREE.Material): string {
  return `${(mat as THREE.MeshStandardMaterial).name ?? ''} ${mat.name ?? ''}`.toLowerCase();
}

/** Classify GLB material by name / metalness. */
export function isMetalMaterial(mat: THREE.Material): boolean {
  const key = matKey(mat);
  if (key.includes('bronze') || key.includes('iron') || key.includes('metal')) return true;
  return ((mat as THREE.MeshStandardMaterial).metalness ?? 0) > 0.4;
}

export function isIronMaterial(mat: THREE.Material): boolean {
  return matKey(mat).includes('iron');
}

export function isCoconutHusk(mat: THREE.Material): boolean {
  const k = matKey(mat);
  return k.includes('coconuthusk') || k.includes('husk');
}

export function isCoconutFlesh(mat: THREE.Material): boolean {
  const k = matKey(mat);
  return k.includes('coconutflesh') || k.includes('flesh');
}

function applyPbr(
  mat: THREE.MeshPhysicalMaterial,
  maps: PbrMaps,
  normalScale = 0.7,
) {
  mat.map = maps.map;
  mat.normalMap = maps.normalMap;
  mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  mat.roughnessMap = maps.roughnessMap;
  if (maps.metalnessMap) {
    mat.metalnessMap = maps.metalnessMap;
  }
  mat.needsUpdate = true;
}

/**
 * Materials with high-quality Poly Haven PBR maps (CC0).
 */
export function toStudioMaterial(
  src: THREE.Material,
  maps?: BoardMaterialMaps,
): THREE.MeshPhysicalMaterial {
  if (isCoconutHusk(src)) {
    // Warm lift so bowls read on low-env play lighting / mobile IBL
    const mat = new THREE.MeshPhysicalMaterial({
      name: 'CoconutHusk',
      color: new THREE.Color('#b86a38'),
      metalness: 0.02,
      roughness: 0.88,
      envMapIntensity: 0.38,
      clearcoat: 0.08,
      clearcoatRoughness: 0.6,
      sheen: 0.3,
      sheenColor: new THREE.Color('#d48848'),
      sheenRoughness: 0.8,
      // Soft self-light so rims don’t collapse to a dark disc at distance
      emissive: new THREE.Color('#3a1808'),
      emissiveIntensity: 0.08,
      flatShading: false,
    });
    if (maps?.coconutHusk) applyPbr(mat, maps.coconutHusk, 1.1);
    return mat;
  }

  if (isCoconutFlesh(src)) {
    const mat = new THREE.MeshPhysicalMaterial({
      name: 'CoconutFlesh',
      color: new THREE.Color('#f6ecda'),
      metalness: 0.0,
      roughness: 0.45,
      envMapIntensity: 0.55,
      clearcoat: 0.35,
      clearcoatRoughness: 0.28,
      sheen: 0.18,
      sheenColor: new THREE.Color('#fff8ec'),
      sheenRoughness: 0.5,
      emissive: new THREE.Color('#2a2010'),
      emissiveIntensity: 0.04,
      flatShading: false,
    });
    if (maps?.coconutFlesh) applyPbr(mat, maps.coconutFlesh, 0.55);
    return mat;
  }

  const metal = isMetalMaterial(src);
  const iron = isIronMaterial(src);

  if (metal) {
    if (iron) {
      // Dark warm iron rivets — avoid cool grey which reads as a "dead" side patch
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'BoardIron',
        color: new THREE.Color('#6a5a48'),
        metalness: 0.85,
        roughness: 0.58,
        envMapIntensity: 0.35,
        clearcoat: 0.06,
        clearcoatRoughness: 0.6,
        flatShading: false,
      });
      if (maps?.iron) applyPbr(mat, maps.iron, 0.5);
      return mat;
    }

    // Aged bronze fittings — warm gold (not grey)
    const mat = new THREE.MeshPhysicalMaterial({
      name: 'BoardBronze',
      color: new THREE.Color('#d4a050'),
      metalness: 0.82,
      roughness: 0.48,
      envMapIntensity: 0.4,
      clearcoat: 0.12,
      clearcoatRoughness: 0.45,
      sheen: 0.1,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color('#e8c070'),
      flatShading: false,
    });
    if (maps?.bronze) applyPbr(mat, maps.bronze, 0.55);
    return mat;
  }

  // Board body — Poly Haven kitchen_wood (light pine/oak for bead contrast)
  // https://polyhaven.com/a/kitchen_wood
  // Kept matte so lamp/env reflections don't flash on the play surface.
  const mat = new THREE.MeshPhysicalMaterial({
    name: 'BoardWood',
    // Near-white so light albedo stays bright; red beads still pop
    color: new THREE.Color('#f0e8dc'),
    metalness: 0.0,
    roughness: 0.78,
    envMapIntensity: 0.18,
    // Minimal varnish — grain from maps, not mirror clearcoat
    clearcoat: 0.04,
    clearcoatRoughness: 0.72,
    sheen: 0.02,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color('#c4a878'),
    flatShading: false,
  });
  if (maps?.wood) applyPbr(mat, maps.wood, 0.55);
  return mat;
}

/**
 * Gulaganji beads — Poly Haven leather_red_03 (smooth lustrous red).
 * https://polyhaven.com/a/leather_red_03
 * Full PBR maps; warm color multiply keeps them bright on dark board wood.
 */
export function studioSeedMaterial(maps?: PbrMaps): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    name: 'SeedGulaganji',
    // Light warm lift so leather albedo stays vivid (not muddy brown-red)
    color: new THREE.Color('#ffc8b0'),
    metalness: 0.0,
    roughness: 0.28,
    envMapIntensity: 0.72,
    clearcoat: 0.58,
    clearcoatRoughness: 0.15,
    sheen: 0.35,
    sheenColor: new THREE.Color('#ff7050'),
    sheenRoughness: 0.35,
    // Soft lift in lamp shadows so beads never disappear into dark pits
    emissive: new THREE.Color('#4a100c'),
    emissiveIntensity: 0.12,
    flatShading: false,
  });
  if (maps) {
    applyPbr(mat, maps, 0.55);
    mat.roughness = 0.3;
  }
  mat.needsUpdate = true;
  return mat;
}

/**
 * Warm timber-floor pool under the board — flat radial falloff (no grain maps).
 * Strong enough to read from the play camera as a lit table surface.
 */
export function createGroundMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Color('#4a3420') },
      uMid: { value: new THREE.Color('#2a1c12') },
      uEdge: { value: new THREE.Color('#0e0a08') },
      uGlow: { value: new THREE.Color('#6a4828') },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter;
      uniform vec3 uMid;
      uniform vec3 uEdge;
      uniform vec3 uGlow;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float d2 = length(p * vec2(1.0, 1.12));
        vec3 col = mix(uCenter, uMid, smoothstep(0.08, 0.48, d2));
        col = mix(col, uEdge, smoothstep(0.42, 1.02, d2));
        float pool = exp(-d2 * d2 * 1.4);
        col = mix(col, uGlow, pool * 0.55);
        // Stay opaque near center so the floor reads clearly
        float alpha = smoothstep(1.05, 0.28, d2);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * Inverted dome — indoor evening walls / ceiling (no textures).
 * Colors are intentionally a step above pure black so the room reads on camera.
 */
export function createAtmosphereDomeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false, // never wash out the room into pure fog color
    uniforms: {
      uZenith: { value: new THREE.Color('#1c1612') },
      uHorizon: { value: new THREE.Color('#4a3422') },
      uFloor: { value: new THREE.Color('#100c08') },
      uCool: { value: new THREE.Color('#2a3a4c') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldNormal;
      void main() {
        vWorldNormal = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uFloor;
      uniform vec3 uCool;
      varying vec3 vWorldNormal;
      void main() {
        float h = vWorldNormal.y;
        vec3 col = mix(uFloor, uHorizon, smoothstep(-0.5, 0.12, h));
        col = mix(col, uZenith, smoothstep(0.12, 0.9, h));
        // Cool monsoon window on upper +X
        float cool = smoothstep(0.05, 0.9, vWorldNormal.x) * smoothstep(-0.05, 0.7, h);
        col = mix(col, uCool, cool * 0.38);
        // Soft warm lamp on -X / lower
        float warm = smoothstep(0.2, -0.7, vWorldNormal.x) * smoothstep(0.5, -0.2, h);
        col = mix(col, uHorizon, warm * 0.25);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
