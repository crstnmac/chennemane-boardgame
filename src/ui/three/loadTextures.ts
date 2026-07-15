import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();

export function loadTexture(
  url: string,
  opts?: { repeat?: [number, number]; colorSpace?: THREE.ColorSpace },
): THREE.Texture {
  const key = `${url}|${opts?.repeat?.join(',') ?? ''}|${opts?.colorSpace ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tex = loader.load(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Match glTF UVs (board.glb) — do not mirror V
  tex.flipY = false;
  if (opts?.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  if (opts?.colorSpace) tex.colorSpace = opts.colorSpace;
  else tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}

export function gameTextures() {
  return {
    woodAlbedo: loadTexture('/textures/wood/wood_diff.jpg', { repeat: [1, 1] }),
    woodNormal: loadTexture('/textures/wood/wood_nor.jpg', {
      repeat: [1, 1],
      colorSpace: THREE.NoColorSpace,
    }),
    woodRough: loadTexture('/textures/wood/wood_rough.jpg', {
      repeat: [1, 1],
      colorSpace: THREE.NoColorSpace,
    }),
    table: loadTexture('/textures/table.png', { repeat: [1, 1] }),
    seed: loadTexture('/textures/seed-albedo.png'),
    noise: loadTexture('/textures/noise.png', {
      repeat: [4, 4],
      colorSpace: THREE.NoColorSpace,
    }),
  };
}
