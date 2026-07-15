import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { BOARD_URL, COCONUT_SHELL_URL, SEED_URL } from './assetUrls';
import {
  preloadBoardMaterialMaps,
  type BoardMaterialMaps,
  type PbrMaps,
} from './boardMaterialMaps';
import { studioSeedMaterial, toStudioMaterial } from './studioMaterials';

/** Shared seed geometry (cloned once from GLB). */
let seedGeometryCache: THREE.BufferGeometry | null = null;

/** Shared seed material (one studio mat for all instances + flying seed). */
let seedMaterialCache: THREE.MeshPhysicalMaterial | null = null;

/**
 * Prototype board with studio materials applied once.
 * Callers receive `prototype.clone(true)` so each Canvas gets its own graph
 * while geometry + materials stay shared (Three.js Mesh.copy shares both).
 */
let boardPrototype: THREE.Object3D | null = null;
let shellPrototype: THREE.Object3D | null = null;

export function extractSeedGeometry(scene: THREE.Object3D): THREE.BufferGeometry {
  if (seedGeometryCache) return seedGeometryCache;

  let geometry: THREE.BufferGeometry | null = null;
  scene.traverse((obj) => {
    if (geometry) return;
    if ((obj as THREE.Mesh).isMesh) {
      geometry = (obj as THREE.Mesh).geometry.clone();
    }
  });
  if (!geometry) geometry = new THREE.SphereGeometry(0.011, 12, 10);
  geometry.center();
  seedGeometryCache = geometry;
  return seedGeometryCache;
}

export function getSharedSeedMaterial(maps: PbrMaps): THREE.MeshPhysicalMaterial {
  // Rebuild if missing — hard refresh after seed PBR tweaks clears module state
  if (seedMaterialCache) return seedMaterialCache;
  seedMaterialCache = studioSeedMaterial(maps);
  return seedMaterialCache;
}

/** Force seed material rebuild (e.g. after PBR palette change in HMR). */
export function resetSeedMaterialCache() {
  seedMaterialCache = null;
}

/**
 * Board graph for this Canvas. First call builds studio materials; later calls
 * clone the prototype (cheap: shared geometry + materials).
 */
export function getStudioBoardRoot(
  scene: THREE.Object3D,
  maps: BoardMaterialMaps,
): THREE.Object3D {
  if (!boardPrototype) {
    const built = scene.clone(true);
    built.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Always recompute smooth normals so side walls shade correctly after
      // Blender booleans (inverted side normals read as flat grey patches).
      mesh.geometry.computeVertexNormals();
      if (!mesh.geometry.getAttribute('uv')) {
        console.warn('[board] mesh missing uv', mesh.name);
      }
      const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const studio = srcMats.map((m) => toStudioMaterial(m, maps));
      mesh.material = studio.length === 1 ? studio[0]! : studio;
    });
    built.position.set(0, 0, 0);
    built.rotation.set(0, 0, 0);
    built.scale.set(1, 1, 1);
    boardPrototype = built;
  }

  const instance = boardPrototype.clone(true);
  instance.position.set(0, 0, 0);
  instance.rotation.set(0, 0, 0);
  instance.scale.set(1, 1, 1);
  return instance;
}

/**
 * Coconut shell with studio husk/flesh PBR. Clone per instance (S/N).
 */
export function getStudioShellRoot(
  scene: THREE.Object3D,
  maps: BoardMaterialMaps,
): THREE.Object3D {
  if (!shellPrototype) {
    const built = scene.clone(true);
    built.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (!mesh.geometry.getAttribute('normal')) {
        mesh.geometry.computeVertexNormals();
      }
      const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const studio = srcMats.map((m) => toStudioMaterial(m, maps));
      mesh.material = studio.length === 1 ? studio[0]! : studio;
    });
    built.position.set(0, 0, 0);
    built.rotation.set(0, 0, 0);
    built.scale.set(1, 1, 1);
    shellPrototype = built;
  }
  return shellPrototype.clone(true);
}

/**
 * Drop cached board/shell prototypes so materials rebuild after texture swaps
 * (e.g. wooden_stool_02 wood maps). Safe to call anytime; next getStudio* rebuilds.
 */
export function resetStudioAssetCaches() {
  boardPrototype = null;
  shellPrototype = null;
  seedMaterialCache = null;
  seedGeometryCache = null;
}

/** Prefetch GLBs + PBR maps (safe at bootstrap / module init). */
export function preloadBoardAssets() {
  // Bust any in-memory board prototype after Blender re-exports board.glb
  resetStudioAssetCaches();
  useGLTF.preload(BOARD_URL);
  useGLTF.preload(SEED_URL);
  useGLTF.preload(COCONUT_SHELL_URL);
  preloadBoardMaterialMaps();
}
