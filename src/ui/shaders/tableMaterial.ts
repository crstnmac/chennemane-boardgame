import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorldPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vec3 base = texture2D(uMap, vUv * 1.4).rgb;
  float r = length(vUv - 0.5) * 2.0;
  float vignette = smoothstep(1.15, 0.25, r);
  float spot = exp(-dot(vWorldPos.xz, vWorldPos.xz) * 1.6) * 0.4;
  vec3 col = base * (0.45 + vignette * 0.55) + vec3(0.1, 0.12, 0.18) * spot;
  col = pow(col, vec3(1.0 / 1.9));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createTableMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uMap: { value: map },
    },
  });
}
