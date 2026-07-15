/** Shared GLSL noise helpers for premium materials */
export const NOISE_GLSL = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * valueNoise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

// Oriented wood grain: stretched noise along grain direction
float woodGrain(vec2 p, float scale) {
  // Warp along grain axis for natural curve
  float warp = fbm(p * 0.35) * 1.4;
  vec2 q = vec2(p.x * 0.15 + warp, p.y * scale);
  float g = fbm(q);
  // Rings / pore lines
  float lines = sin((p.x + warp * 2.0) * 18.0 + g * 6.0) * 0.5 + 0.5;
  float pores = valueNoise(p * 40.0);
  return g * 0.65 + lines * 0.28 + pores * 0.07;
}

vec3 woodNormal(vec2 p, float scale, float strength) {
  float e = 0.004;
  float h = woodGrain(p, scale);
  float hx = woodGrain(p + vec2(e, 0.0), scale);
  float hy = woodGrain(p + vec2(0.0, e), scale);
  vec3 n = normalize(vec3((h - hx) * strength, (h - hy) * strength, 1.0));
  return n;
}
`;
