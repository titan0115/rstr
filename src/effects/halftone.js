// effects/halftone.js — HALFTONE category effect entries.
(function (RSTR) {
  'use strict';
  const HEAD = RSTR._effectHead;
  Object.assign(RSTR.EFFECTS, {
    // ================= HALFTONE =================
    // Merged 2026-07-13: the former standalone `riso` (Risograph print
    // simulation) collapsed into `halftone`, mode-switched via the `mode`
    // select — same pattern as the dots (2026-07-11) and posterize
    // (2026-07-13) merges (see CLAUDE.md: "merge by shared MECHANISM, not
    // shared THEME"). `halftone` is a rotated dot screen; `riso` is the
    // SAME rotated dot screen run 2-3 times at different fixed angles, each
    // with a per-ink misregistration offset, composited as translucent
    // overprint over a paper base — riso IS halftone screening, N times,
    // not a different mechanism. `showIf` (ui.js) hides params the current
    // mode doesn't read; src/pipeline.js's uniform-upload loop is unaware
    // of showIf and still uploads every param as a uniform every frame
    // regardless of mode. `default: 0` on `mode` is load-bearing: an old
    // `halftone` style code has no `mode` key, so it defaults to 0 and
    // renders byte-identical to the pre-merge `halftone` effect. Old `riso`
    // LAYERS are migrated to `{ effect: 'halftone', params: { mode: 1 } }`
    // in src/preset.js (validatePreset / LEGACY_EFFECTS), upstream of the
    // unknown-effect drop; every old riso param key carries across
    // unchanged (the two param sets never collided — both effects already
    // happened to call the screen pitch `cellSize`, reused here rather than
    // duplicated).
    //
    // `angle` decision: kept INTERNAL to Riso (still hardcoded 15/75/45 deg
    // per ink inside modeRiso(), exactly as pre-merge) rather than exposed
    // as a shared "base rotation" the per-ink angles offset from. Two
    // reasons: (1) a shared base-rotation control buys little — rotating
    // all three screens together doesn't change the moiré/overlap pattern
    // between inks, only its orientation under crop, so it's low-value; (2)
    // reusing `angle` (Mono's default is 15) as a Riso offset would need a
    // second, mode-dependent default (0 for Riso) that a single param
    // definition can't express, which is exactly the kind of avoidable
    // coordination risk this file's byte-identity rule warns against. Gated
    // to mode 0 only.
    //
    // `ink3` is gated on `mode` (not `inkCount`, unlike the pre-merge riso):
    // `showIf` (ui.js) only supports ONE controller key, so gating on
    // `inkCount` alone would leak the Ink 3 swatch into the Mono panel
    // whenever `inkCount` was left at 3 from a previous Riso edit. Gating on
    // `mode` means Ink 3 shows (but is simply unused by the shader, exactly
    // as before) whenever `inkCount` is 2 in Riso mode — a small cosmetic
    // redundancy traded for never leaking a Riso-only control into Mono.
    //
    // ONE frag, two mode bodies. Each body is the pre-merge shader's old
    // main() taken verbatim — only renamed to a vec4-returning function
    // (`fragColor = vec4(...); }` -> `return vec4(...); }`) — pixel output
    // is unchanged. Riso's helper functions (risoHash/risoValueNoise/
    // risoOffset/risoInk) are unchanged file-scope declarations; no name
    // clashes with Mono's body (locals are scoped per-function in GLSL, only
    // file-scope helpers can collide, and Mono never declared any).
    halftone: {
      id: 'halftone',
      name: 'Halftone',
      category: 'HALFTONE',
      params: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Mono' },
            { value: 1, label: 'Riso' },
          ],
        },
        // Shared by both modes — Mono's screen pitch and Riso's per-ink
        // screen pitch already read the exact same key/uniform pre-merge,
        // reused rather than duplicated. Range is the union (3..40);
        // default is Mono's own so an old `halftone` code (no `mode` key)
        // is byte-identical.
        { key: 'cellSize', label: 'Cell size', type: 'range', min: 3, max: 40, step: 1, default: 10, showIf: { key: 'mode', in: [0, 1] } },
        // Mono-only — see the registry comment above for why Riso keeps its
        // screen angles hardcoded instead of sharing this.
        { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 90, step: 1, default: 15, showIf: { key: 'mode', in: [0] } },
        {
          key: 'shape',
          label: 'Shape',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Dot' },
            { value: 1, label: 'Line' },
            { value: 2, label: 'Square' },
          ],
          showIf: { key: 'mode', in: [0] },
        },
        // Renamed label from Halftone's original "Mode" -> "Color mode":
        // the key stays `mono` (serialization/hash unchanged), but with the
        // new top-level `mode` select also called "Mode", two visible
        // controls both labeled "Mode" would be confusing. Label is
        // UI-only — same move as posterize's `mono` rename (2026-07-13).
        {
          key: 'mono',
          label: 'Color mode',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Color' },
            { value: 1, label: 'Mono' },
          ],
          showIf: { key: 'mode', in: [0] },
        },
        {
          key: 'inkCount',
          label: 'Ink count',
          type: 'select',
          default: 2,
          options: [
            { value: 2, label: '2' },
            { value: 3, label: '3' },
          ],
          showIf: { key: 'mode', in: [1] },
        },
        { key: 'ink1', label: 'Ink 1', type: 'color', default: '#ff48b0', showIf: { key: 'mode', in: [1] } }, // Riso Fluorescent Pink
        { key: 'ink2', label: 'Ink 2', type: 'color', default: '#0078bf', showIf: { key: 'mode', in: [1] } }, // Riso Blue
        // Gated on `mode`, not `inkCount` — see the registry comment above.
        { key: 'ink3', label: 'Ink 3', type: 'color', default: '#ffe800', showIf: { key: 'mode', in: [1] } }, // Riso Yellow
        { key: 'paper', label: 'Paper', type: 'color', default: '#f2ede1', showIf: { key: 'mode', in: [1] } },
        { key: 'registration', label: 'Misregistration', type: 'range', min: 0, max: 12, step: 0.5, default: 2.5, showIf: { key: 'mode', in: [1] } },
        { key: 'inkTexture', label: 'Ink texture', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35, showIf: { key: 'mode', in: [1] } },
        // NOT keyed `seed` -- u_seed is already a shared uniform declared
        // once in HEAD and uploaded by the pipeline every pass; a param
        // literally named `seed` would resolve to that same uniform
        // location and silently shadow it (see `glitch`'s seedOffset).
        { key: 'seedOffset', label: 'Reroll', type: 'range', min: 0, max: 100, step: 1, default: 0, showIf: { key: 'mode', in: [1] } },
      ],
      // Presets merged from both pre-merge effects, each carrying its own
      // `mode`. Riso presets prefixed to namespace them from Mono's (no
      // actual name collisions, but keeps the two families visually
      // distinct in one shared list).
      presets: {
        Comic: { mode: 0, cellSize: 8, angle: 15, shape: 0, mono: 1 },
        Big: { mode: 0, cellSize: 24, angle: 45, shape: 0, mono: 0 },
        Lines: { mode: 0, cellSize: 12, angle: 15, shape: 1, mono: 0 },
        'Riso Pink & Blue': { mode: 1, inkCount: 2, ink1: '#ff48b0', ink2: '#0078bf', ink3: '#ffe800', paper: '#f2ede1', cellSize: 7, registration: 2.5, inkTexture: 0.35, seedOffset: 0 },
        'Riso Trio': { mode: 1, inkCount: 3, ink1: '#ff48b0', ink2: '#0078bf', ink3: '#ffe800', paper: '#f2ede1', cellSize: 6, registration: 3, inkTexture: 0.4, seedOffset: 12 },
        'Riso Tight Registration': { mode: 1, inkCount: 2, ink1: '#000000', ink2: '#f15060', ink3: '#ffe800', paper: '#ffffff', cellSize: 5, registration: 0.5, inkTexture: 0.15, seedOffset: 0 },
        'Riso Blown Out': { mode: 1, inkCount: 3, ink1: '#ff48b0', ink2: '#0078bf', ink3: '#ffe800', paper: '#e9e2cf', cellSize: 10, registration: 8, inkTexture: 0.7, seedOffset: 42 },
      },
      frag: `${HEAD}
uniform float u_mode;
uniform float u_cellSize;
uniform float u_angle;
uniform float u_shape;
uniform float u_mono;
uniform float u_inkCount;
uniform vec3 u_ink1;
uniform vec3 u_ink2;
uniform vec3 u_ink3;
uniform vec3 u_paper;
uniform float u_registration;
uniform float u_inkTexture;
uniform float u_seedOffset;

// mode 0 -- Mono (verbatim pre-merge halftone shader body; main() -> modeMono())
vec4 modeMono() {
  float cell = max(u_cellSize, 2.0);
  float a = radians(u_angle);
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  mat2 invRot = mat2(cos(a), -sin(a), sin(a), cos(a));

  vec2 uv = v_uv * u_resolution;
  vec2 ruv = rot * uv;
  vec2 cellIndex = floor(ruv / cell);
  vec2 cellCenterRotated = (cellIndex + 0.5) * cell;
  vec2 cellCenterOriginal = invRot * cellCenterRotated;
  vec2 sampleUv = clamp(cellCenterOriginal / u_resolution, vec2(0.0), vec2(1.0));
  vec3 cellColor = texture(u_tex, sampleUv).rgb;

  float lum = dot(cellColor, vec3(0.299, 0.587, 0.114));
  vec2 posInCell = ruv - cellCenterRotated;

  float shapeMask;
  if (u_shape < 0.5) {
    float dist = length(posInCell);
    float radius = (1.0 - lum) * cell * 0.5 * 1.2;
    shapeMask = 1.0 - smoothstep(radius - 1.0, radius + 1.0, dist);
  } else if (u_shape < 1.5) {
    float halfW = (1.0 - lum) * cell * 0.5;
    shapeMask = 1.0 - smoothstep(halfW - 1.0, halfW + 1.0, abs(posInCell.y));
  } else {
    float halfS = (1.0 - lum) * cell * 0.5 * 1.1;
    vec2 d = abs(posInCell);
    float m = max(d.x, d.y);
    shapeMask = 1.0 - smoothstep(halfS - 1.0, halfS + 1.0, m);
  }

  vec3 fg = (u_mono > 0.5) ? vec3(0.0) : cellColor;
  vec3 bg = vec3(1.0);
  vec3 outColor = mix(bg, fg, shapeMask);
  return vec4(outColor, texture(u_tex, v_uv).a);
}

// mode 1 -- Riso (verbatim pre-merge riso shader body; helpers kept
// file-scope unchanged; main() -> modeRiso())
float risoHash(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
}

float risoValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = risoHash(i);
  float b = risoHash(i + vec2(1.0, 0.0));
  float c = risoHash(i + vec2(0.0, 1.0));
  float d = risoHash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 risoOffset(float inkIndex, float seedBase) {
  float ang = risoHash(vec2(inkIndex * 7.0 + 1.0, seedBase)) * 6.28318530718;
  float mag = risoHash(vec2(inkIndex * 13.0 + 5.0, seedBase * 1.7));
  return vec2(cos(ang), sin(ang)) * u_registration * mag;
}

float risoInk(vec2 off, float angleDeg, float toneBias) {
  float ang = radians(angleDeg);
  mat2 rot = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
  mat2 invRot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 px = v_uv * u_resolution + off;
  vec2 ruv = rot * px;
  float cell = max(u_cellSize, 2.0);
  vec2 cellIndex = floor(ruv / cell);
  vec2 cellCenter = (cellIndex + 0.5) * cell;
  vec2 samplePx = invRot * cellCenter - off;
  vec2 sampleUv = clamp(samplePx / u_resolution, vec2(0.0), vec2(1.0));
  float lum = dot(texture(u_tex, sampleUv).rgb, vec3(0.299, 0.587, 0.114));

  float blotch = risoValueNoise(px * 0.05 + vec2(toneBias * 23.0 + 4.0, u_seedOffset * 4.0)) - 0.5;
  float grain = risoHash(px + vec2(toneBias * 11.0, u_seedOffset * 7.0 + 2.0)) - 0.5;

  float tone = pow(clamp(1.0 - lum, 0.0, 1.0), 1.0 + toneBias * 1.6);
  float coverage = clamp(tone + blotch * 0.5 * u_inkTexture, 0.0, 1.0);
  float radius = coverage * cell * 0.5 * 1.15;

  vec2 posInCell = ruv - cellCenter;
  float dist = length(posInCell);
  float dotMask = 1.0 - smoothstep(radius - 1.0, radius + 1.0, dist);

  return clamp(dotMask * (1.0 - u_inkTexture * 0.3 * (0.5 - grain)), 0.0, 1.0);
}

vec4 modeRiso() {
  vec4 src = texture(u_tex, v_uv);
  float seedBase = u_seed + u_seedOffset * 131.0;

  vec2 off1 = vec2(0.0);
  vec2 off2 = risoOffset(1.0, seedBase);
  vec2 off3 = risoOffset(2.0, seedBase);

  float d1 = risoInk(off1, 15.0, 0.0);
  float d2 = risoInk(off2, 75.0, 0.55);
  float d3 = (u_inkCount > 2.5) ? risoInk(off3, 45.0, 1.0) : 0.0;

  vec3 result = u_paper;
  result = mix(result, result * u_ink1, d1);
  result = mix(result, result * u_ink2, d2);
  if (u_inkCount > 2.5) result = mix(result, result * u_ink3, d3);

  return vec4(clamp(result, 0.0, 1.0), src.a);
}

void main() {
  if (u_mode < 0.5) {
    fragColor = modeMono();
  } else {
    fragColor = modeRiso();
  }
}`,
    },

    dither: {
      id: 'dither',
      name: 'Dither',
      category: 'HALFTONE',
      params: [
        {
          key: 'pattern',
          label: 'Pattern',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'F-S' },
            { value: 1, label: 'Bayer' },
            { value: 2, label: 'Random' },
          ],
        },
        { key: 'pixelSize', label: 'Pixel size', type: 'range', min: 1, max: 20, step: 1, default: 2 },
        {
          key: 'colorMode',
          label: 'Color mode',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: '1-bit' },
            { value: 1, label: 'Color' },
          ],
        },
        { key: 'colorCount', label: 'Color count', type: 'range', min: 2, max: 32, step: 1, default: 24 },
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 255 },
      ],
      presets: {
        // Defaults straight from tooooools.app's dithering panel.
        Tooooools: { pattern: 0, pixelSize: 2, colorMode: 0, colorCount: 24, threshold: 255 },
        'Bayer 1-bit': { pattern: 1, pixelSize: 2, colorMode: 0, colorCount: 24, threshold: 128 },
        'Color cube': { pattern: 0, pixelSize: 3, colorMode: 1, colorCount: 8, threshold: 255 },
      },
      // CPU stage (mutually exclusive with `frag`): downsample by pixelSize ->
      // dither the small grid -> nearest-neighbour upscale (mirrors tooooools'
      // downscaled-canvas approach). The dithering math below (B/W threshold use,
      // palette build, weighted nearest-color, error-diffusion coefficients) is
      // ported line-for-line from tooooools' dithering.js chunk -- see the
      // report for exactly what was ported and any deliberate deviations.
      cpu: function (rgba, w, h, params) {
        const pattern = params.pattern != null ? Math.round(params.pattern) : 0; // 0 F-S, 1 Bayer, 2 Random
        const px = Math.max(1, Math.round(params.pixelSize != null ? params.pixelSize : 2));
        const color = (params.colorMode != null ? params.colorMode : 0) > 0.5;
        const colorCount = Math.max(2, Math.round(params.colorCount != null ? params.colorCount : 24));
        // tooooools computes r = 255/threshold in the B/W F-S path -- guard 0 so
        // a threshold of 0 can't divide-by-zero into a NaN cascade (the same
        // latent bug exists in the original; this only changes the threshold=0
        // edge case, every other value behaves identically to the source).
        const threshold = Math.max(1, params.threshold != null ? params.threshold : 255);

        // tooooools: o=Math.ceil(width/pixelSize), n=Math.ceil(height/pixelSize).
        const sw = Math.max(1, Math.ceil(w / px));
        const sh = Math.max(1, Math.ceil(h / px));

        // ---- palette (tooooools' p()): black + white + an RGB cube, sized so
        // total length reaches colorCount (stops early mid-cube if it overshoots -
        // ported as-is, including its own off-by-one quirks at small colorCount). ----
        function buildPalette(count) {
          const pal = [
            { r: 0, g: 0, b: 0 },
            { r: 255, g: 255, b: 255 },
          ];
          const side = Math.ceil(Math.pow(count - 2, 1 / 3));
          const step = 255 / (side - 1);
          for (let n = 0; n < side && pal.length < count; n++) {
            for (let l = 0; l < side && pal.length < count; l++) {
              for (let a = 0; a < side && pal.length < count; a++) {
                if ((n !== 0 || l !== 0 || a !== 0) && (n !== side - 1 || l !== side - 1 || a !== side - 1)) {
                  pal.push({ r: Math.round(n * step), g: Math.round(l * step), b: Math.round(a * step) });
                }
              }
            }
          }
          return pal;
        }
        // Weighted (.299/.587/.114) squared distance -- tooooools' palette metric.
        function nearest1(r, g, b, pal) {
          let best = pal[0];
          let bestD = Infinity;
          for (let i = 0; i < pal.length; i++) {
            const c = pal[i];
            const dr = (r - c.r) * 0.299;
            const dg = (g - c.g) * 0.587;
            const db = (b - c.b) * 0.114;
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
          return best;
        }
        function nearest2(r, g, b, pal) {
          const scored = pal.map((c) => {
            const dr = (r - c.r) * 0.299;
            const dg = (g - c.g) * 0.587;
            const db = (b - c.b) * 0.114;
            return { c, d: dr * dr + dg * dg + db * db };
          });
          scored.sort((a, b2) => a.d - b2.d);
          return [scored[0].c, scored[1].c];
        }

        // ---- downsample: box average, alpha-composited onto white (matches
        // tooooools' loadPixels averaging). B/W lightness is a PLAIN (r+g+b)/3
        // average here -- the .299/.587/.114 weights only ever appear later, in
        // the palette-distance metric used by Color mode. ----
        const gray = color ? null : new Float32Array(sw * sh);
        const bufR = color ? new Float32Array(sw * sh) : null;
        const bufG = color ? new Float32Array(sw * sh) : null;
        const bufB = color ? new Float32Array(sw * sh) : null;
        const alpha = new Float32Array(sw * sh);

        for (let sy = 0; sy < sh; sy++) {
          const y0 = Math.floor((sy * h) / sh);
          const y1 = Math.min(h, Math.max(y0 + 1, Math.floor(((sy + 1) * h) / sh)));
          for (let sx = 0; sx < sw; sx++) {
            const x0 = Math.floor((sx * w) / sw);
            const x1 = Math.min(w, Math.max(x0 + 1, Math.floor(((sx + 1) * w) / sw)));
            let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) {
              for (let xx = x0; xx < x1; xx++) {
                const i = (yy * w + xx) * 4;
                const a = rgba[i + 3];
                const aN = a / 255;
                sr += rgba[i] * aN + 255 * (1 - aN);
                sg += rgba[i + 1] * aN + 255 * (1 - aN);
                sb += rgba[i + 2] * aN + 255 * (1 - aN);
                sa += a;
                n++;
              }
            }
            if (n === 0) n = 1;
            const si = sy * sw + sx;
            alpha[si] = sa / n / 255;
            if (color) {
              bufR[si] = sr / n;
              bufG[si] = sg / n;
              bufB[si] = sb / n;
            } else {
              gray[si] = (sr + sg + sb) / (3 * n);
            }
          }
        }

        // 4x4 ordered-dither matrix, identical in both the B/W and Color paths.
        const BAYER4 = [
          [0, 8, 2, 10],
          [12, 4, 14, 6],
          [3, 11, 1, 9],
          [15, 7, 13, 5],
        ];

        if (pattern === 0) {
          // Floyd-Steinberg -- tooooools scans plain row-major, top to bottom,
          // left to right. NOT serpentine (checked: diffusion targets are always
          // +x/+y regardless of row parity).
          if (color) {
            const pal = buildPalette(colorCount);
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const idx = y * sw + x;
                const or_ = bufR[idx], og = bufG[idx], ob = bufB[idx];
                const nc = nearest1(or_, og, ob, pal);
                bufR[idx] = nc.r;
                bufG[idx] = nc.g;
                bufB[idx] = nc.b;
                const er = or_ - nc.r, eg = og - nc.g, eb = ob - nc.b;
                const add = (xx, yy, f) => {
                  if (xx < 0 || xx >= sw || yy >= sh) return;
                  const j = yy * sw + xx;
                  bufR[j] = Math.max(0, Math.min(255, bufR[j] + er * f));
                  bufG[j] = Math.max(0, Math.min(255, bufG[j] + eg * f));
                  bufB[j] = Math.max(0, Math.min(255, bufB[j] + eb * f));
                };
                if (x + 1 < sw) add(x + 1, y, 7 / 16);
                if (y + 1 < sh) {
                  if (x > 0) add(x - 1, y + 1, 3 / 16);
                  add(x, y + 1, 5 / 16);
                  if (x + 1 < sw) add(x + 1, y + 1, 1 / 16);
                }
              }
            }
          } else {
            // B/W: threshold rescales the gray value before a FIXED 127 cut
            // (r = 255/threshold), and the propagated error is divided back down
            // by the same factor. Ported byte-for-byte from tooooools -- note it
            // does NOT clamp the propagated error (unlike the Color path above),
            // matching the source exactly (Uint8ClampedArray clamps on final write).
            const r = 255 / threshold;
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const idx = y * sw + x;
                const i = Math.min(255, gray[idx] * r);
                const s = i > 127 ? 255 : 0;
                gray[idx] = s;
                const u = i - s;
                if (x + 1 < sw) gray[idx + 1] += (7 * u) / 16 / r;
                if (x - 1 >= 0 && y + 1 < sh) gray[idx + sw - 1] += (3 * u) / 16 / r;
                if (y + 1 < sh) gray[idx + sw] += (5 * u) / 16 / r;
                if (x + 1 < sw && y + 1 < sh) gray[idx + sw + 1] += (1 * u) / 16 / r;
              }
            }
          }
        } else if (pattern === 1) {
          // Bayer 4x4 ordered dither. NOTE: in tooooools, Threshold has NO effect
          // in Color mode for Bayer/Random (it's UI-hidden there, replaced by
          // Color Count) -- ported as a genuinely unused parameter, not a bug.
          if (color) {
            const pal = buildPalette(colorCount);
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const idx = y * sw + x;
                const two = nearest2(bufR[idx], bufG[idx], bufB[idx], pal);
                const uVal = BAYER4[y % 4][x % 4] / 16;
                const pick = uVal < 0.5 ? two[0] : two[1];
                bufR[idx] = pick.r;
                bufG[idx] = pick.g;
                bufB[idx] = pick.b;
              }
            }
          } else {
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const idx = y * sw + x;
                const i = (threshold / 128) * ((BAYER4[y % 4][x % 4] / 16) * 255);
                gray[idx] = gray[idx] > i ? 255 : 0;
              }
            }
          }
        } else {
          // Random / white-noise threshold. tooooools rolls Math.random() here,
          // re-rolling every render; RSTR's preview==batch invariant needs
          // determinism, so the same uniform 0..1 comes from a coordinate hash
          // instead (identical distribution, stable across renders).
          const hash = (x, y) => {
            const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
            return s - Math.floor(s);
          };
          if (color) {
            const pal = buildPalette(colorCount);
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const idx = y * sw + x;
                const two = nearest2(bufR[idx], bufG[idx], bufB[idx], pal);
                const pick = hash(x, y) < 0.5 ? two[0] : two[1];
                bufR[idx] = pick.r;
                bufG[idx] = pick.g;
                bufB[idx] = pick.b;
              }
            }
          } else {
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const idx = y * sw + x;
                const a = threshold * hash(x, y) * 2;
                gray[idx] = gray[idx] > a ? 255 : 0;
              }
            }
          }
        }

        // Nearest-neighbour upscale back to full size.
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
          for (let x = 0; x < w; x++) {
            const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
            const si = sy * sw + sx;
            const o = (y * w + x) * 4;
            if (color) {
              out[o] = bufR[si];
              out[o + 1] = bufG[si];
              out[o + 2] = bufB[si];
            } else {
              const g = gray[si];
              out[o] = g;
              out[o + 1] = g;
              out[o + 2] = g;
            }
            out[o + 3] = alpha[si] * 255;
          }
        }
        return out;
      },
    },

    stipple: {
      id: 'stipple',
      name: 'Stipple',
      category: 'HALFTONE',
      params: [
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 128 },
        {
          key: 'gridType',
          label: 'Grid type',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Regular' },
            { value: 1, label: 'Benday' },
          ],
        },
        { key: 'gridAngle', label: 'Grid angle', type: 'range', min: -90, max: 90, step: 1, default: 0 },
        { key: 'xSquares', label: 'X squares', type: 'range', min: 1, max: 100, step: 1, default: 90 },
        { key: 'ySquares', label: 'Y squares', type: 'range', min: 1, max: 100, step: 1, default: 90 },
        { key: 'minWidth', label: 'Min square width', type: 'range', min: 0, max: 50, step: 1, default: 1 },
        { key: 'maxWidth', label: 'Max square width', type: 'range', min: 0, max: 50, step: 1, default: 4 },
      ],
      presets: {
        // Defaults straight from tooooools.app's stipping panel.
        Tooooools: { threshold: 128, gridType: 0, gridAngle: 0, xSquares: 90, ySquares: 90, minWidth: 1, maxWidth: 4 },
        Lines: { threshold: 160, gridType: 0, gridAngle: 0, xSquares: 24, ySquares: 90, minWidth: 1, maxWidth: 12 },
        Benday: { threshold: 150, gridType: 1, gridAngle: 15, xSquares: 45, ySquares: 45, minWidth: 1, maxWidth: 6 },
      },
      // Single-pass frag: ported from tooooools' stipping.js chunk. Their p5
      // sketch loops mark-by-mark (grid stepped in ~cell-size increments,
      // rotated, sampled, sized, drawn); here each fragment instead resolves
      // which rotated cell it falls in and evaluates the same size/coverage
      // math analytically. See the report for the exact px-sizing formula
      // ported and the one asymmetry (only width is brightness-mapped) kept
      // intentionally.
      frag: `${HEAD}
uniform float u_threshold;
uniform float u_gridType;
uniform float u_gridAngle;
uniform float u_xSquares;
uniform float u_ySquares;
uniform float u_minWidth;
uniform float u_maxWidth;

void main() {
  float a = radians(u_gridAngle);
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  mat2 invRot = mat2(cos(a), -sin(a), sin(a), cos(a));

  // tooooools shrinks the (pre-rotation) grid by n = |cos|+|sin| so a rotated
  // grid still covers the canvas at roughly the same density regardless of
  // angle: l = height/ySquares/n, o = width/xSquares/n. Absolute mark widths
  // (in px) get the same /n compensation further down.
  float n = abs(cos(a)) + abs(sin(a));
  float cellX = u_resolution.x / max(u_xSquares, 1.0) / n;
  float cellY = u_resolution.y / max(u_ySquares, 1.0) / n;
  vec2 cellSize = vec2(cellX, cellY);

  vec2 uv = v_uv * u_resolution;
  vec2 ruv = rot * uv;
  vec2 cellIndex = floor(ruv / cellSize);

  // Benday: offset alternate rows by half a cell in X (tooooools: m = (cellW-.1)/2
  // * (floor(rowCoord/rowStep) % 2), i.e. a half-cellwidth brick offset per row).
  float rowOffset = 0.0;
  if (u_gridType > 0.5) {
    rowOffset = mod(cellIndex.y, 2.0) * 0.5;
  }
  vec2 cellCenterRotated = (cellIndex + vec2(0.5 + rowOffset, 0.5)) * cellSize;
  vec2 cellCenterOriginal = invRot * cellCenterRotated;
  vec2 sampleUv = clamp(cellCenterOriginal / u_resolution, vec2(0.0), vec2(1.0));
  vec3 cellColor = texture(u_tex, sampleUv).rgb;

  // tooooools' lightness is a PLAIN (r+g+b)/3 average of the sampled pixel --
  // NOT a luminance-weighted average (that weighting only shows up in their
  // dithering palette-distance metric, not here).
  float lum = (cellColor.r + cellColor.g + cellColor.b) / 3.0;
  float thr = u_threshold / 255.0;

  // Exact tooooools size map (their p5 map(w, 0, threshold, maxWidth, minWidth)):
  // darker-than-threshold cells map linearly from maxWidth (at lum=0) down to
  // minWidth (at lum=threshold); at/above threshold the mark is pinned to
  // minWidth. Sizes are ABSOLUTE PIXELS at output resolution, not cell fractions.
  float markWidthPx;
  if (lum < thr) {
    float t = thr > 0.0001 ? clamp(lum / thr, 0.0, 1.0) : 0.0;
    markWidthPx = mix(u_maxWidth, u_minWidth, t);
  } else {
    markWidthPx = u_minWidth;
  }
  // tooooools bumps sizes above 1px by +0.05 (their "x>1 ? x+0.05 : x"), then
  // applies the same /n rotation compensation as the grid cells.
  markWidthPx = (markWidthPx > 1.0 ? markWidthPx + 0.05 : markWidthPx) / n;

  // Only the WIDTH (the X-local/xSquares axis) is brightness-mapped; the
  // HEIGHT is always the full (rotation-compensated) cell height, unconditionally
  // -- ported as-is: tooooools' rect() call uses a size-mapped width but a fixed
  // cell-height, i.e. it draws variable-width BARS, not variable-size squares/dots.
  float halfW = markWidthPx * 0.5;

  vec2 posInCell = ruv - cellCenterRotated;
  vec2 d = abs(posInCell);
  float mx = 1.0 - smoothstep(halfW - 0.75, halfW + 0.75, d.x);
  // No Y falloff: the bar IS the full cell height, and each fragment belongs to
  // exactly one cell, so an antialiased Y edge would fade to 0.5 at the cell
  // border with no neighbour to blend against -- a grey seam every cellY px.
  // tooooools avoids it by drawing overlapping rect()s onto a canvas; we can't.
  float mask = mx;

  vec3 outColor = mix(vec3(1.0), vec3(0.0), mask);
  fragColor = vec4(outColor, texture(u_tex, v_uv).a);
}`,
    },

    // Merged 2026-07-11 (backlog v2.1): the former standalone `dots` / `edge`
    // / `dotpattern` effects collapsed into ONE, mode-switched via the `mode`
    // select. `showIf` (ui.js) hides params the current mode doesn't read;
    // src/pipeline.js's uniform-upload loop is unaware of showIf and still
    // uploads every param as a uniform every frame regardless of mode.
    // `default: 0` on `mode` is load-bearing: an old `dots` style code has no
    // `mode` key, so it defaults to 0 and renders byte-identical to the
    // pre-merge `dots` effect. Old `edge` / `dotpattern` LAYERS are migrated
    // to `{ effect: 'dots', mode: 1|2 }` in src/preset.js (validatePreset),
    // upstream of the unknown-effect drop.
    dots: {
      id: 'dots',
      name: 'Dots',
      category: 'HALFTONE',
      params: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Dots' },
            { value: 1, label: 'Edge' },
            { value: 2, label: 'Pattern' },
          ],
        },
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 128, showIf: { key: 'mode', in: [0, 1, 2] } },
        {
          key: 'gridType',
          label: 'Grid type',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Regular' },
            { value: 1, label: 'Staggered' },
          ],
          showIf: { key: 'mode', in: [0, 2] },
        },
        { key: 'gridAngle', label: 'Grid angle', type: 'range', min: -45, max: 45, step: 1, default: 0, showIf: { key: 'mode', in: [0] } },
        { key: 'minDotSize', label: 'Min dot size', type: 'range', min: 0, max: 50, step: 1, default: 1, showIf: { key: 'mode', in: [0, 1] } },
        { key: 'maxDotSize', label: 'Max dot size', type: 'range', min: 0, max: 50, step: 1, default: 10, showIf: { key: 'mode', in: [0, 1] } },
        { key: 'cornerRadius', label: 'Corner radius', type: 'range', min: 0, max: 20, step: 1, default: 4, showIf: { key: 'mode', in: [0, 1] } },
        { key: 'stepSize', label: 'Step size', type: 'range', min: 3, max: 20, step: 1, default: 8, showIf: { key: 'mode', in: [0, 1] } },
        { key: 'noise', label: 'Noise', type: 'range', min: 0, max: 20, step: 1, default: 2, showIf: { key: 'mode', in: [0] } },
        { key: 'spacing', label: 'Spacing', type: 'range', min: 2, max: 100, step: 1, default: 12, showIf: { key: 'mode', in: [2] } },
        { key: 'scale', label: 'Dot scale', type: 'range', min: 1, max: 100, step: 1, default: 70, showIf: { key: 'mode', in: [2] } },
      ],
      // Ranges are the UNION of the pre-merge ones (edge capped dot size at
      // 40, dots at 50 -> kept 50). Defaults are dots' old defaults so an old
      // `dots` code (mode absent -> 0) is byte-identical; edge's old defaults
      // (threshold 255 / minDotSize 0 / maxDotSize 12 / cornerRadius 8 /
      // stepSize 5) live on in the "Edge" preset below, not as fresh-pick
      // defaults. gridType's label changed Benday/Brick -> "Staggered" but
      // value 1 still means "stagger" in both modes' shaders -- no value
      // remap needed.
      presets: {
        Dots: { mode: 0, threshold: 128, gridType: 0, gridAngle: 0, minDotSize: 1, maxDotSize: 10, cornerRadius: 4, stepSize: 8, noise: 2 },
        Benday: { mode: 0, threshold: 160, gridType: 1, gridAngle: 0, minDotSize: 0, maxDotSize: 8, cornerRadius: 20, stepSize: 6, noise: 0 },
        'Rotated Circles': { mode: 0, threshold: 150, gridType: 0, gridAngle: 15, minDotSize: 0, maxDotSize: 14, cornerRadius: 20, stepSize: 10, noise: 4 },
        Edge: { mode: 1, threshold: 255, minDotSize: 0, maxDotSize: 12, cornerRadius: 8, stepSize: 5 },
        'Edge Fine': { mode: 1, threshold: 90, minDotSize: 0, maxDotSize: 6, cornerRadius: 0, stepSize: 3 },
        'Edge Bold': { mode: 1, threshold: 140, minDotSize: 0, maxDotSize: 20, cornerRadius: 20, stepSize: 8 },
        Pattern: { mode: 2, threshold: 128, gridType: 0, spacing: 12, scale: 70 },
        'Pattern Brick': { mode: 2, threshold: 128, gridType: 1, spacing: 16, scale: 80 },
        'Pattern Coarse': { mode: 2, threshold: 128, gridType: 0, spacing: 24, scale: 60 },
      },
      // ONE frag, three mode bodies. Each body is the pre-merge shader's old
      // main() taken verbatim -- only renamed to a vec4-returning function
      // (`fragColor = vec4(...); }` -> `return vec4(...); }`) -- pixel output
      // is unchanged. File-scope helpers are declared once; sdRoundedBox was
      // character-for-character identical in the old dots and edge shaders
      // and is deduped here.
      frag: `${HEAD}
uniform float u_mode;
uniform float u_threshold;
uniform float u_gridType;
uniform float u_gridAngle;
uniform float u_minDotSize;
uniform float u_maxDotSize;
uniform float u_cornerRadius;
uniform float u_stepSize;
uniform float u_noise;
uniform float u_spacing;
uniform float u_scale;

// Rounded-box SDF. halfSize is the FULL half-extent of the box (zero level
// sits at abs(p)=halfSize on-axis); r rounds the corners within that extent.
// Shared by modeDots() and modeEdge() -- identical in both pre-merge shaders.
float sdRoundedBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Deterministic per-cell hash standing in for tooooools' Perlin-noise
// displacement (u_seed keeps it stable across re-renders of the same image).
// modeDots() only.
vec2 hash2(vec2 p) {
  p = p + u_seed * 13.0;
  float n1 = sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453;
  float n2 = sin(dot(p, vec2(39.3468, 11.1350))) * 24634.6345;
  return vec2(fract(n1), fract(n2));
}

// tooooools blends each channel toward white by (1 - alpha) then averages
// R/G/B (NOT luminance-weighted) — reproduced exactly here. modeEdge() only.
float sampleAvg(vec2 px) {
  vec2 uv = clamp((px + 0.5) / u_resolution, vec2(0.0), vec2(1.0));
  vec4 c = texture(u_tex, uv);
  float avg = (c.r + c.g + c.b) / 3.0;
  return mix(1.0, avg, c.a);
}

// Exact 3x3 Sobel operator ported from the tooooools chunk (Gx/Gy kernels
// and the sqrt(Gx^2+Gy^2) magnitude are bit-for-bit the same shape). modeEdge() only.
float sobelMag(vec2 centerPx) {
  float gx = 0.0;
  float gy = 0.0;
  float m;
  m = sampleAvg(centerPx + vec2(-1.0, -1.0)); gx += -1.0 * m; gy += -1.0 * m;
  m = sampleAvg(centerPx + vec2( 0.0, -1.0));                 gy += -2.0 * m;
  m = sampleAvg(centerPx + vec2( 1.0, -1.0)); gx +=  1.0 * m; gy += -1.0 * m;
  m = sampleAvg(centerPx + vec2(-1.0,  0.0)); gx += -2.0 * m;
  m = sampleAvg(centerPx + vec2( 1.0,  0.0)); gx +=  2.0 * m;
  m = sampleAvg(centerPx + vec2(-1.0,  1.0)); gx += -1.0 * m; gy +=  1.0 * m;
  m = sampleAvg(centerPx + vec2( 0.0,  1.0));                 gy +=  2.0 * m;
  m = sampleAvg(centerPx + vec2( 1.0,  1.0)); gx +=  1.0 * m; gy +=  1.0 * m;
  return sqrt(gx * gx + gy * gy);
}

// ---- mode 0: Dots (pre-merge dots effect, verbatim) ----
vec4 modeDots() {
  float a = radians(u_gridAngle);
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  mat2 invRot = mat2(cos(a), -sin(a), sin(a), cos(a));
  // tooooools divides mark size by |cos|+|sin| so the rotated square's
  // axis-aligned footprint stays consistent regardless of grid angle.
  float norm = abs(cos(a)) + abs(sin(a));

  vec2 center = u_resolution * 0.5;
  float step_ = max(u_stepSize, 1.0);
  vec2 cellSize = vec2(step_);

  vec2 uv = v_uv * u_resolution;
  vec2 ruv = rot * (uv - center);
  vec2 cellIndex = floor(ruv / cellSize);

  // Benday: offset alternate rows by half a cell in X (same trick as stipple).
  float rowOffset = 0.0;
  if (u_gridType > 0.5) {
    rowOffset = mod(cellIndex.y, 2.0) * 0.5;
  }
  vec2 cellCenterRotated = (cellIndex + vec2(0.5 + rowOffset, 0.5)) * cellSize;

  // Per-cell jitter: tooooools offsets each dot's world-space position by
  // Perlin noise sampled at that position; we approximate with a hash of
  // the cell index (single-pass, deterministic, no continuous noise needed).
  vec2 jitter = vec2(0.0);
  if (u_noise > 0.0) {
    vec2 h = hash2(cellIndex);
    jitter = (h - 0.5) * 2.0 * u_noise;
  }
  vec2 jitteredCenterRotated = cellCenterRotated + jitter;

  // Sample brightness at the (jittered) cell center, like tooooools samples
  // brightness at the dot's final displaced position.
  vec2 cellCenterScreen = invRot * jitteredCenterRotated + center;
  vec2 sampleUv = clamp(cellCenterScreen / u_resolution, vec2(0.0), vec2(1.0));
  vec3 cellColor = texture(u_tex, sampleUv).rgb;
  // tooooools' lightness is a PLAIN (r+g+b)/3 average (same helper as
  // stipple/dither) -- not luminance-weighted.
  float lum255 = (cellColor.r + cellColor.g + cellColor.b) / 3.0 * 255.0;

  // tooooools: k = g<threshold ? map(g,0,threshold,maxDotSize,minDotSize) : minDotSize
  float size;
  if (lum255 < u_threshold) {
    float t = clamp(lum255 / max(u_threshold, 0.0001), 0.0, 1.0);
    size = mix(u_maxDotSize, u_minDotSize, t);
  } else {
    size = u_minDotSize;
  }
  size = size / max(norm, 0.0001);

  vec2 posInCell = ruv - jitteredCenterRotated;
  float half_ = size * 0.5;
  float cr = min(u_cornerRadius, half_);
  // sdRoundedBox's halfSize is the FULL half-extent (its zero level sits at
  // abs(p)=halfSize on-axis); half_-cr would shrink the mark by 2*cr and
  // collapse it entirely once cornerRadius >= half the size.
  float d = sdRoundedBox(posInCell, vec2(half_), cr);
  float mask = 1.0 - smoothstep(-0.75, 0.75, d);

  vec3 outColor = mix(vec3(1.0), vec3(0.0), mask);
  return vec4(outColor, texture(u_tex, v_uv).a);
}

// ---- mode 1: Edge (pre-merge edge effect, verbatim) ----
vec4 modeEdge() {
  vec2 uv = v_uv * u_resolution;
  float step_ = max(u_stepSize, 1.0);

  // tooooools scans an UNROTATED grid of sample points (a,n) every stepSize
  // px and, when the Sobel magnitude there exceeds threshold, draws a square
  // anchored at that grid point (top-left corner, like their rect(a,n,l,l)).
  // Same one-cell-only simplification as stipple/dots: a mark that would be
  // large enough to bleed into a neighboring cell is not modeled as bleeding.
  vec2 cellIndex = floor(uv / step_);
  vec2 gridPoint = cellIndex * step_;
  vec2 samplePx = clamp(gridPoint, vec2(1.0), u_resolution - vec2(2.0));

  float mag = sobelMag(samplePx);
  float thr = u_threshold / 255.0;

  float mask = 0.0;
  if (mag > thr) {
    // tooooools: l = map(mag, threshold, 255, minDotSize, maxDotSize), then clamp.
    float t = clamp((mag - thr) / max(1.0 - thr, 0.0001), 0.0, 1.0);
    float size = clamp(mix(u_minDotSize, u_maxDotSize, t), u_minDotSize, u_maxDotSize);
    vec2 boxCenter = gridPoint + vec2(size * 0.5);
    float half_ = size * 0.5;
    float cr = min(u_cornerRadius, half_);
    // Full half-extent, not half_-cr — see the matching note in modeDots().
    float d = sdRoundedBox(uv - boxCenter, vec2(half_), cr);
    mask = 1.0 - smoothstep(-0.75, 0.75, d);
  }

  vec3 outColor = mix(vec3(1.0), vec3(0.0), mask);
  return vec4(outColor, texture(u_tex, v_uv).a);
}

// ---- mode 2: Pattern (pre-merge dotpattern effect, verbatim) ----
vec4 modePattern() {
  float cell = max(u_spacing, 1.0);
  vec2 uv = v_uv * u_resolution;

  float colOffset = 0.0;
  if (u_gridType > 0.5) {
    colOffset = mod(floor(uv.x / cell), 2.0) * 0.5 * cell;
  }
  vec2 p = vec2(uv.x, uv.y + colOffset);
  vec2 cellCenter = (floor(p / cell) + 0.5) * cell;
  vec2 srcCenter = vec2(cellCenter.x, cellCenter.y - colOffset);
  vec2 sampleUv = clamp(srcCenter / u_resolution, vec2(0.0), vec2(1.0));
  vec3 cellColor = texture(u_tex, sampleUv).rgb;
  float lum = (cellColor.r + cellColor.g + cellColor.b) / 3.0;
  float thr = u_threshold / 255.0;

  float maxSide = cell * clamp(u_scale, 0.0, 100.0) / 100.0;
  float side = 0.0;
  if (lum < thr) {
    float t = thr > 0.0001 ? clamp(lum / thr, 0.0, 1.0) : 0.0;
    side = mix(maxSide, 0.0, t);
  }

  float halfSide = side * 0.5;
  vec2 d = abs(p - cellCenter);
  float mx = 1.0 - smoothstep(halfSide - 0.75, halfSide + 0.75, d.x);
  float my = 1.0 - smoothstep(halfSide - 0.75, halfSide + 0.75, d.y);
  float mask = mx * my;

  vec3 outColor = mix(vec3(1.0), vec3(0.0), mask);
  return vec4(outColor, texture(u_tex, v_uv).a);
}

void main() {
  if (u_mode < 0.5) fragColor = modeDots();
  else if (u_mode < 1.5) fragColor = modeEdge();
  else fragColor = modePattern();
}`,
    },

    patterns: {
      id: 'patterns',
      name: 'Patterns',
      category: 'HALFTONE',
      params: [
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 178 },
        { key: 'gridDensity', label: 'Grid density', type: 'range', min: 10, max: 150, step: 1, default: 49 },
      ],
      presets: {
        Tooooools: { threshold: 178, gridDensity: 49 },
        Fine: { threshold: 200, gridDensity: 110 },
        Bold: { threshold: 140, gridDensity: 20 },
      },
      // CPU stage (needs RSTR.assets.patterns, loaded async by assets.js).
      // Exact port of tooooools' `patterns` sketch:
      //  - the 6 bundled 100x100 tiles are re-sorted by their OWN average
      //    brightness (alpha-blended over white, perceptual-weighted RMS —
      //    same formula tooooools uses when it loads user-uploaded pattern
      //    images), ascending. Sort is computed once and cached on this
      //    function, since the bundled tiles never change.
      //  - grid cell size = min(w,h) / gridDensity; cols/rows cover the
      //    image exactly (last row/col not clipped).
      //  - EACH cell samples exactly ONE source pixel — its top-left corner,
      //    not an area average — then blends it toward white by its own
      //    alpha and averages R/G/B for a 0..255 lightness.
      //  - if that lightness is below threshold, pick tile
      //    floor(lightness / threshold * 6) (clamped) from the sorted array
      //    and stamp its 100x100 tile scaled to fill the cell; cells at or
      //    above threshold are left as bare (white) background.
      // Row 0 of `rgba` is the BOTTOM of the image (WebGL readback), but the
      // grid/tiles have no left-right/up-down asymmetry themselves — the
      // buffer is flipped to top-down before sampling only so the threshold
      // mapping lines up with what's actually light/dark on screen, then
      // flipped back on the way out.
      cpu: function patternsCpu(rgba, w, h, params) {
        const assets = RSTR.assets;
        if (!assets || !assets.patterns || assets.patterns.length === 0) return rgba;

        const threshold = params.threshold != null ? params.threshold : 178;
        const gridDensity = Math.max(1, params.gridDensity != null ? params.gridDensity : 49);

        // Sort tiles by average brightness ascending (cached: bundled tiles
        // are static, so this only needs to run once per page load).
        if (patternsCpu._sortedFor !== assets.patterns) {
          const ranked = assets.patterns.map(function (imgData) {
            const d = imgData.data;
            let sum = 0;
            const n = imgData.width * imgData.height;
            for (let i = 0; i < d.length; i += 4) {
              const a = d[i + 3] / 255;
              const r = d[i] * a + 255 * (1 - a);
              const g = d[i + 1] * a + 255 * (1 - a);
              const b = d[i + 2] * a + 255 * (1 - a);
              sum += Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b);
            }
            return { imgData: imgData, brightness: sum / n };
          });
          ranked.sort(function (a, b) { return a.brightness - b.brightness; });
          // Each sorted tile becomes a small canvas (ImageData itself can't
          // be scaled/drawn — canvas drawImage needs an image-like source).
          patternsCpu._sorted = ranked.map(function (entry) {
            const c = document.createElement('canvas');
            c.width = entry.imgData.width;
            c.height = entry.imgData.height;
            c.getContext('2d').putImageData(entry.imgData, 0, 0);
            return c;
          });
          patternsCpu._sortedFor = assets.patterns;
        }
        const tiles = patternsCpu._sorted;
        const tileCount = tiles.length;

        // Flip source to top-down (row 0 = top) for cell sampling.
        const topDown = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          topDown.set(rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        }

        const cell = Math.min(w, h) / gridDensity;
        const cols = Math.ceil(w / cell);
        const rows = Math.ceil(h / cell);
        const cellW = w / cols;
        const cellH = h / rows;

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = w;
        srcCanvas.height = h;
        srcCanvas.getContext('2d').putImageData(new ImageData(topDown, w, h), 0, 0);

        const outCanvas = document.createElement('canvas');
        outCanvas.width = w;
        outCanvas.height = h;
        const outCtx = outCanvas.getContext('2d');
        // tooooools clears to transparent and never paints a background —
        // but its own brightness math (above) assumes alpha is blended over
        // WHITE, so a white base is what the tool visually renders on.
        outCtx.fillStyle = '#ffffff';
        outCtx.fillRect(0, 0, w, h);

        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const sx = Math.floor(col * cellW);
            const sy = Math.floor(row * cellH);
            const i = (sy * w + sx) * 4;
            const a = topDown[i + 3] / 255;
            const r = topDown[i] * a + 255 * (1 - a);
            const g = topDown[i + 1] * a + 255 * (1 - a);
            const b = topDown[i + 2] * a + 255 * (1 - a);
            const lum = (r + g + b) / 3;
            if (lum < threshold) {
              const idx = Math.min(tileCount - 1, Math.max(0, Math.floor((lum / threshold) * tileCount)));
              outCtx.drawImage(tiles[idx], col * cellW, row * cellH, cellW, cellH);
            }
          }
        }

        const outData = outCtx.getImageData(0, 0, w, h).data;

        // The canvas is opaque (white backdrop + opaque tile stamps), so
        // outData's alpha is 255 everywhere regardless of the source's own
        // alpha. Restore the SOURCE pixel's alpha at each position — same
        // coordinate frame as topDown (top-down, w*h*4) — without touching
        // the RGB this stage just painted.
        for (let i = 3; i < outData.length; i += 4) {
          outData[i] = topDown[i];
        }

        // Flip back to bottom-up before returning.
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          out.set(outData.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
        }
        return out;
      },
    },

    gradients: {
      id: 'gradients',
      name: 'Gradients',
      category: 'HALFTONE',
      params: [
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 128 },
        { key: 'stepSize', label: 'Step size', type: 'range', min: 15, max: 100, step: 1, default: 15 },
        {
          key: 'shapeType',
          label: 'Shape type',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Rect' },
            { value: 1, label: 'Ellipse' },
          ],
        },
      ],
      presets: {
        Tooooools: { threshold: 128, stepSize: 15, shapeType: 0 },
        'Fine Bars': { threshold: 100, stepSize: 15, shapeType: 0 },
        Circles: { threshold: 160, stepSize: 30, shapeType: 1 },
      },
      // CPU stage (mutually exclusive with `frag`): the tooooools algorithm is a
      // sequential run-length scan — each stepSize-tall horizontal band is split
      // into VARIABLE-width segments wherever the running column brightness
      // jumps past threshold, and each segment is drawn as a rect/ellipse filled
      // with a fixed white(left)->black(right) ramp. Stateful left-to-right scan
      // => cannot be a single parallel frag pass, so it runs on the CPU (exact
      // port of the chunk, drawn via an offscreen 2D canvas).
      cpu: function (rgba, w, h, params) {
        let threshold = params.threshold != null ? params.threshold : 128;
        // Faithful port of the chunk's `i.lightnessThreshold || 20` — a JS
        // falsy quirk: threshold 0 behaves as 20.
        threshold = threshold || 20;
        const step = Math.max(1, Math.round(params.stepSize != null ? params.stepSize : 15));
        const ellipse = (params.shapeType != null ? params.shapeType : 0) > 0.5;

        // Input row 0 = BOTTOM of the image (WebGL readPixels orientation), but
        // the original scan is anchored at the TOP (bands run top-down and the
        // partial band lands at the bottom). Flip to top-down, run the exact
        // original scan, flip back at the end.
        const src = new Uint8ClampedArray(rgba.length);
        for (let y = 0; y < h; y++) {
          src.set(rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        // tooooools p5-clear()s to transparent over the site's white page; in
        // rect mode the segments tile the whole canvas anyway, in ellipse mode
        // the gaps read as white. Solid white background here.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);

        // Band loop: `for (l = 0; l < height/step; l++)` — bands every stepSize
        // px from the top, INCLUDING a partial band past the bottom edge.
        for (let band = 0; band * step < h; band++) {
          const y0 = band * step;
          const segs = [];

          if (y0 + step > h) {
            // Partial bottom band: the chunk reads pixels past the buffer ->
            // NaN column averages -> `abs(last - d) > threshold` never fires ->
            // the band ends up as ONE full-width segment (drawn clipped below).
            segs.push({ start: 0, end: w });
          } else {
            // Exact segmentation scan from the chunk: per column, average the
            // band's rows of per-pixel (lerp(255,R,a)+lerp(255,G,a)+lerp(255,B,a))/3
            // (channels blended toward white by alpha, plain R/G/B mean — not
            // luminance-weighted); split when the brightness jumps past threshold.
            let last = 0; // starts at 0 (black) -> a bright first column emits a zero-width segment
            let segStart = 0;
            for (let x = 0; x < w; x++) {
              let u = 0;
              for (let y = y0; y < y0 + step; y++) {
                const i = (x + y * w) * 4;
                const a = src[i + 3] / 255;
                u += (255 + (src[i] - 255) * a + 255 + (src[i + 1] - 255) * a + 255 + (src[i + 2] - 255) * a) / 3;
              }
              const d = u / step;
              if (Math.abs(last - d) > threshold) {
                segs.push({ start: segStart, end: x });
                segStart = x;
                last = d;
              }
            }
            // Every band always closes with a segment reaching the right edge.
            segs.push({ start: segStart, end: w });
          }

          for (let k = 0; k < segs.length; k++) {
            const sw = segs[k].end - segs[k].start;
            if (sw <= 0) continue; // zero-width segments are invisible in the original too
            // The fill is their 1px gradient texture stretched across the
            // segment (textureMode NORMAL): full white->black ramp per segment,
            // regardless of segment width or its sampled brightness.
            const grad = ctx.createLinearGradient(segs[k].start, 0, segs[k].end, 0);
            grad.addColorStop(0, '#fff');
            grad.addColorStop(1, '#000');
            ctx.fillStyle = grad;
            if (ellipse) {
              // ellipseMode(CORNER): ellipse inscribed in the segment's
              // start/y0/sw/step bounding box, ramp across the same box.
              ctx.beginPath();
              ctx.ellipse(segs[k].start + sw / 2, y0 + step / 2, sw / 2, step / 2, 0, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.fillRect(segs[k].start, y0, sw, step);
            }
          }
        }

        // The canvas is opaque (white background + solid-fill gradient
        // segments), so img's alpha is 255 everywhere regardless of the
        // source's own alpha. Restore the SOURCE pixel's alpha at each
        // position — same coordinate frame as `src` (top-down, w*h*4) —
        // without touching the RGB this stage just painted.
        const img = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < img.length; i += 4) {
          img[i] = src[i];
        }

        // Flip back to bottom-up before returning.
        const out = new Uint8ClampedArray(rgba.length);
        for (let y = 0; y < h; y++) {
          out.set(img.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        }
        return out;
      },
    },

    crosshatch: {
      id: 'crosshatch',
      name: 'Crosshatch',
      category: 'HALFTONE',
      params: [
        { key: 'spacing', label: 'Spacing', type: 'range', min: 4, max: 40, step: 1, default: 10 },
        { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, default: 45 },
        { key: 'layers', label: 'Layers', type: 'range', min: 1, max: 4, step: 1, default: 3 },
      ],
      presets: {
        Sketch: { spacing: 8, angle: 45, layers: 2 },
        Engraving: { spacing: 6, angle: 45, layers: 4 },
        Loose: { spacing: 16, angle: 30, layers: 2 },
      },
      frag: `${HEAD}
uniform float u_spacing;
uniform float u_angle;
uniform float u_layers;

float hatchLine(vec2 uv, float angleDeg) {
  float a = radians(angleDeg);
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 ruv = rot * uv;
  return ruv.y;
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec2 uv = v_uv * u_resolution;
  float spacing = max(u_spacing, 2.0);
  int layers = int(clamp(u_layers, 1.0, 4.0));
  float thickness = spacing * 0.25;
  float ink = 0.0;

  float l0 = mod(hatchLine(uv, u_angle), spacing);
  if (lum < 0.8) ink = max(ink, 1.0 - smoothstep(thickness - 1.0, thickness + 1.0, min(l0, spacing - l0)));
  if (layers >= 2 && lum < 0.6) {
    float l1 = mod(hatchLine(uv, u_angle + 90.0), spacing);
    ink = max(ink, 1.0 - smoothstep(thickness - 1.0, thickness + 1.0, min(l1, spacing - l1)));
  }
  if (layers >= 3 && lum < 0.4) {
    float l2 = mod(hatchLine(uv, u_angle + 45.0), spacing);
    ink = max(ink, 1.0 - smoothstep(thickness - 1.0, thickness + 1.0, min(l2, spacing - l2)));
  }
  if (layers >= 4 && lum < 0.2) {
    float l3 = mod(hatchLine(uv, u_angle - 45.0), spacing);
    ink = max(ink, 1.0 - smoothstep(thickness - 1.0, thickness + 1.0, min(l3, spacing - l3)));
  }

  vec3 outColor = mix(vec3(1.0), vec3(0.0), ink);
  fragColor = vec4(outColor, c.a);
}`,
    },

    ascii: {
      id: 'ascii',
      name: 'ASCII',
      category: 'HALFTONE',
      params: [
        { key: 'columns', label: 'Columns', type: 'range', min: 10, max: 200, step: 1, default: 48 },
        { key: 'rows', label: 'Rows', type: 'range', min: 10, max: 150, step: 1, default: 26 },
        { key: 'characterSet', label: 'Character Set', type: 'text', default: ' .:-=+*#%@' },
        {
          key: 'comments',
          label: 'Comments',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Off' },
            { value: 1, label: 'On' },
          ],
        },
        {
          key: 'showBorders',
          label: 'Show Borders',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Off' },
            { value: 1, label: 'On' },
          ],
        },
        {
          key: 'borderStyle',
          label: 'Border',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Single' },
            { value: 1, label: 'Double' },
            { value: 2, label: 'Thick' },
          ],
        },
      ],
      presets: {
        Tooooools: { columns: 48, rows: 26, characterSet: ' .:-=+*#%@', comments: 0, showBorders: 0, borderStyle: 0 },
        Bordered: { columns: 48, rows: 26, characterSet: ' .:-=+*#%@', comments: 0, showBorders: 1, borderStyle: 2 },
        'Code Comment': { columns: 60, rows: 32, characterSet: ' .:-=+*#%@', comments: 1, showBorders: 1, borderStyle: 0 },
      },
      // CPU stage (mutually exclusive with `frag`) — canvas text rendering.
      // Row 0 of `rgba` is the BOTTOM of the image (WebGL readPixels
      // orientation). tooooools samples/draws in normal top-down image space,
      // so: (1) flip the input to top-down into `top`, (2) do everything
      // (sampling, grid build, canvas draw) in that normal space, (3) flip the
      // canvas result back to bottom-up before returning — the pipeline
      // re-uploads the buffer unflipped. Both flips use the same helper loop,
      // so they cancel out exactly.
      cpu: function (rgba, w, h, params) {
        const columns = Math.max(10, Math.round(params.columns != null ? params.columns : 48));
        const rows = Math.max(10, Math.round(params.rows != null ? params.rows : 26));
        let charSet = params.characterSet;
        if (typeof charSet !== 'string' || charSet.length === 0) charSet = ' .:-=+*#%@';
        const comments = (params.comments != null ? params.comments : 0) > 0.5;
        const showBorders = (params.showBorders != null ? params.showBorders : 0) > 0.5;
        const borderStyleIdx = Math.round(params.borderStyle != null ? params.borderStyle : 0);

        // Exact box-drawing sets from tooooools' border map (single/double/thick;
        // they also define "rounded" but it's never exposed as a UI option).
        const BORDERS = [
          { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }, // single
          { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }, // double
          { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }, // thick
        ];
        const border = BORDERS[borderStyleIdx] || BORDERS[0];

        const stride = w * 4;

        // --- (1) flip input to top-down working space ---
        const top = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          top.set(rgba.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
        }

        // Border adds a 1-cell ring (both dims); Comments adds 2 whole text
        // rows (top/bottom only) — reserve both from the content grid so the
        // FINAL grid always comes out to exactly columns x rows, keeping
        // cell-size predictable regardless of which toggles are on (tooooools'
        // own border/comment wrap is purely additive with no fixed canvas, since
        // their ascii output is a free-flowing text block, not a raster image).
        const bw = showBorders ? 1 : 0;
        const cw = comments ? 1 : 0;
        const contentCols = Math.max(1, columns - 2 * bw);
        const contentRows = Math.max(1, rows - 2 * bw - 2 * cw);

        // --- brightness-sorted character ramp, mirrors tooooools'
        // analyzeCharacterSet: render each unique char black-on-white on a
        // small canvas and rank by average ink coverage (low -> high). Bright
        // source pixels get the lowest-coverage char (usually space), dark
        // source pixels get the highest-coverage char (usually the last one,
        // e.g. '@') — same direction as the chunk's `(1 - avg/255)` mapping.
        const uniqueChars = Array.from(new Set(charSet.split('')));
        const measureCanvas = document.createElement('canvas');
        const AN = 16;
        measureCanvas.width = AN * 2;
        measureCanvas.height = AN * 2;
        const actx = measureCanvas.getContext('2d', { willReadFrequently: true });
        actx.font = AN + 'px monospace';
        actx.textAlign = 'center';
        actx.textBaseline = 'middle';
        const density = new Map();
        for (const ch of uniqueChars) {
          actx.clearRect(0, 0, measureCanvas.width, measureCanvas.height);
          actx.fillStyle = '#fff';
          actx.fillRect(0, 0, measureCanvas.width, measureCanvas.height);
          actx.fillStyle = '#000';
          actx.fillText(ch, measureCanvas.width / 2, measureCanvas.height / 2);
          const d = actx.getImageData(0, 0, measureCanvas.width, measureCanvas.height).data;
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            n++;
            sum += (255 - (d[i] + d[i + 1] + d[i + 2]) / 3) / 255;
          }
          density.set(ch, n > 0 ? sum / n : 0);
        }
        const ramp = uniqueChars.slice().sort((a, b) => density.get(a) - density.get(b));
        const rampLen = Math.max(1, ramp.length);

        // --- sample brightness per content cell, top-left anchored per pixel
        // (matches tooooools' `Math.floor(row*cellH)` / `Math.floor(col*cellW)`
        // sampling — no box averaging) ---
        const srcCellW = w / contentCols;
        const srcCellH = h / contentRows;
        const grid = [];
        for (let ry = 0; ry < contentRows; ry++) {
          const sy = Math.min(h - 1, Math.floor(ry * srcCellH));
          const row = [];
          for (let rx = 0; rx < contentCols; rx++) {
            const sx = Math.min(w - 1, Math.floor(rx * srcCellW));
            const i = (sy * w + sx) * 4;
            const avg = (top[i] + top[i + 1] + top[i + 2]) / 3;
            let idx = Math.floor((1 - avg / 255) * (rampLen - 1));
            idx = Math.max(0, Math.min(rampLen - 1, idx));
            row.push(ramp[idx] || ' ');
          }
          grid.push(row);
        }

        // --- border ring: additive box-drawing frame, exact layout from
        // tooooools' `s()` (topLeft+horizontal*w+topRight / vertical+row+vertical
        // per line / bottomLeft+horizontal*w+bottomRight) ---
        let finalGrid = grid;
        if (showBorders) {
          const width = finalGrid[0] ? finalGrid[0].length : contentCols;
          const topRow = [border.tl, ...Array(width).fill(border.h), border.tr];
          const bottomRow = [border.bl, ...Array(width).fill(border.h), border.br];
          finalGrid = [topRow, ...finalGrid.map((r) => [border.v, ...r, border.v]), bottomRow];
        }

        // --- Comments: tooooools wraps the whole finished text block between
        // a literal "/*" line and a "*/" line (so the copy-pasted ASCII art is
        // a valid block comment). We port that as two extra grid rows, padded
        // with spaces (= background) past the 2 marker characters. ---
        if (comments) {
          const width = finalGrid[0] ? finalGrid[0].length : columns;
          const markerRow = (s) => {
            const r = new Array(width).fill(' ');
            for (let i = 0; i < s.length && i < width; i++) r[i] = s[i];
            return r;
          };
          finalGrid = [markerRow('/*'), ...finalGrid, markerRow('*/')];
        }

        const totalCols = finalGrid[0] ? finalGrid[0].length : columns;
        const totalRows = finalGrid.length || rows;

        // Copyable text (for the editor's COPY TEXT button) — plain grid join,
        // independent of how it gets rasterized below. Last render wins.
        RSTR.asciiText = finalGrid.map((r) => r.join('')).join('\n');

        // --- draw: BLACK text on WHITE bg — tooooools' terminal-display has no
        // color CSS of its own, so it inherits the site's light theme (default
        // black-on-white), and the ink-density ramp (dark pixel -> dense char)
        // is only tonally correct in that polarity.
        //
        // RSTR outputs a full raster buffer, not a DOM terminal — stretch the
        // grid to fill w x h so the ASCII art covers the whole frame and keeps
        // the source aspect (tooooools letterboxes at natural glyph aspect,
        // which leaves wide side margins on landscape images).
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);

        const cellW = w / totalCols;
        const cellH = h / totalRows;
        const lineH = 1.2; // matches tooooools' CSS line-height
        const fontPx = Math.max(1, cellH / lineH);

        ctx.font = fontPx + 'px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#000';
        const naturalAdv = ctx.measureText('M').width;
        const scaleX = cellW / naturalAdv;

        for (let ry = 0; ry < totalRows; ry++) {
          const row = finalGrid[ry];
          for (let rx = 0; rx < totalCols; rx++) {
            const ch = row[rx];
            if (!ch || ch === ' ') continue;
            const cx = (rx + 0.5) * cellW;
            const cy = (ry + 0.5) * cellH;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(scaleX, 1);
            ctx.fillText(ch, 0, 0);
            ctx.restore();
          }
        }

        // --- (3) flip result back to bottom-up, then restore the source
        // alpha channel unchanged (text draw fully overwrites RGB but the
        // pipeline still expects per-pixel alpha to pass through, same as
        // every other full-raster CPU effect) ---
        const imgData = ctx.getImageData(0, 0, w, h).data;
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          out.set(imgData.subarray(y * stride, (y + 1) * stride), (h - 1 - y) * stride);
        }
        for (let i = 3; i < out.length; i += 4) out[i] = rgba[i];
        return out;
      },
    },
  });
})((window.RSTR = window.RSTR || {}));
