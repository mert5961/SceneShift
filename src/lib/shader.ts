// 2.5D photo parallax. A pixel with depth d (1 = near, 0 = far) moves on screen by offset * (d - focus).
// For each screen pixel s we need the source pixel p with  p + offset * (D(p) - focus) = s.
//
// NAIVE (one texture read):   p = s - offset * (D(s) - focus)
//   Reads depth at the wrong place near edges -> doubled / smeared silhouettes.
// RAY MARCH (occlusion aware): walk depth layers from near to far, t = 1 -> 0,
//   candidate p(t) = s - offset * (t - focus); the first t where D(p(t)) >= t is the visible surface.
//   Near surfaces win, like a real camera move. A linear refine between the last two steps removes banding.
// WALL FILL: a depth edge acts like a vertical wall in the heightfield. Rays that hit the wall paint the
//   stretched streaks / ghost copies behind thin things. With uFill on we look through walls and fill the
//   revealed gap with nearby background (edge extend, like building a clean plate in comp).

export const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uDepthRaw;   // depth as the model gave it (naive side)
uniform sampler2D uDepthMarch; // depth after matte clean-up, or raw if clean-up is off
uniform float uHasImage;
uniform vec2  uOffset;     // parallax direction * strength, in uv units
uniform float uFocus;      // depth that stays still (0 far .. 1 near)
uniform vec2  uCover;      // uv scale so the photo covers the screen (object-fit: cover)
uniform float uZoom;       // >1 crops in, hides the borders the move reveals
uniform vec2  uCenter;     // crop centre in image uv (auto-framed on the nearest subject)
uniform float uSplit;      // compare line in screen x, 0..1
uniform int   uMode;       // 0 naive, 1 ray march, 2 compare (naive left | ray march right)
uniform int   uView;       // 0 colour, 1 depth pass
uniform float uExposure;   // intro fade
uniform int   uFill;       // 1: see-through walls + background fill at disocclusions
uniform float uWall;       // how far below the surface top a crossing may land before it counts as a wall

float Dn(vec2 uv) { return texture2D(uDepthRaw, uv).r; }
float D(vec2 uv)  { return texture2D(uDepthMarch, uv).r; }

vec2 naive(vec2 s) { return s - uOffset * (Dn(s) - uFocus); }

vec2 rayMarch(vec2 s) {
  const int STEPS = 40;
  float dt = 1.0 / float(STEPS);
  float tPrev = 1.0;
  float gPrev = D(s - uOffset * (1.0 - uFocus)) - 1.0;      // D(p) - t, >= 0 means hit
  if (gPrev >= 0.0) return s - uOffset * (1.0 - uFocus);
  vec2 wallP = vec2(-1.0);
  float wallD = 0.0;
  for (int i = 1; i <= STEPS; i++) {
    float t = 1.0 - float(i) * dt;
    vec2 p = s - uOffset * (t - uFocus);
    float g = D(p) - t;
    if (g >= 0.0 && gPrev < 0.0) {
      if (uFill == 1 && g > uWall) {
        if (wallP.x < 0.0) { wallP = p; wallD = D(p); }      // went into a wall: look through it
      } else {
        float a = gPrev / (gPrev - g);                        // where D(p) - t crossed zero
        float th = mix(tPrev, t, a);
        return s - uOffset * (th - uFocus);
      }
    }
    tPrev = t; gPrev = g;
  }
  if (wallP.x >= 0.0) {
    // disocclusion: walk away from the near object until the depth drops to background, sample there
    vec2 dir = normalize(uOffset + 1e-6) * (1.5 / 512.0);
    for (int k = 1; k <= 24; k++) {
      vec2 q1 = wallP + dir * float(k);
      vec2 q2 = wallP - dir * float(k);
      if (D(q1) < wallD - uWall) return q1;
      if (D(q2) < wallD - uWall) return q2;
    }
    return wallP;
  }
  return s - uOffset * (0.0 - uFocus);
}

void main() {
  vec2 half_ = 0.5 * uCover / uZoom;
  vec2 s = (vUv - 0.5) * uCover / uZoom + clamp(uCenter, half_, 1.0 - half_);
  if (uHasImage < 0.5) { gl_FragColor = vec4(vec3(0.06), 1.0); return; }
  bool march = uMode == 1 || (uMode == 2 && vUv.x > uSplit);
  vec2 p = clamp(march ? rayMarch(s) : naive(s), 0.0, 1.0);
  vec3 col = uView == 1 ? vec3(march ? D(p) : Dn(p)) : texture2D(uImage, p).rgb;
  col *= uExposure;
  if (uMode == 2 && abs(vUv.x - uSplit) < 0.0012) col = vec3(1.0);
  gl_FragColor = vec4(col, 1.0);
}
`;
