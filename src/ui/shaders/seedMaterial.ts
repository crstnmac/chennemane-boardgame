import * as THREE from 'three';
import { NOISE_GLSL } from './noise';

const vertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;
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
uniform float uTime;
uniform float uPulse;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec2 vUv;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  vec3 L = normalize(uLightDir);

  // Spherical UV-ish from normal for seamless seed texture
  vec2 suv = vec2(atan(N.z, N.x) / 6.2831853 + 0.5, N.y * 0.5 + 0.5);
  vec3 tex = texture2D(uAlbedo, suv * 0.92 + 0.04).rgb;
  float n = fbm(vWorldPos.xy * 14.0 + vWorldPos.z * 8.0);
  vec3 base = mix(tex, tex * vec3(1.05, 0.9, 0.85), n * 0.25);
  // Ensure coral if map is dark at poles
  base = max(base, vec3(0.45, 0.1, 0.06) * (0.7 + n * 0.3));

  float ndl = max(dot(N, L), 0.0);
  float wrap = max(dot(N, L) * 0.5 + 0.5, 0.0);
  float sss = pow(wrap, 1.4) * 0.32;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0);
  float glint = pow(max(dot(N, H), 0.0), 240.0);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.8);

  vec3 col = base * (0.2 + ndl * 0.6 + sss);
  col += vec3(1.0, 0.4, 0.22) * pow(max(dot(N, -normalize(vec3(-0.3, 0.2, -0.7))), 0.0), 2.0) * 0.18;
  col += vec3(1.0, 0.88, 0.78) * spec * 0.5;
  col += vec3(1.0) * glint * 0.85;
  col += base * fresnel * 0.18;
  col += vec3(1.0, 0.55, 0.3) * uPulse * (0.07 + 0.05 * sin(uTime * 8.0));

  col = col / (col + 1.0);
  col = pow(col, vec3(1.0 / 2.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSeedMaterial(albedo: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uAlbedo: { value: albedo },
      uLightDir: { value: new THREE.Vector3(0.45, 0.85, 0.35).normalize() },
      uTime: { value: 0 },
      uPulse: { value: 0 },
    },
  });
}
