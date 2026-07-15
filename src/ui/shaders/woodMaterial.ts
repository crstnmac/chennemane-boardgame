import * as THREE from 'three';
import { NOISE_GLSL } from './noise';

const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
varying vec3 vObjectPos;

void main() {
  vUv = uv;
  vObjectPos = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
${NOISE_GLSL}

uniform sampler2D uAlbedo;
uniform sampler2D uNormalMap;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbient;
uniform float uTime;
uniform float uGloss;
uniform float uHighlight;
uniform vec2 uMapRepeat;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
varying vec3 vObjectPos;

// Decode tangent-space normal map; blend with geometric normal
vec3 applyNormalMap(vec3 N, vec2 uv) {
  vec3 nMap = texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
  nMap.xy *= 1.15;
  vec3 T = normalize(cross(N, abs(N.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 B = cross(N, T);
  return normalize(mat3(T, B, N) * nMap);
}

void main() {
  // Prefer UVs; fall back to planar XZ for carved pit interiors
  vec2 uv = vUv * uMapRepeat;
  float uvWeight = step(0.001, length(vUv));
  vec2 planar = vWorldPos.xz * 1.35 + 0.5;
  vec2 sampleUv = mix(planar, uv, uvWeight);

  vec3 albedo = texture2D(uAlbedo, sampleUv).rgb;
  // Enrich with light procedural grain so maps don't look flat
  float g = woodGrain(sampleUv * 3.0, 6.0);
  albedo = mix(albedo, albedo * vec3(0.85, 0.78, 0.7), g * 0.18);

  vec3 N = normalize(vNormal);
  N = applyNormalMap(N, sampleUv);

  vec3 L = normalize(uLightDir);
  vec3 V = normalize(vViewDir);
  vec3 H = normalize(L + V);

  float wrap = max(dot(N, L), 0.0) * 0.72 + 0.28;
  float fill = max(dot(N, normalize(vec3(-0.55, 0.45, -0.35))), 0.0) * 0.28;
  float spec = pow(max(dot(N, H), 0.0), mix(32.0, 80.0, uGloss));
  float coat = pow(max(dot(N, H), 0.0), 140.0) * uGloss * 0.4;
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  vec3 col = albedo * (uAmbient + uLightColor * wrap + fill);
  col += uLightColor * spec * uGloss * 0.45 * (0.3 + fresnel);
  col += vec3(1.0, 0.95, 0.88) * coat;
  col += albedo * fresnel * 0.08;
  col = mix(col, col * 1.08 + vec3(0.06, 0.04, 0.02), uHighlight);

  float ao = 0.72 + 0.28 * max(N.y, 0.0);
  col *= ao;

  col = col / (col + vec3(1.0));
  col = pow(col, vec3(1.0 / 1.95));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createWoodMaterial(maps: {
  albedo: THREE.Texture;
  normal: THREE.Texture;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uAlbedo: { value: maps.albedo },
      uNormalMap: { value: maps.normal },
      uMapRepeat: { value: new THREE.Vector2(1.4, 2.0) },
      uLightDir: { value: new THREE.Vector3(0.45, 0.88, 0.35).normalize() },
      uLightColor: { value: new THREE.Color(1.0, 0.94, 0.86) },
      uAmbient: { value: new THREE.Color(0.18, 0.16, 0.2) },
      uTime: { value: 0 },
      uGloss: { value: 0.82 },
      uHighlight: { value: 0 },
    },
  });
}
