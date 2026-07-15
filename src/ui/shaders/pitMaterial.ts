import * as THREE from 'three';
import { NOISE_GLSL } from './noise';

const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;

void main() {
  vUv = uv;
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
uniform vec3 uLightDir;
uniform vec3 uAccent;
uniform float uAccentStr;
uniform float uTime;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;

void main() {
  vec2 uv = vWorldPos.xz * 1.8 + 0.5;
  vec3 wood = texture2D(uAlbedo, uv).rgb * 0.45;
  float g = woodGrain(uv * 2.5, 8.0);
  wood *= 0.7 + g * 0.3;

  vec3 N = normalize(vNormal);
  float depth = 1.0 - smoothstep(-0.2, 0.9, N.y);
  vec3 base = wood * (0.3 + 0.7 * (1.0 - depth * 0.85));

  vec3 L = normalize(uLightDir);
  vec3 V = normalize(vViewDir);
  float ndl = max(dot(N, L), 0.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.18;

  vec3 col = base * (0.22 + ndl * 0.7);
  col += vec3(1.0, 0.85, 0.65) * spec;
  col += base * rim * 0.2;
  col = mix(col, col + uAccent * 0.4, uAccentStr * (0.4 + rim * 0.6));
  col += uAccent * uAccentStr * 0.1 * (0.5 + 0.5 * sin(uTime * 3.0));

  col = col / (col + 1.0);
  col = pow(col, vec3(1.0 / 1.9));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createPitMaterial(albedo: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uAlbedo: { value: albedo },
      uLightDir: { value: new THREE.Vector3(0.45, 0.85, 0.35).normalize() },
      uAccent: { value: new THREE.Color('#c9a962') },
      uAccentStr: { value: 0 },
      uTime: { value: 0 },
    },
  });
}
