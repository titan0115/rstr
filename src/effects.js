// effects.js — the shader registry. Every effect is one fragment-shader pass
// plus a params schema plus a few built-in named param-presets ("starter
// looks"). ui.js and pipeline.js are both driven from this data — adding an
// effect never touches them. Classic script — attaches to window.RSTR.
//
// Entry schema: { id, name, category, params:[...], presets:{Name:{...}}, frag }
// Category order (grouped UI): TONE, HALFTONE, COLOR, DISTORT, STYLIZE.
(function (RSTR) {
  'use strict';

  // Shared uniforms in every fragment shader:
  //   u_tex sampler2D — previous pass (or source image for the first pass)
  //   u_resolution vec2 — image size in px
  //   u_seed float — deterministic noise seed
  // Per-effect uniforms are named `u_<param.key>`.
  const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2 u_resolution;
uniform float u_seed;
`;

  // Deep-clone a param default (or a preset's param bag) so array/object
  // values (e.g. gradientmap's `stops`) are never a shared reference back to
  // the EFFECTS registry literal or another instantiation -- otherwise one
  // layer's in-place edit (drag a stop, delete a stop) would mutate every
  // other layer/instance that applied the same default or named preset.
  // Scalars pass through untouched; JSON clone is fine (params are plain
  // JSON-safe data: numbers, strings, hex colors, {pos,color} stop objects).
  function cloneParamValue(v) {
    return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }

  // Build a 256-entry RGB LUT (Uint8ClampedArray, 3 bytes/entry) from a
  // gradient-stops array: sort by pos, clamp below-first/above-last to their
  // end colors, linearly interpolate RGB between the surrounding stops
  // (equivalent to GLSL mix()) everywhere in between. gradientmap itself has
  // been a GPU `frag` since the 2026-07-13 recolor merge (its shader's own
  // sampleGradient() does the equivalent per-pixel, fed by uniform arrays --
  // see src/pipeline.js's stops-upload code); this LUT now exists purely for
  // the editor's stops-bar paint / double-click-to-add-stop sample (ui.js),
  // which needs a quick 256-wide preview strip and has no GL context of its
  // own to render one.
  function buildGradientLut(stopsIn) {
    let stops = Array.isArray(stopsIn) ? stopsIn.filter((s) => s && typeof s.pos === 'number' && typeof s.color === 'string') : [];
    if (stops.length < 2) {
      stops = [
        { pos: 0, color: '#1a0b2e' },
        { pos: 1, color: '#ff6b35' },
      ];
    }
    const sorted = stops.slice().sort((a, b) => a.pos - b.pos);
    function hex3(hex) {
      let s = String(hex || '#000000').replace('#', '');
      if (s.length === 3) s = s.split('').map((c) => c + c).join('');
      const v = parseInt(s, 16) || 0;
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let t = 0; t < 256; t++) {
      const u = t / 255;
      let c0, c1, f;
      if (u <= first.pos) {
        c0 = c1 = hex3(first.color);
        f = 0;
      } else if (u >= last.pos) {
        c0 = c1 = hex3(last.color);
        f = 0;
      } else {
        let idx = 0;
        for (let k = 0; k < sorted.length - 1; k++) {
          if (u >= sorted[k].pos && u <= sorted[k + 1].pos) {
            idx = k;
            break;
          }
        }
        c0 = hex3(sorted[idx].color);
        c1 = hex3(sorted[idx + 1].color);
        const span = sorted[idx + 1].pos - sorted[idx].pos;
        f = span > 1e-6 ? (u - sorted[idx].pos) / span : 0;
      }
      lut[t * 3] = c0[0] + (c1[0] - c0[0]) * f;
      lut[t * 3 + 1] = c0[1] + (c1[1] - c0[1]) * f;
      lut[t * 3 + 2] = c0[2] + (c1[2] - c0[2]) * f;
    }
    return lut;
  }

  const EFFECTS = {
    // ================= TONE =================
    adjust: {
      id: 'adjust',
      name: 'Adjust',
      category: 'TONE',
      params: [
        { key: 'brightness', label: 'Brightness', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
        { key: 'contrast', label: 'Contrast', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
        { key: 'saturation', label: 'Saturation', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
        { key: 'gamma', label: 'Gamma', type: 'range', min: 0.2, max: 3, step: 0.01, default: 1 },
        { key: 'hue', label: 'Hue', type: 'range', min: 0, max: 360, step: 1, default: 0 },
        { key: 'sharpen', label: 'Sharpen', type: 'range', min: 0, max: 3, step: 0.05, default: 0 },
        // Absorbed from the former standalone `invert` effect (2026-07-13,
        // same precedent as hue/sharpen below): `amount` -> `invert`,
        // `channels` -> `invertChannels`, same 0..1 / 0..3 encodings. Default
        // 0 = identity, so every existing `adjust` style code (no invert
        // keys at all) renders byte-identical.
        { key: 'invert', label: 'Invert', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
        {
          key: 'invertChannels',
          label: 'Invert channels',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'RGB' },
            { value: 1, label: 'Red' },
            { value: 2, label: 'Green' },
            { value: 3, label: 'Blue' },
          ],
        },
      ],
      presets: {
        Punchy: { brightness: 0.05, contrast: 0.35, saturation: 0.3, gamma: 1, hue: 0, sharpen: 0, invert: 0, invertChannels: 0 },
        Faded: { brightness: 0.1, contrast: -0.2, saturation: -0.4, gamma: 1.1, hue: 0, sharpen: 0, invert: 0, invertChannels: 0 },
        Noir: { brightness: 0, contrast: 0.5, saturation: -1, gamma: 1, hue: 0, sharpen: 0, invert: 0, invertChannels: 0 },
      },
      // Absorbed the former standalone `hue` and `sharpen` effects (2026-07):
      // sharpen (spatial, reads the raw source) -> hue rotate -> tone chain.
      // Old adjust style codes lack the new keys -> default 0 -> identity.
      //
      // `invert` (2026-07-13) absorbed the same way -- see the LEGACY_EFFECTS
      // migration in src/preset.js. Placed LAST in the chain (after gamma),
      // not first and not interleaved with the tone block: the old standalone
      // `invert` effect was always its own trailing layer in the stack, so
      // inverting the fully tone-adjusted result (sharpen -> hue -> tone ->
      // invert) is the closest equivalent to "adjust, then invert" as two
      // separate layers -- inverting earlier in the chain (e.g. before
      // brightness/contrast) would give a different image, not just a
      // reordering that happens to look the same. Default 0 is a no-op
      // regardless of position, so this choice doesn't affect the
      // byte-identity guarantee for pre-existing `adjust` codes either way --
      // it only matters for NEW codes that actually use invert.
      frag: `${HEAD}
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_gamma;
uniform float u_hue;
uniform float u_sharpen;
uniform float u_invert;
uniform float u_invertChannels;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 col = c.rgb;
  if (u_sharpen > 0.0) {
    vec2 texel = 1.0 / u_resolution;
    vec3 sum = texture(u_tex, v_uv + vec2(-1.0, 0.0) * texel).rgb
             + texture(u_tex, v_uv + vec2(1.0, 0.0) * texel).rgb
             + texture(u_tex, v_uv + vec2(0.0, -1.0) * texel).rgb
             + texture(u_tex, v_uv + vec2(0.0, 1.0) * texel).rgb;
    col = clamp(col + (col * 4.0 - sum) * u_sharpen, 0.0, 1.0);
  }
  if (u_hue > 0.0) {
    vec3 hsv = rgb2hsv(col);
    hsv.x = fract(hsv.x + u_hue / 360.0);
    col = hsv2rgb(hsv);
  }
  col = col + u_brightness;
  col = (col - 0.5) * (1.0 + u_contrast) + 0.5;
  float gray = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(gray), col, 1.0 + u_saturation);
  col = pow(max(col, 0.0), vec3(1.0 / max(u_gamma, 0.001)));
  if (u_invert > 0.0) {
    vec3 inv = vec3(1.0) - col;
    vec3 target = col;
    if (u_invertChannels < 0.5) target = inv;
    else if (u_invertChannels < 1.5) target.r = inv.r;
    else if (u_invertChannels < 2.5) target.g = inv.g;
    else target.b = inv.b;
    col = mix(col, target, u_invert);
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`,
    },

    levels: {
      id: 'levels',
      name: 'Levels',
      category: 'TONE',
      params: [
        { key: 'blackPoint', label: 'Black point', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'whitePoint', label: 'White point', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
        { key: 'gamma', label: 'Gamma', type: 'range', min: 0.2, max: 3, step: 0.01, default: 1 },
      ],
      presets: {
        'Crush blacks': { blackPoint: 0.1, whitePoint: 1, gamma: 1 },
        'Lift shadows': { blackPoint: 0, whitePoint: 0.9, gamma: 1.3 },
        'High-key': { blackPoint: 0, whitePoint: 0.8, gamma: 0.8 },
      },
      frag: `${HEAD}
uniform float u_blackPoint;
uniform float u_whitePoint;
uniform float u_gamma;

void main() {
  vec4 c = texture(u_tex, v_uv);
  float bp = min(u_blackPoint, u_whitePoint - 0.001);
  float wp = max(u_whitePoint, bp + 0.001);
  vec3 col = clamp((c.rgb - bp) / (wp - bp), 0.0, 1.0);
  col = pow(col, vec3(1.0 / max(u_gamma, 0.001)));
  fragColor = vec4(col, c.a);
}`,
    },

    preprocess: {
      id: 'preprocess',
      name: 'Preprocess',
      category: 'ADJUST',
      // Not a pickable stack effect -- permanently wired into the editor's
      // compact PRE module (see ui.js) and prepended to the render stack
      // whenever state.pre is non-identity. Hidden from the effect picker
      // and the (Gear) settings list; stays a normal, functional EFFECTS
      // entry so old style codes with an explicit `preprocess` mix layer
      // still render, and so its params/defaults remain the single source
      // of truth for RSTR.preset's defaultPre()/normalizePre() helpers.
      internal: true,
      params: [
        { key: 'blur', label: 'Blur', type: 'range', min: 0, max: 10, step: 1, default: 0 },
        { key: 'grain', label: 'Grain', type: 'range', min: 0, max: 1, step: 0.1, default: 0 },
        { key: 'gamma', label: 'Gamma', type: 'range', min: 0.1, max: 2, step: 0.1, default: 1 },
        { key: 'blackPoint', label: 'Black point', type: 'range', min: 0, max: 255, step: 1, default: 0 },
        { key: 'whitePoint', label: 'White point', type: 'range', min: 0, max: 255, step: 1, default: 255 },
      ],
      presets: {
        // Identity -- tooooools.app's shared "Image Preprocessing" block defaults.
        Tooooools: { blur: 0, grain: 0, gamma: 1, blackPoint: 0, whitePoint: 255 },
        'Filmic grain': { blur: 0, grain: 0.2, gamma: 1.3, blackPoint: 20, whitePoint: 235 },
      },
      // CPU stage (mutually exclusive with `frag`): ports tooooools' shared
      // "Image Preprocessing" block -- blur -> grain -> gamma -> levels, in that
      // exact order, with the exact same skip-guards as the original (blur==0,
      // grain==0, gamma===1, blackPoint===0 && whitePoint===255).
      //
      // Blur is a line-for-line port of p5.js's Filters.blurARGB / buildBlurKernel
      // (src/image/filters.js, p5.js v1.9.4:
      // https://raw.githubusercontent.com/processing/p5.js/v1.9.4/src/image/filters.js),
      // itself a port of Processing's PImage blur (toxi, 2005) -- same radius
      // formula (`(r*3.5)|0` clamped to [1,248]), same squared-distance integer
      // kernel, same two-pass (horizontal then vertical) box-of-triangles blur
      // with edge taps cropped-and-renormalized (not clamp-extended). Ported here
      // to operate on separate R/G/B/A channel arrays instead of p5's packed
      // 32-bit ARGB ints -- the arithmetic is identical, only the pixel storage
      // differs. p5's kernel/kernel-mult tables are cached across calls at module
      // scope for performance; that caching is dropped here (rebuilt every call)
      // since this stage is stateless per RSTR's architecture -- it does not change
      // the output. One deliberately unported branch: the original also breaks
      // its outer x/y loop when the *first* kernel tap already falls outside the
      // image (`read >= width` before the tap loop even starts). That can only
      // happen if blurRadius were <= 0, but buildBlurKernel always clamps the
      // radius to >= 1, so for every x < width, read = x - blurRadius < width
      // always holds and that branch is unreachable dead code in the source --
      // omitted here rather than transcribed as inert code.
      //
      // Grain is the one deliberate behavioural deviation: tooooools uses p5's
      // nondeterministic `e.random()` (one draw per pixel, applied equally to
      // R/G/B). RSTR requires preview === batch, so `e.random()` is replaced with
      // the coordinate hash used elsewhere in effects.js
      // (`fract(sin(x*12.9898 + y*78.233) * 43758.5453123)`), still one value per
      // pixel applied equally to R/G/B exactly like the original's
      // `(0.5 - rnd) * grainAmount * 255`.
      cpu: function (rgba, w, h, params) {
        const blur = params.blur != null ? params.blur : 0;
        const grain = params.grain != null ? params.grain : 0;
        const gamma = params.gamma != null ? params.gamma : 1;
        const blackPoint = params.blackPoint != null ? params.blackPoint : 0;
        const whitePoint = params.whitePoint != null ? params.whitePoint : 255;

        // ---- BLUR: p5.js Filters.blurARGB (see comment above) ----
        function buildBlurKernel(r) {
          let radius = (r * 3.5) | 0;
          radius = radius < 1 ? 1 : radius < 248 ? radius : 248;
          const size = (1 + radius) << 1;
          const kernel = new Int32Array(size);
          const mult = new Array(size);
          for (let l = 0; l < size; l++) mult[l] = new Int32Array(256);

          let bki, bm, bmi;
          for (let i = 1, radiusi = radius - 1; i < radius; i++) {
            kernel[radius + i] = kernel[radiusi] = bki = radiusi * radiusi;
            bm = mult[radius + i];
            bmi = mult[radiusi--];
            for (let j = 0; j < 256; j++) bm[j] = bmi[j] = bki * j;
          }
          const bk = (kernel[radius] = radius * radius);
          bm = mult[radius];
          for (let k = 0; k < 256; k++) bm[k] = bk * k;

          return { radius, size, kernel, mult };
        }

        function blurARGB(src, srcW, srcH, radiusParam) {
          const { radius: blurRadius, size: blurKernelSize, kernel: blurKernel, mult: blurMult } = buildBlurKernel(
            radiusParam
          );
          const n = srcW * srcH;
          const a0 = new Int32Array(n);
          const r0 = new Int32Array(n);
          const g0 = new Int32Array(n);
          const b0 = new Int32Array(n);
          for (let p = 0; p < n; p++) {
            const i = p * 4;
            r0[p] = src[i];
            g0[p] = src[i + 1];
            b0[p] = src[i + 2];
            a0[p] = src[i + 3];
          }
          const a2 = new Int32Array(n);
          const r2 = new Int32Array(n);
          const g2 = new Int32Array(n);
          const b2 = new Int32Array(n);

          let sum, cr, cg, cb, ca;
          let read, ri, ym, ymi, bk0;
          let x, y, i, bm;
          let yi = 0;

          // Horizontal pass.
          for (y = 0; y < srcH; y++) {
            for (x = 0; x < srcW; x++) {
              cb = cg = cr = ca = sum = 0;
              read = x - blurRadius;
              if (read < 0) {
                bk0 = -read;
                read = 0;
              } else {
                bk0 = 0;
              }
              for (i = bk0; i < blurKernelSize; i++) {
                if (read >= srcW) break;
                const p = read + yi;
                bm = blurMult[i];
                ca += bm[a0[p]];
                cr += bm[r0[p]];
                cg += bm[g0[p]];
                cb += bm[b0[p]];
                sum += blurKernel[i];
                read++;
              }
              ri = yi + x;
              a2[ri] = sum > 0 ? ca / sum : 0;
              r2[ri] = sum > 0 ? cr / sum : 0;
              g2[ri] = sum > 0 ? cg / sum : 0;
              b2[ri] = sum > 0 ? cb / sum : 0;
            }
            yi += srcW;
          }

          yi = 0;
          ym = -blurRadius;
          ymi = ym * srcW;
          const aOut = new Int32Array(n);
          const rOut = new Int32Array(n);
          const gOut = new Int32Array(n);
          const bOut = new Int32Array(n);
          // Vertical pass.
          for (y = 0; y < srcH; y++) {
            for (x = 0; x < srcW; x++) {
              cb = cg = cr = ca = sum = 0;
              if (ym < 0) {
                bk0 = ri = -ym;
                read = x;
              } else {
                bk0 = 0;
                ri = ym;
                read = x + ymi;
              }
              for (i = bk0; i < blurKernelSize; i++) {
                if (ri >= srcH) break;
                bm = blurMult[i];
                ca += bm[a2[read]];
                cr += bm[r2[read]];
                cg += bm[g2[read]];
                cb += bm[b2[read]];
                sum += blurKernel[i];
                ri++;
                read += srcW;
              }
              const p = x + yi;
              aOut[p] = sum > 0 ? ca / sum : 0;
              rOut[p] = sum > 0 ? cr / sum : 0;
              gOut[p] = sum > 0 ? cg / sum : 0;
              bOut[p] = sum > 0 ? cb / sum : 0;
            }
            yi += srcW;
            ymi += srcW;
            ym++;
          }

          const dst = new Uint8ClampedArray(n * 4);
          for (let p = 0; p < n; p++) {
            const i = p * 4;
            dst[i] = rOut[p];
            dst[i + 1] = gOut[p];
            dst[i + 2] = bOut[p];
            dst[i + 3] = aOut[p];
          }
          return dst;
        }

        // ---- GRAIN: one draw per pixel, R/G/B equally (deterministic hash -- see note above) ----
        function applyGrain(buf, bufW, bufH, amount) {
          const n = bufW * bufH;
          for (let p = 0; p < n; p++) {
            const x = p % bufW;
            const y = (p / bufW) | 0;
            const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
            const rnd = s - Math.floor(s);
            const a = (0.5 - rnd) * amount * 255;
            const i = p * 4;
            buf[i] = buf[i] + a;
            buf[i + 1] = buf[i + 1] + a;
            buf[i + 2] = buf[i + 2] + a;
          }
        }

        // ---- GAMMA ----
        function applyGamma(buf, g) {
          const len = buf.length;
          for (let i = 0; i < len; i += 4) {
            buf[i] = 255 * Math.pow(buf[i] / 255, g);
            buf[i + 1] = 255 * Math.pow(buf[i + 1] / 255, g);
            buf[i + 2] = 255 * Math.pow(buf[i + 2] / 255, g);
          }
        }

        // ---- LEVELS ----
        function applyLevels(buf, bp, wp) {
          const scale = 255 / (wp - bp);
          const len = buf.length;
          for (let i = 0; i < len; i += 4) {
            buf[i] = (buf[i] - bp) * scale;
            buf[i + 1] = (buf[i + 1] - bp) * scale;
            buf[i + 2] = (buf[i + 2] - bp) * scale;
          }
        }

        let out = rgba;
        if (blur !== 0) out = blurARGB(out, w, h, blur);
        if (grain !== 0) applyGrain(out, w, h, grain);
        if (gamma !== 1) applyGamma(out, gamma);
        if (!(blackPoint === 0 && whitePoint === 255)) applyLevels(out, blackPoint, whitePoint);
        return out;
      },
    },

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
        // The tooooools original is a DOM terminal (font-family: monospace;
        // line-height: 1.2; white-space: pre) — glyphs ALWAYS keep their
        // natural monospace aspect; only the image SAMPLING (grid built above)
        // stretches to fit the output's aspect, never the glyphs. So: measure
        // the natural advance-width/line-height ratio once, fit the whole text
        // block into w x h at that natural aspect (letterboxed + centered),
        // then draw every glyph unscaled.
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);

        ctx.font = '100px monospace';
        const advRatio = ctx.measureText('M').width / 100; // advance-width / em, monospace
        const lineH = 1.2; // matches tooooools' CSS line-height

        const fontPx = Math.max(1, Math.min(w / (totalCols * advRatio), h / (totalRows * lineH)));
        const advW = fontPx * advRatio; // per-glyph advance at this font size
        const cellH = fontPx * lineH; // per-line height at this font size
        const offsetX = (w - totalCols * advW) / 2;
        const offsetY = (h - totalRows * cellH) / 2;

        ctx.font = fontPx + 'px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#000';

        // Box-drawing border glyphs will show small vertical gaps at
        // line-height 1.2 (cellH > glyph height) — the original DOM terminal
        // has the exact same gaps between wrapped text lines, so this is
        // faithful, not a bug.
        for (let ry = 0; ry < totalRows; ry++) {
          const row = finalGrid[ry];
          const cy = offsetY + (ry + 0.5) * cellH;
          for (let rx = 0; rx < totalCols; rx++) {
            const ch = row[rx];
            if (!ch || ch === ' ') continue;
            const cx = offsetX + (rx + 0.5) * advW;
            ctx.fillText(ch, cx, cy);
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

    // ================= COLOR =================
    // Merged 2026-07-13: the former standalone `threshold` (TONE) and
    // `quantize` (COLOR) effects collapsed into `posterize`, mode-switched
    // via the `mode` select — same pattern as the 2026-07-11 `dots` merge
    // (see CLAUDE.md). `quantize` was posterize plus one param (hash-noise
    // dither before the same floor(col*levels+0.5)/levels quantization);
    // `threshold` is a different luma smoothstep cut but the same family
    // ("reduce tonal levels"). `showIf` (ui.js) hides params the current
    // mode doesn't read; src/pipeline.js's uniform-upload loop is unaware of
    // showIf and still uploads every param as a uniform every frame
    // regardless of mode. `default: 0` on `mode` is load-bearing: an old
    // `posterize` style code has no `mode` key, so it defaults to 0 and
    // renders byte-identical to the pre-merge `posterize` effect. Old
    // `threshold` / `quantize` LAYERS are migrated to
    // `{ effect: 'posterize', mode: 1|2 }` in src/preset.js (validatePreset),
    // upstream of the unknown-effect drop.
    posterize: {
      id: 'posterize',
      name: 'Posterize',
      category: 'COLOR',
      params: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Posterize' },
            { value: 1, label: 'Threshold' },
            { value: 2, label: 'Quantize' },
          ],
        },
        // Union of the pre-merge ranges (posterize 2-16, quantize 2-32 -> 2-32).
        // Default is posterize's own (4) so an old `posterize` code (mode
        // absent -> 0) is byte-identical; quantize's old default (8) lives on
        // in the migrated "Quantize" presets below, not as a fresh-pick default.
        { key: 'levels', label: 'Levels', type: 'range', min: 2, max: 32, step: 1, default: 4, showIf: { key: 'mode', in: [0, 2] } },
        // Renamed label from posterize's original "Mode" -> "Color mode":
        // the key stays `mono` (serialization/hash unchanged), but with the
        // new top-level `mode` select also called "Mode", two visible
        // controls both labeled "Mode" would be confusing. Label is UI-only.
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
        { key: 'level', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, showIf: { key: 'mode', in: [1] } },
        { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 0.5, step: 0.01, default: 0.02, showIf: { key: 'mode', in: [1] } },
        { key: 'dither', label: 'Dither', type: 'range', min: 0, max: 0.5, step: 0.01, default: 0.05, showIf: { key: 'mode', in: [2] } },
      ],
      // Presets merged from all three pre-merge effects, each carrying its
      // own `mode`. Names namespaced by family so they don't collide.
      presets: {
        'Poster 3': { mode: 0, levels: 3, mono: 0 },
        'Poster 6': { mode: 0, levels: 6, mono: 0 },
        'Poster Mono 4': { mode: 0, levels: 4, mono: 1 },
        'Threshold Hard': { mode: 1, level: 0.5, softness: 0 },
        'Threshold Soft': { mode: 1, level: 0.5, softness: 0.15 },
        'Threshold High-key': { mode: 1, level: 0.7, softness: 0.05 },
        'Quantize Clean 8': { mode: 2, levels: 8, dither: 0 },
        'Quantize Textured 6': { mode: 2, levels: 6, dither: 0.08 },
        'Quantize Rough 4': { mode: 2, levels: 4, dither: 0.15 },
      },
      // ONE frag, three mode bodies. Each body is the pre-merge shader's old
      // main() taken verbatim -- only renamed to a vec4-returning function
      // (`fragColor = vec4(...); }` -> `return vec4(...); }`) -- pixel output
      // is unchanged. `rand()` (quantize's helper) is declared once at file
      // scope.
      frag: `${HEAD}
uniform float u_mode;
uniform float u_levels;
uniform float u_mono;
uniform float u_level;
uniform float u_softness;
uniform float u_dither;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
}

// mode 0 -- Posterize (verbatim pre-merge posterize shader body)
vec4 modePosterize(vec4 c) {
  float levels = max(u_levels - 1.0, 1.0);
  vec3 col = c.rgb;
  if (u_mono > 0.5) {
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    g = floor(g * levels + 0.5) / levels;
    col = vec3(g);
  } else {
    col = floor(col * levels + 0.5) / levels;
  }
  return vec4(col, c.a);
}

// mode 1 -- Threshold (verbatim pre-merge threshold shader body)
vec4 modeThreshold(vec4 c) {
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float soft = max(u_softness, 0.0001);
  float v = smoothstep(u_level - soft, u_level + soft, g);
  return vec4(vec3(v), c.a);
}

// mode 2 -- Quantize (verbatim pre-merge quantize shader body)
vec4 modeQuantize(vec4 c, vec2 fragCoord) {
  float n = (rand(fragCoord + u_seed) - 0.5) * u_dither;
  float levels = max(u_levels - 1.0, 1.0);
  vec3 col = clamp(c.rgb + n, 0.0, 1.0);
  col = floor(col * levels + 0.5) / levels;
  return vec4(col, c.a);
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 fragCoord = v_uv * u_resolution;
  if (u_mode < 0.5) {
    fragColor = modePosterize(c);
  } else if (u_mode < 1.5) {
    fragColor = modeThreshold(c);
  } else {
    fragColor = modeQuantize(c, fragCoord);
  }
}`,
    },

    // gradientmap + recolor merged into one GPU `gradientmap` (2026-07-13),
    // same "merge by shared MECHANISM, not shared THEME" precedent as dots/
    // posterize/halftone: both effects were luminance-to-color remaps, just
    // built on two incompatible engines (gradientmap: CPU 256-entry LUT
    // indexing a variable-length `stops` array; recolor: a GPU frag with
    // exactly 3 hardcoded stops plus posterize/noise/repetition extras).
    // `frag` and `cpu` are mutually exclusive in this registry, so a
    // mode-select merge (like dots/posterize/halftone) was impossible here —
    // one engine had to win outright. GPU WON: recolor's shader already did
    // the real gradient-sample work per-pixel with room for extras
    // (posterize/noise/repetitions); gradientmap's CPU LUT could not absorb
    // those without becoming a second per-pixel CPU loop duplicating what the
    // GPU already does for free. The one missing piece — a variable-length
    // `stops` array can't be a single `u_<key>` uniform — is solved generally
    // in src/pipeline.js's `_draw()`: a `type: 'stops'` param is now uploaded
    // as three uniforms (`u_stopPos[8]`, `u_stopColor[8]`, `u_stopCount`),
    // sorted ascending by `pos` on the JS side (same sort buildGradientLut
    // already did) so the shader itself never needs to sort. MAX 8 stops is
    // plenty for a gradient map; a `stops` array longer than that is
    // truncated with a console.warn (see pipeline.js). `type: 'stops'` is no
    // longer universally "cpu-only, never a uniform" — that was only ever
    // true because gradientmap was its only user; ui.js's stops-bar preview
    // (buildLut) is UNCHANGED, it still just paints a LUT for the editor UI
    // and has nothing to do with which engine actually renders the pixels.
    //
    // sampleGradient() below is recolor's OWN piecewise mix() generalized
    // from a hardcoded 3-stop bubble-sort to an N-stop scan over the
    // pre-sorted uniform arrays — same algorithm buildGradientLut already
    // used for the CPU path (clamp to the first/last stop's color outside
    // the stop range, lerp between the enclosing pair inside it), so for
    // N=3 this is bit-for-bit the same math recolor's shader always ran.
    //
    // `posterizeSteps`/`noiseIntensity`/`noiseScale`/`noiseGamma`/
    // `repetitions` are absorbed with recolor's own IDENTITY defaults
    // (255 / 0 / 1 respectively), so a gradientmap style code that never
    // touches them still runs noise -> posterize -> repeat as no-ops.
    //
    // `map` is the ONE param that does NOT get recolor's default (0,
    // Brightness) — its default is 3 (Luminance) instead. Root cause: a
    // bare pre-merge `gradientmap` code carries no `map` key at all (the
    // param didn't exist yet), so it falls through to whatever the default
    // is, and the old CPU gradientmap ALWAYS indexed its 256-entry LUT by
    // WEIGHTED luminance (0.299/0.587/0.114) — a completely different
    // formula from recolor's own Brightness (an unweighted (r+g+b)/3
    // blended toward white by alpha). Defaulting `map` to recolor's 0 first
    // shipped this merge with every old gradientmap code silently
    // re-toned (max channel diff 113/255, mean 16) — caught before it
    // landed. Since recolor's OWN default was 0, LEGACY_EFFECTS.recolor's
    // transform() in src/preset.js now injects `map: 0` explicitly whenever
    // an old recolor code omits the key, so migrated recolor codes stay
    // byte-identical despite the default moving out from under them.
    //
    // `recolor` itself is deleted; LEGACY_EFFECTS in src/preset.js migrates
    // old `recolor` codes to `gradientmap` with a `transform()` (not just a
    // param merge, since `stop1/pos1..stop3/pos3` — recolor's `pos` is
    // 0..100 — must become a `stops: [{pos (0..1), color}]` array, and `map`
    // needs the explicit default above). Old `gradientmap` codes still load
    // fine too — `stops` is untouched, `posterizeSteps`/etc fall back to
    // their identity defaults, `map` falls back to 3 (Luminance) and
    // reproduces the old CPU LUT's own formula (see the verification
    // report for measured diff).
    gradientmap: {
      id: 'gradientmap',
      name: 'Gradient map',
      category: 'COLOR',
      params: [
        {
          key: 'stops',
          label: 'Stops',
          type: 'stops', // array value; uploaded as u_stopPos[]/u_stopColor[]/u_stopCount (see src/pipeline.js)
          default: [
            { pos: 0, color: '#1a0b2e' },
            { pos: 1, color: '#ff6b35' },
          ],
        },
        {
          key: 'map',
          label: 'Map',
          type: 'select',
          // Default is Luminance (3), NOT recolor's old 0 (Brightness) —
          // a bare `gradientmap` code (pre-merge) carries no `map` key at
          // all, so it falls through to this default, and the old CPU
          // gradientmap ALWAYS indexed its LUT by weighted luminance
          // (0.299/0.587/0.114 — see the `map`===3 branch below and
          // src/preset.js's LEGACY_EFFECTS.recolor, which now injects an
          // explicit `map: 0` for migrated recolor codes precisely because
          // this default moved out from under recolor's own Brightness
          // default). 0/1/2 keep recolor's original numeric values
          // unchanged so old recolor codes still resolve to the same option.
          default: 3,
          options: [
            { value: 0, label: 'Brightness' },
            { value: 1, label: 'Hue' },
            { value: 2, label: 'Saturation' },
            { value: 3, label: 'Luminance' },
          ],
        },
        { key: 'posterizeSteps', label: 'Posterize', type: 'range', min: 2, max: 255, step: 1, default: 255 },
        { key: 'noiseIntensity', label: 'Noise intensity', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'noiseScale', label: 'Noise scale', type: 'range', min: 0.01, max: 1, step: 0.01, default: 0.3 },
        { key: 'noiseGamma', label: 'Noise gamma', type: 'range', min: 0.1, max: 5, step: 0.1, default: 1 },
        { key: 'repetitions', label: 'Repetitions', type: 'range', min: 1, max: 10, step: 1, default: 1 },
      ],
      presets: {
        // old duotone's Sunset colors, as 2 stops (all recolor extras at identity).
        Duotone: {
          stops: [
            { pos: 0, color: '#1a0b2e' },
            { pos: 1, color: '#ff6b35' },
          ],
        },
        // old duotone's Terminal colors, as 2 stops.
        Terminal: {
          stops: [
            { pos: 0, color: '#001a0a' },
            { pos: 1, color: '#39ff14' },
          ],
        },
        // old gradientmap's DEFAULT 4 stops (color1..4), evenly spaced.
        Quadtone: {
          stops: [
            { pos: 0, color: '#000000' },
            { pos: 0.3333, color: '#3355ff' },
            { pos: 0.6666, color: '#ff8800' },
            { pos: 1, color: '#ffffff' },
          ],
        },
        // old gradientmap's Ocean preset, as 4 evenly-spaced stops.
        Ocean: {
          stops: [
            { pos: 0, color: '#000814' },
            { pos: 0.3333, color: '#003566' },
            { pos: 0.6666, color: '#0077b6' },
            { pos: 1, color: '#caf0f8' },
          ],
        },
        // old gradientmap's Mono preset, as 4 evenly-spaced stops.
        Mono: {
          stops: [
            { pos: 0, color: '#000000' },
            { pos: 0.3333, color: '#4d4d4d' },
            { pos: 0.6666, color: '#b3b3b3' },
            { pos: 1, color: '#ffffff' },
          ],
        },
        // old recolor's presets, its 3 fixed stops converted to a `stops`
        // array (posN 0..100 -> pos 0..1) -- same conversion LEGACY_EFFECTS
        // applies to a pasted old `recolor` style code.
        'Recolor Tooooools': {
          stops: [
            { pos: 0, color: '#00278a' },
            { pos: 0.5, color: '#fe76ec' },
            { pos: 1, color: '#fefffa' },
          ],
          map: 0, posterizeSteps: 255, noiseIntensity: 0, noiseScale: 0.3, noiseGamma: 1, repetitions: 1,
        },
        'Grain Poster': {
          stops: [
            { pos: 0, color: '#00278a' },
            { pos: 0.5, color: '#fe76ec' },
            { pos: 1, color: '#fefffa' },
          ],
          map: 0, posterizeSteps: 6, noiseIntensity: 0.35, noiseScale: 0.15, noiseGamma: 0.6, repetitions: 1,
        },
        'Hue Bands': {
          stops: [
            { pos: 0, color: '#101010' },
            { pos: 0.4, color: '#ff5e3a' },
            { pos: 1, color: '#ffe17d' },
          ],
          map: 1, posterizeSteps: 8, noiseIntensity: 0, noiseScale: 0.3, noiseGamma: 1, repetitions: 4,
        },
      },
      frag: `${HEAD}
uniform float u_posterizeSteps;
uniform float u_noiseIntensity;
uniform float u_noiseScale;
uniform float u_noiseGamma;
uniform float u_repetitions;
uniform float u_map;
uniform vec3 u_stopColor[8];
uniform float u_stopPos[8];
uniform int u_stopCount;

// Value-noise fBm standing in for p5.js noise(): p5's noise() is a
// proprietary Processing-derived lattice noise seeded from Math.random() at
// load (not reproducible across sessions/batch runs anyway), summed over its
// default 4 octaves with falloff 0.5 and normalized to 0..1. We match that
// *shape* (coherent band-limited 0..1 noise, same octave/falloff defaults)
// with a standard hash + bilinear value-noise fBm, deterministic by pixel
// position only (no u_seed) so preview == batch output every run.
float hash2(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbmNoise(vec2 p) {
  float total = 0.0;
  float amp = 1.0;
  float ampSum = 0.0;
  float freq = 1.0;
  for (int i = 0; i < 4; i++) {
    total += valueNoise(p * freq) * amp;
    ampSum += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return total / ampSum;
}

// iq's rgb2hsv: h,s,v all 0..1 (h*360 = degrees, s*100 = percent — matches
// p5's hue()/saturation() outputs once normalized the same way).
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

// Matches original: a<=1 -> 0; a==2 -> hard 0/1 split at 0.5; else
// floor(v*steps)/(steps-1).
float posterizeVal(float v, float steps) {
  if (steps <= 1.0) return 0.0;
  if (steps < 2.5) return v < 0.5 ? 0.0 : 1.0;
  return floor(v * steps) / (steps - 1.0);
}

// N-stop generalization of recolor's old hardcoded 3-stop sampleGradient():
// u_stopPos/u_stopColor arrive PRE-SORTED ascending by pos (sorted once on
// the JS side in src/pipeline.js, same sort buildGradientLut's CPU path
// already applied) -- so, unlike the old recolor shader, there is no need to
// sort in-shader here. Below/above the stop range clamps to the end stop's
// color; in between, lerp across the enclosing pair -- identical semantics
// to buildGradientLut (effects.js) and to recolor's own pre-merge math for
// N==3.
vec3 sampleGradient(float t) {
  t = clamp(t, 0.0, 1.0);
  int n = u_stopCount;
  if (n <= 0) return vec3(0.0);
  if (t <= u_stopPos[0]) return u_stopColor[0];
  for (int i = 0; i < 7; i++) {
    if (i + 1 >= n) break;
    if (t < u_stopPos[i + 1]) {
      float span = max(u_stopPos[i + 1] - u_stopPos[i], 1e-6);
      float f = clamp((t - u_stopPos[i]) / span, 0.0, 1.0);
      return mix(u_stopColor[i], u_stopColor[i + 1], f);
    }
  }
  return u_stopColor[n - 1];
}

void main() {
  vec4 c = texture(u_tex, v_uv);

  // colorAttribute mapping. "brightness" (recolor's own 0) blends channel
  // average against white by alpha, exactly like tooooools'
  // (r+g+b)/765*m+(1-m). "luminance" (3, THE DEFAULT — see the param
  // above) is the old CPU gradientmap's own formula: plain
  // 0.299/0.587/0.114-weighted luminance, no alpha term (the old LUT stage
  // never considered alpha either — see src/preset.js's migration notes).
  float mapVal;
  if (u_map < 0.5) {
    float m = c.a;
    mapVal = (c.r + c.g + c.b) / 3.0 * m + (1.0 - m);
  } else if (u_map < 1.5) {
    mapVal = rgb2hsv(c.rgb).x;
  } else if (u_map < 2.5) {
    mapVal = rgb2hsv(c.rgb).y;
  } else {
    mapVal = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  }

  vec2 pixelPos = v_uv * u_resolution;
  float n = fbmNoise(pixelPos * u_noiseScale);
  n = pow(max(n, 0.0), u_noiseGamma);
  float noiseOffset = (n - 0.5) * 2.0 * u_noiseIntensity;
  float t = clamp(mapVal + noiseOffset, 0.0, 1.0);

  float steps = floor(u_posterizeSteps + 0.5);
  t = posterizeVal(t, steps);

  if (u_repetitions > 1.0) {
    t = fract(t * u_repetitions);
  }

  vec3 col = sampleGradient(t);
  fragColor = vec4(col, c.a);
}`,
    },

    // ================= DISTORT =================
    pixelate: {
      id: 'pixelate',
      name: 'Pixelate',
      category: 'DISTORT',
      params: [{ key: 'size', label: 'Block size', type: 'range', min: 1, max: 64, step: 1, default: 8 }],
      presets: {
        Fine: { size: 4 },
        Chunky: { size: 16 },
        Blocky: { size: 32 },
      },
      frag: `${HEAD}
uniform float u_size;

void main() {
  float s = max(u_size, 1.0);
  vec2 blockCoord = floor(v_uv * u_resolution / s) * s;
  vec2 center = (blockCoord + s * 0.5) / u_resolution;
  fragColor = texture(u_tex, clamp(center, vec2(0.0), vec2(1.0)));
}`,
    },

    scatter: {
      id: 'scatter',
      name: 'Scatter',
      category: 'DISTORT',
      params: [
        // Quirk kept on purpose (tooooools has the same one): default 0.004
        // sits below the slider's own 0.01 step grid — a `range` control
        // carries an off-grid default fine, it just won't be reachable again
        // by dragging the slider from one of its own step stops.
        { key: 'density', label: 'Point Density', type: 'range', min: 0, max: 0.2, step: 0.01, default: 0.004 },
        { key: 'minSize', label: 'Min Dot Size', type: 'range', min: 1, max: 50, step: 1, default: 4 },
        { key: 'maxSize', label: 'Max Dot Size', type: 'range', min: 1, max: 50, step: 1, default: 14 },
        { key: 'relaxIterations', label: 'Relax Iterations', type: 'range', min: 0, max: 20, step: 1, default: 1 },
        { key: 'relaxStrength', label: 'Relax Strength', type: 'range', min: 0, max: 1, step: 0.01, default: 0.16 },
      ],
      presets: {
        Tooooools: { density: 0.004, minSize: 4, maxSize: 14, relaxIterations: 1, relaxStrength: 0.16 },
        Packed: { density: 0.03, minSize: 6, maxSize: 22, relaxIterations: 10, relaxStrength: 0.3 },
      },
      // CPU stage (mutually exclusive with `frag`): exact port of tooooools'
      // p5.js WEBGL "Scatter" sketch — stochastic point sampling from source
      // brightness, a sequential (Gauss-Seidel, order-dependent) soft
      // circle-packing relaxation, then painter's-order (largest-first)
      // circle drawing. Runs on the CPU because the relaxation step is an
      // inherently sequential per-point loop (same reason `dither`'s F-S mode
      // is a CPU stage), not something a parallel frag pass can express.
      //
      // Skipped vs. tooooools: the "Upload dot textures" control (no
      // per-effect multi-image upload in RSTR's param model) and "Canvas
      // Size"/"Show Effect" (RSTR/editor conventions cover both). Only the
      // DEFAULT baked dot texture is ported: their texture is a solid black
      // circle of diameter 1024px centered in a 1044x1044 transparent plane
      // (10px transparent margin on every side) — i.e. for a point drawn at
      // `size`, the visible circle's diameter is `size * (1044-20)/1044`.
      // Reproduced here with a canvas `arc()` fill (naturally antialiased,
      // same as their texture-sampled circle edge).
      //
      // Polarity / background (verified against the chunk, not guessed): the
      // sketch's `draw()` is `e.clear()` (transparent) then, ONLY when
      // `showEffect` is on, it runs the point-scatter draw with NO prior
      // `e.image(r,...)` of the source photo at all — the source image is
      // drawn only in the OFF branch (i.e. the plain "disable effect"
      // bypass). So the effect itself never composites over the source; it
      // is a from-scratch generative frame, same shape as this project's
      // `stipple`/`ascii` ports. Its transparent canvas reads as the site's
      // white page underneath (light theme) — ported as an explicit opaque
      // white background + opaque black circles, matching `stipple`'s same
      // "blank canvas, no source compositing" precedent (full opacity out,
      // no source-alpha passthrough).
      //
      // Orientation: the algorithm is isotropic on its own (position is read
      // straight from pixel index and written back through the same
      // convention), BUT the stochastic spawn scan order IS the point
      // creation/array order, and the relaxation pass is a strictly
      // sequential Gauss-Seidel update over that same array order — so the
      // final point arrangement is order-dependent even though no single
      // step is direction-biased. Mirror the original's top-down row scan
      // exactly (flip input to top-down, run everything there, flip the
      // rendered canvas back), same helper pattern as the `ascii` entry.
      //
      // Determinism (the one deliberate deviation from tooooools, like
      // `dither`'s Random mode): the original's point-spawn test uses the
      // browser's global `Math.random()` — its own `p5.randomSeed(123)` call
      // seeds p5's *own* random generator, which the spawn test never calls,
      // so it's dead code and the original is NOT reproducible frame to
      // frame. RSTR needs preview === batch, so every random draw below is
      // replaced with the deterministic coordinate hash
      // `fract(sin(x*12.9898 + y*78.233) * 43758.5453123)`. This effect only
      // ever needs ONE independent random draw per candidate pixel (the
      // single spawn Bernoulli trial), so no second offset hash (e.g. `+1.234`
      // on x) is needed anywhere in this port.
      cpu: function (rgba, w, h, params) {
        const density = params.density != null ? params.density : 0.004;
        const minSize = params.minSize != null ? params.minSize : 4;
        const maxSize = params.maxSize != null ? params.maxSize : 14;
        const relaxIterations = Math.max(0, Math.round(params.relaxIterations != null ? params.relaxIterations : 1));
        const relaxStrength = params.relaxStrength != null ? params.relaxStrength : 0.16;

        const stride = w * 4;

        // --- flip input to top-down working space (tooooools samples/places
        // points in normal top-down image space; `rgba` row 0 is the image
        // BOTTOM, WebGL readPixels orientation) ---
        const top = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          top.set(rgba.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
        }

        // Deterministic coordinate hash replacing Math.random() — see the
        // determinism note above. Only one draw needed per pixel here.
        function hash01(x, y) {
          const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
          return s - Math.floor(s);
        }

        // Spatial-hash bucket size — original's `Math.max(maxPointSize, 20)`
        // floor, regardless of how small maxSize is set.
        const cellSize = Math.max(maxSize, 20);
        function cellKey(x, y) {
          return Math.floor(x / cellSize) + ',' + Math.floor(y / cellSize);
        }

        // --- STEP 1: stochastic point sampling, one Bernoulli trial per
        // source pixel, top-down row-major scan order. This scan order IS
        // the point creation/array order that the sequential relaxation
        // below depends on for a faithful (order-dependent) match. ---
        // Pass A: count spawns first so the point buffers can be flat typed
        // arrays sized exactly once (no per-pixel object allocation, no
        // growable-array churn for a multi-megapixel scan).
        let count = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const luma = (top[i] + top[i + 1] + top[i + 2]) / 3; // plain average, NOT luminance-weighted
            const prob = ((255 - luma) / 255) * density; // darker pixel -> higher spawn chance
            if (hash01(x, y) < prob) count++;
          }
        }

        const px = new Float64Array(count);
        const py = new Float64Array(count);
        const psize = new Float32Array(count);
        const pfx = new Float64Array(count);
        const pfy = new Float64Array(count);
        const grid = new Map(); // cellKey string -> Array<pointIndex>

        function insert(idx) {
          const k = cellKey(px[idx], py[idx]);
          let bucket = grid.get(k);
          if (!bucket) {
            bucket = [];
            grid.set(k, bucket);
          }
          bucket.push(idx);
        }

        // Pass B: identical deterministic test -> identical spawn set, now
        // filled into the exactly-sized typed buffers and bucketed.
        let idx = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const luma = (top[i] + top[i + 1] + top[i + 2]) / 3;
            const prob = ((255 - luma) / 255) * density;
            if (hash01(x, y) < prob) {
              // map(luma, 0,255, maxSize,minSize): darker -> BIGGER dot.
              const size = maxSize + (luma / 255) * (minSize - maxSize);
              px[idx] = x;
              py[idx] = y;
              psize[idx] = size;
              insert(idx);
              idx++;
            }
          }
        }

        // --- STEP 2: relaxation, `relaxIterations` sequential Gauss-Seidel
        // passes over the SAME array order as creation above. Each point
        // reads force already pushed into it by earlier-processed points
        // this pass, applies its own move immediately, then zeroes only its
        // OWN force — a force it pushes onto a neighbor persists on that
        // neighbor until THAT neighbor's own turn (this pass if still ahead
        // in array order, otherwise next pass). Ported verbatim, including
        // the quirk that `combinedSize` averages the two points' sizes
        // instead of summing their radii. ---
        for (let pass = 0; pass < relaxIterations; pass++) {
          for (let i2 = 0; i2 < count; i2++) {
            const cx = Math.floor(px[i2] / cellSize);
            const cy = Math.floor(py[i2] / cellSize);
            for (let dcx = -1; dcx <= 1; dcx++) {
              for (let dcy = -1; dcy <= 1; dcy++) {
                const bucket = grid.get((cx + dcx) + ',' + (cy + dcy));
                if (!bucket) continue;
                for (let k = 0; k < bucket.length; k++) {
                  const j = bucket[k];
                  if (j === i2) continue;
                  const rx = px[j] - px[i2];
                  const ry = py[j] - py[i2];
                  const dist = Math.sqrt(rx * rx + ry * ry);
                  const combinedSize = (psize[i2] + psize[j]) / 2; // average, not sum-of-radii — quirk kept
                  if (dist < combinedSize) {
                    const push = ((combinedSize - dist) / dist) * relaxStrength;
                    pfx[i2] -= push * rx;
                    pfy[i2] -= push * ry;
                    pfx[j] += push * rx;
                    pfy[j] += push * ry;
                  }
                }
              }
            }

            const oldX = px[i2];
            const oldY = py[i2];
            px[i2] += pfx[i2];
            py[i2] += pfy[i2];

            const oldKey = cellKey(oldX, oldY);
            const newKey = cellKey(px[i2], py[i2]);
            if (oldKey !== newKey) {
              const oldBucket = grid.get(oldKey);
              if (oldBucket) {
                const at = oldBucket.indexOf(i2);
                if (at !== -1) oldBucket.splice(at, 1);
              }
              insert(i2);
            }
            pfx[i2] = 0;
            pfy[i2] = 0;
          }
        }

        // --- STEP 3: draw, largest dots first (painter's back-to-front),
        // default baked circle texture only (custom dot-texture upload is
        // out of scope for this port). White background, opaque black
        // circles — see the polarity note above. ---
        const order = new Array(count);
        for (let i3 = 0; i3 < count; i3++) order[i3] = i3;
        order.sort((a, b) => psize[b] - psize[a]);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#000';

        // tooooools' default dot texture: solid black circle, diameter 1024px,
        // centered in a 1044x1044 plane (10px transparent margin all round).
        const DOT_RATIO = (1044 - 20) / 1044;
        for (let i4 = 0; i4 < count; i4++) {
          const p = order[i4];
          const r = (psize[p] * DOT_RATIO) / 2;
          if (r <= 0) continue;
          ctx.beginPath();
          ctx.arc(px[p], py[p], r, 0, Math.PI * 2);
          ctx.fill();
        }

        const imgData = ctx.getImageData(0, 0, w, h).data;

        // The canvas is opaque (white background + opaque black circles), so
        // imgData's alpha is 255 everywhere regardless of the source's own
        // alpha. Restore the SOURCE pixel's alpha at each position — same
        // coordinate frame as `top` (top-down, w*h*4) — without touching the
        // RGB this generative stage just painted.
        for (let i = 3; i < imgData.length; i += 4) {
          imgData[i] = top[i];
        }

        // --- flip result back to bottom-up ---
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          out.set(imgData.subarray(y * stride, (y + 1) * stride), (h - 1 - y) * stride);
        }
        return out;
      },
    },

    glitch: {
      id: 'glitch',
      name: 'Glitch',
      category: 'DISTORT',
      params: [
        { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, step: 1, default: 35 },
        { key: 'sliceHeight', label: 'Slice Height (px)', type: 'range', min: 1, max: 200, step: 1, default: 12 },
        { key: 'maxShift', label: 'Max Shift (px)', type: 'range', min: 0, max: 400, step: 1, default: 60 },
        { key: 'seedOffset', label: 'Seed', type: 'range', min: 0, max: 1000, step: 1, default: 0 },
        { key: 'blockNoise', label: 'Block Noise', type: 'range', min: 0, max: 100, step: 1, default: 0 },
        { key: 'chromaShift', label: 'Chroma Shift', type: 'range', min: 0, max: 100, step: 1, default: 0 },
      ],
      presets: {
        'VHS Tear': { amount: 35, sliceHeight: 10, maxShift: 50, seedOffset: 0, blockNoise: 0, chromaShift: 50 },
        Datamosh: { amount: 60, sliceHeight: 24, maxShift: 140, seedOffset: 7, blockNoise: 45, chromaShift: 0 },
        Subtle: { amount: 12, sliceHeight: 6, maxShift: 15, seedOffset: 0, blockNoise: 0, chromaShift: 0 },
      },
      // Horizontal slice displacement (datamosh/VHS-tear look) -- the kind of
      // "glitch" RSTR didn't have yet.
      //
      // `chromaShift` (2026-07-13): glitch originally shipped with NO color
      // split at all, reasoning that `aberration` already owned RGB channel
      // separation and the two effects could just be stacked. That reasoning
      // was wrong: stacking glitch -> aberration gives a UNIFORM channel
      // offset across the WHOLE frame, independent of which rows are torn --
      // a real glitch splits color INSIDE the torn slices, proportional to
      // each slice's OWN displacement, and leaves untorn rows perfectly
      // clean. No stack of a per-slice effect and a whole-frame effect can
      // reproduce that, at any settings. So chroma split now lives here,
      // driven by the same per-slice `shiftPx` that already drives the tear:
      // `chromaShift` (0-100, default 0 = identical to every pre-existing
      // glitch style code) is a PERCENTAGE of the slice's own pixel shift,
      // not an absolute px value -- an absolute value would be invisible on
      // subtle tears and excessive on huge ones, while a multiplier stays
      // proportional across every `maxShift` setting and is exactly zero
      // whenever the slice itself is zero-shifted. R samples at
      // `+shiftPx * chromaShift/100`, B at `-shiftPx * chromaShift/100`
      // (same +R/-B convention as `aberration`, G stays put), so the fringe
      // direction flips with the tear direction: a slice torn left fringes
      // opposite to one torn right. Untorn slices never touch this branch at
      // all, so they carry zero fringe by construction, not by clamping.
      // When `blockNoise` subdivides a torn slice into jittered blocks, its
      // per-block jitter is already folded into `shiftPx` BEFORE this offset
      // is computed, so the chroma split naturally varies block-to-block too
      // -- no extra uniform or branch needed for that.
      //
      // Algorithm: the frame is cut into horizontal slices of `sliceHeight`
      // px. Each slice rolls ONE Bernoulli trial (`amount` = % chance a given
      // slice is torn at all). A torn slice's row samples from `v_uv.x`
      // shifted by a per-slice random offset up to `maxShift` px and WRAPPED
      // (mod 1.0) rather than clamped/void -- pixels that shift off one edge
      // reappear on the other, the classic wrap-around glitch tear (distinct
      // from CRT's alpha-void-outside-the-tube choice, which is a lens
      // effect, not a tear). `blockNoise` optionally subdivides a torn slice
      // into narrower blocks along X, each with its own extra jitter on top
      // of the slice's base shift -- 0 = one clean uniform bar (plain
      // VHS-tear), 100 = chunky uneven fragmentation (closer to macroblock
      // datamosh). Left off by default so the base look is a simple clean bar.
      //
      // Determinism: every "random" draw is the same coordinate-hash idiom
      // used elsewhere in this file (see `quantize`'s `rand()`), never
      // Math.random(), so editor preview and the headless engine render are
      // pixel-identical for the same params. `seedOffset` is a PER-LAYER
      // variant knob, deliberately a separate uniform from the shared
      // `u_seed` (declared once in HEAD and driven by the pipeline's global
      // reseed / a preset's top-level `seed` field) rather than reusing that
      // param key: `u_seed` is already uploaded unconditionally by the
      // pipeline for every pass, and a per-effect param literally named
      // `seed` would resolve to the SAME `u_seed` uniform location and
      // silently shadow it. seedOffset is folded additively into the hash
      // input alongside u_seed (`rand(coord + u_seed)` is quantize's
      // precedent) -- so a global reseed still shifts every glitch layer
      // together, while seedOffset lets two glitch layers in one mix roll
      // independently different tear patterns. `chromaShift` reuses this
      // same seeded value indirectly (it rides `shiftPx`, which is already
      // seeded) rather than adding a uniform named `seed`.
      //
      // Orientation: v_uv.y=0 is the image BOTTOM in RSTR. Slice boundaries
      // fall on a plain row-index hash with no directional bias, so which
      // physical edge (top/bottom of the visible photo) a given slice index
      // lands on doesn't change the character of the effect -- unlike CRT's
      // barrel distortion or bevel's light angle, nothing here depends on
      // which way is "up".
      frag: `${HEAD}
uniform float u_amount;
uniform float u_sliceHeight;
uniform float u_maxShift;
uniform float u_seedOffset;
uniform float u_blockNoise;
uniform float u_chromaShift;

float glitchHash(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
}

void main() {
  vec2 fragCoord = v_uv * u_resolution;
  float sliceH = max(u_sliceHeight, 1.0);
  float sliceIndex = floor(fragCoord.y / sliceH);
  float seedBase = u_seed + u_seedOffset * 97.0;

  float tornRoll = glitchHash(vec2(sliceIndex, seedBase));
  vec2 uv = v_uv;
  float chromaOffsetPx = 0.0;

  if (tornRoll < u_amount / 100.0) {
    float shiftRoll = glitchHash(vec2(sliceIndex + 31.0, seedBase * 1.37));
    float shiftPx = (shiftRoll * 2.0 - 1.0) * u_maxShift;

    if (u_blockNoise > 0.0) {
      float blockW = max(sliceH * 1.5, 4.0);
      float blockIndex = floor(fragCoord.x / blockW);
      float blockRoll = glitchHash(vec2(blockIndex * 3.0 + sliceIndex, seedBase * 2.11 + 7.0));
      shiftPx += (blockRoll * 2.0 - 1.0) * u_maxShift * (u_blockNoise / 100.0);
    }

    uv.x = mod(v_uv.x + shiftPx / u_resolution.x, 1.0);
    // Per-slice (and, via shiftPx, per-block) chroma split: a PERCENTAGE of
    // this slice's own displacement, not an absolute px value -- see the
    // registry comment above for why. Zero whenever chromaShift is 0 or the
    // slice itself is untorn (this whole block is skipped then).
    chromaOffsetPx = shiftPx * (u_chromaShift / 100.0);
  }

  // R/B sample at +/-chromaOffsetPx from G's uv, same wrap (mod) as the tear
  // itself -- never clamp/void. Three independent texture() fetches at
  // identical coordinates when chromaOffsetPx is 0 (rX == bX == uv.x)
  // reproduce the single texture(u_tex, uv) fetch exactly, so chromaShift
  // = 0 renders byte-identically to every pre-existing glitch style code.
  float rX = mod(uv.x + chromaOffsetPx / u_resolution.x, 1.0);
  float bX = mod(uv.x - chromaOffsetPx / u_resolution.x, 1.0);
  vec4 base = texture(u_tex, uv);
  float r = texture(u_tex, vec2(rX, uv.y)).r;
  float b = texture(u_tex, vec2(bX, uv.y)).b;
  fragColor = vec4(r, base.g, b, base.a);
}`,
    },

    // ================= STYLIZE =================
    aberration: {
      id: 'aberration',
      name: 'Aberration',
      category: 'STYLIZE',
      params: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Radial (lens)' },
            { value: 1, label: 'Linear' },
          ],
        },
        { key: 'amount', label: 'Amount (px)', type: 'range', min: 0, max: 40, step: 0.5, default: 4 },
        { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, step: 1, default: 0 },
      ],
      presets: {
        Lens: { mode: 0, amount: 6, angle: 0 },
        Strong: { mode: 0, amount: 16, angle: 0 },
        Horizontal: { mode: 1, amount: 4, angle: 0 },
      },
      // Chromatic aberration / RGB convergence, extracted from the CRT port
      // (its 0.1-strength UV-space offsets were near-invisible and coupled to
      // the mask). R shifts +offset, B shifts -offset, G stays. Radial mode
      // scales the shift from 0 at the center to `amount` px at the edges
      // (lens-like); Linear shifts uniformly along `angle`.
      frag: `${HEAD}
uniform float u_mode;
uniform float u_amount;
uniform float u_angle;

void main() {
  vec2 off;
  if (u_mode < 0.5) {
    off = (v_uv - 0.5) * 2.0 * (u_amount / u_resolution);
  } else {
    float a = radians(u_angle);
    off = vec2(cos(a), sin(a)) * (u_amount / u_resolution);
  }
  vec4 c = texture(u_tex, v_uv);
  float r = texture(u_tex, clamp(v_uv + off, vec2(0.0), vec2(1.0))).r;
  float b = texture(u_tex, clamp(v_uv - off, vec2(0.0), vec2(1.0))).b;
  fragColor = vec4(r, c.g, b, c.a);
}`,
    },

    crt: {
      id: 'crt',
      name: 'CRT',
      category: 'STYLIZE',
      params: [
        {
          key: 'patternType',
          label: 'Type',
          type: 'select',
          default: 0,
          // TV (value 1) is deliberately NOT offered: its only difference from LCD
          // is a half-element VERTICAL phase shift of alternate subpixel-column
          // groups, so both read as the same vertical RGB stripes (measured mean
          // channel diff 4.5/255, and no better at coarse pitch). The shader branch
          // and the value stay so old style codes carrying patternType:1 render
          // byte-identically -- the values are explicit, a gap here is harmless.
          options: [
            { value: 0, label: 'Monitor' },
            { value: 2, label: 'LCD' },
            { value: 3, label: 'Scanlines' },
          ],
        },
        { key: 'maskStrength', label: 'Mask Strength', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
        { key: 'distortion', label: 'Distortion', type: 'range', min: 0, max: 2, step: 0.01, default: 0.02 },
        { key: 'dotScale', label: 'Dot scale', type: 'range', min: 0.01, max: 2, step: 0.01, default: 0.93 },
        { key: 'dotPitch', label: 'Dot pitch', type: 'range', min: 0, max: 30, step: 0.01, default: 1.59 },
        { key: 'falloff', label: 'Falloff', type: 'range', min: 0.01, max: 1, step: 0.01, default: 0.12 },
        { key: 'glowRadius', label: 'Glow radius', type: 'range', min: 0, max: 0.5, step: 0.01, default: 0.2 },
        { key: 'glowIntensity', label: 'Glow intensity', type: 'range', min: 0, max: 1, step: 0.01, default: 0.1 },
        {
          key: 'blendMode',
          label: 'Bloom',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Screen' },
            { value: 1, label: 'Light' },
            { value: 2, label: 'HDR' },
          ],
        },
        { key: 'bloomThreshold', label: 'Bloom threshold', type: 'range', min: 0, max: 1, step: 0.01, default: 0.36 },
        { key: 'bloomIntensity', label: 'Bloom intensity', type: 'range', min: 0, max: 5, step: 0.01, default: 0.45 },
        { key: 'bloomRadius', label: 'Bloom radius', type: 'range', min: 0, max: 10, step: 0.01, default: 1 },
      ],
      presets: {
        Tooooools: {
          patternType: 0, distortion: 0.02, dotScale: 0.93, dotPitch: 1.59, falloff: 0.12,
          glowRadius: 0.2, glowIntensity: 0.1, blendMode: 0, bloomThreshold: 0.36, bloomIntensity: 0.45,
          bloomRadius: 1,
        },
        LCD: {
          patternType: 2, distortion: 0.02, dotScale: 0.93, dotPitch: 1.59, falloff: 0.12,
          glowRadius: 0.2, glowIntensity: 0.1, blendMode: 0, bloomThreshold: 0.36, bloomIntensity: 0.45,
          bloomRadius: 1,
        },
        Scanlines: {
          patternType: 3, distortion: 0.02, dotScale: 0.5, dotPitch: 3, falloff: 0.12,
          glowRadius: 0.2, glowIntensity: 0.1, blendMode: 0, bloomThreshold: 0.36, bloomIntensity: 0.45,
          bloomRadius: 1,
        },
      },
      // Ported from tooooools.app's CRT effect (p5.js/WebGL1 GLSL, 5 render passes:
      // crtShader -> brightPassShader -> blurHShader -> blurVShader -> combineShader).
      // Folded into ONE fragment pass:
      //  - CRT shader (barrel distortion, phosphor mask, R/B convergence, radial glow)
      //    ported near-verbatim, single pass in the original too.
      //  - Bloom (brightpass + separable 13-tap H blur + 13-tap V blur + blend) folded
      //    into one 5x5 (25-tap) weighted box/gaussian read of the SOURCE image (their
      //    brightpass also reads the original media, not the CRT-processed buffer).
      // brightnessBoost (2.5) is a hardcoded const below — internal in tooooools too.
      // v_uv.y=0 is bottom in RSTR vs. their canvas y=0 top: the phosphor mask is a
      // periodic/symmetric tiling and distortion/glow are radially symmetric, so
      // everything here is orientation-invariant.
      // Departures from the port (2026-07, on request):
      //  - R/B convergence extracted into the standalone `aberration` effect.
      //  - radialDistortion replaced: the original (coord + cc*(1+d)*d, d=r^2*k)
      //    only pushed samples outward, so at usable strengths it cropped the
      //    corners without visibly bending the image.
      //  - Scanlines (2026-07-12, not in the tooooools port): a 4th patternType
      //    appended AFTER Monitor/TV/LCD (value 3, never inserted between/before
      //    the existing values) so old style codes with patternType 0/1/2 keep
      //    rendering byte-identically. Plain horizontal bands, no RGB subpixel
      //    triads -- reuses dotPitch (line spacing) and dotScale (line
      //    thickness as a fraction of pitch) instead of adding a new param, so
      //    it reads consistently with the other three masks and still obeys
      //    maskStrength via the same `mix(vec3(1.0), pattern, u_maskStrength)`.
      frag: `${HEAD}
uniform float u_patternType;
uniform float u_maskStrength;
uniform float u_distortion;
uniform float u_dotScale;
uniform float u_dotPitch;
uniform float u_falloff;
uniform float u_glowRadius;
uniform float u_glowIntensity;
uniform float u_blendMode;
uniform float u_bloomThreshold;
uniform float u_bloomIntensity;
uniform float u_bloomRadius;

const float BRIGHTNESS_BOOST = 2.5;
const float OUTPUT_GAMMA = 2.2;

// Normalized tube curvature: the multiplier is 1 at the edge midpoints
// (r2=0.25), <1 at the center (content magnifies — the visible bulge), >1
// toward the corners (samples leave the source -> transparent void).
vec2 radialDistortion(vec2 coord) {
  vec2 cc = coord - 0.5;
  float r2 = dot(cc, cc);
  float f = (1.0 + r2 * u_distortion) / (1.0 + 0.25 * u_distortion);
  return 0.5 + cc * f;
}

float circularDot(vec2 point, vec2 center, float pitch) {
  float dist = length(point - center);
  float dotSize = pitch * u_dotScale * 0.5;
  return smoothstep(dotSize, dotSize * (1.0 - u_falloff), dist);
}

float rectDot(vec2 point, vec2 center, vec2 aspect, float pitch) {
  vec2 delta = abs(point - center);
  vec2 dotSize = vec2(pitch * u_dotScale * 0.5) * aspect;
  vec2 rect = smoothstep(dotSize, dotSize * (1.0 - u_falloff), delta);
  return rect.x * rect.y;
}

// Monitor: circular phosphor-dot triads (delta-mask CRT).
float monitorPattern(vec2 coord, float colorIndex, float pitch) {
  float colWidth = pitch;
  float colIndex = floor(coord.x / colWidth);
  float yOffset = mod(colIndex, 2.0) * (pitch * 1.5);
  float yPos = coord.y - yOffset;
  float withinGroup = mod(floor(yPos / pitch), 3.0);
  vec2 dotCenter = vec2(
    (colIndex + 0.5) * colWidth,
    (floor(yPos / pitch) + 0.5) * pitch + yOffset
  );
  float dotI = circularDot(coord, dotCenter, pitch);
  return (abs(withinGroup - colorIndex) < 0.5) ? dotI : 0.0;
}

// TV: rectangular RGB subpixels, rows shifted every other stripe (shadow mask).
float tvPattern(vec2 coord, float colorIndex, float pitch) {
  float elementWidth = pitch / 3.0;
  float elementHeight = pitch;
  vec2 aspect = vec2(0.31, 1.0);
  float groupIndex = floor(coord.x / (elementWidth * 3.0));
  float yOffset = mod(groupIndex, 2.0) * (elementHeight * 0.5);
  vec2 shifted = vec2(coord.x, coord.y - yOffset);
  float elementPos = mod(floor(shifted.x / elementWidth), 3.0);
  if (abs(elementPos - colorIndex) > 0.5) return 0.0;
  vec2 basePos = floor(shifted / vec2(elementWidth, elementHeight));
  vec2 center = vec2(
    (basePos.x + 0.5) * elementWidth,
    (basePos.y + 0.5) * elementHeight + yOffset
  );
  return rectDot(coord, center, aspect, pitch);
}

// LCD: rectangular RGB subpixels, fixed grid (no row shift).
float lcdPattern(vec2 coord, float colorIndex, float pitch) {
  float elementWidth = pitch / 3.0;
  float elementHeight = pitch;
  vec2 aspect = vec2(0.31, 1.0);
  float elementPos = mod(floor(coord.x / elementWidth), 3.0);
  if (abs(elementPos - colorIndex) > 0.5) return 0.0;
  vec2 basePos = floor(coord / vec2(elementWidth, elementHeight));
  vec2 center = vec2(
    (basePos.x + 0.5) * elementWidth,
    (basePos.y + 0.5) * elementHeight
  );
  return rectDot(coord, center, aspect, pitch);
}

// Scanlines: plain horizontal bands, no phosphor triads -- colorIndex is
// ignored on purpose so R/G/B all get the same value (no color separation,
// only alternating bright/dark rows). Reuses pitch (row spacing) and
// dotScale (band thickness as a fraction of pitch) with the exact same
// smoothstep(edge, edge*(1-falloff), d) idiom circularDot/rectDot use above,
// so falloff softens the row edge the same way it softens a dot edge.
float scanlinePattern(vec2 coord, float pitch) {
  float lineHalf = pitch * u_dotScale * 0.5;
  float d = abs(mod(coord.y, pitch) - pitch * 0.5);
  return smoothstep(lineHalf, lineHalf * (1.0 - u_falloff), d);
}

// RSTR select order is Monitor|TV|LCD|Scanlines -> 0/1/2/3 (their internal
// chunk uses a different numeric mapping for the first three names; only the
// label->look correspondence matters here, not their raw enum ints).
// Scanlines was appended last (2026-07-12) so 0/1/2 keep their exact <0.5 /
// <1.5 / else branch order -- an old style code with patternType 0, 1 or 2
// takes the identical branch it always did.
float maskPattern(vec2 coord, float colorIndex, float pitch) {
  if (u_patternType < 0.5) return monitorPattern(coord, colorIndex, pitch);
  else if (u_patternType < 1.5) return tvPattern(coord, colorIndex, pitch);
  else if (u_patternType < 2.5) return lcdPattern(coord, colorIndex, pitch);
  else return scanlinePattern(coord, pitch);
}

vec3 sampleSrc(vec2 uv) {
  return texture(u_tex, clamp(uv, 0.0, 1.0)).rgb;
}

// Radial glow: tooooools already does this as a single 32-sample loop inside
// their one CRT fragment shader (not a separate pass) — kept as one bounded
// loop here too, trimmed to 24 samples to keep total taps reasonable once
// combined with the bloom loop below.
vec3 applyGlow(vec2 coord, vec2 uv, vec3 baseColor, float pitch) {
  vec3 color = baseColor;
  if (u_glowIntensity > 0.0) {
    const int SAMPLES = 24;
    float angleStep = 6.28318530718 / float(SAMPLES);
    float totalWeight = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float angle = float(i) * angleStep;
      vec2 offset = vec2(cos(angle), sin(angle)) * u_glowRadius * pitch;
      vec2 glowUv = uv + offset / u_resolution;
      vec3 texColor = sampleSrc(glowUv);
      vec3 pattern = vec3(
        maskPattern(coord + offset, 0.0, pitch),
        maskPattern(coord + offset, 1.0, pitch),
        maskPattern(coord + offset, 2.0, pitch)
      );
      vec3 sampleColor = texColor * pattern;
      float weight = exp(-dot(offset, offset) / (4.0 * pitch * pitch));
      color += sampleColor * weight * u_glowIntensity;
      totalWeight += weight;
    }
    color /= (1.0 + totalWeight * u_glowIntensity);
  }
  return color;
}

vec3 screenBlend(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
vec3 lightenBlend(vec3 a, vec3 b) { return max(a, b); }
vec3 hdrBlend(vec3 a, vec3 b) {
  vec3 hdrColor = a + b;
  return hdrColor / (1.0 + hdrColor);
}

// Bloom folded to one pass: tooooools runs brightpass (reads the ORIGINAL
// media, not the CRT buffer) then a separable 13-tap horizontal + 13-tap
// vertical Gaussian blur, then combines. Here a single 5x5 (25-tap) weighted
// box/gaussian read of the source image approximates the separable blur —
// narrower falloff at high bloomRadius than their true 13-tap kernel, but the
// same brightpass threshold math and the same "glow comes from the source
// image, not the dot-masked image" behavior.
vec3 bloomSample(vec2 uv) {
  const int R = 2;
  float w[5] = float[5](0.06136, 0.24477, 0.38774, 0.24477, 0.06136);
  vec3 accum = vec3(0.0);
  vec2 px = u_bloomRadius / u_resolution;
  for (int i = -R; i <= R; i++) {
    for (int j = -R; j <= R; j++) {
      vec2 sampleUv = clamp(uv + vec2(float(i), float(j)) * px, 0.0, 1.0);
      vec3 c = texture(u_tex, sampleUv).rgb;
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 bright = c * smoothstep(u_bloomThreshold, u_bloomThreshold + 0.2, lum);
      accum += bright * w[i + R] * w[j + R];
    }
  }
  return accum;
}

void main() {
  float pitch = max(u_dotPitch, 0.0001);

  vec2 uv = v_uv;
  if (u_distortion > 0.0) uv = radialDistortion(uv);
  // Outside the barrel-distorted source: transparent void, not edge-stretched
  // pixels (the old clamp smeared the last row/column across the margin).
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 coord = uv * u_resolution;
  vec3 texColor = sampleSrc(uv) * BRIGHTNESS_BOOST;
  vec3 pattern = vec3(
    maskPattern(coord, 0.0, pitch),
    maskPattern(coord, 1.0, pitch),
    maskPattern(coord, 2.0, pitch)
  );
  pattern = mix(vec3(1.0), pattern, u_maskStrength);
  vec3 color = texColor * pattern;
  color = applyGlow(coord, uv, color, pitch);
  vec3 crtColor = pow(max(color, 0.0), vec3(1.0 / OUTPUT_GAMMA));

  vec3 bloomColor = bloomSample(uv) * u_bloomIntensity;
  vec3 finalColor;
  if (u_blendMode < 0.5) finalColor = screenBlend(crtColor, bloomColor);
  else if (u_blendMode < 1.5) finalColor = lightenBlend(crtColor, bloomColor);
  else finalColor = hdrBlend(crtColor, bloomColor);

  float alpha = texture(u_tex, v_uv).a;
  fragColor = vec4(clamp(finalColor, 0.0, 1.0), alpha);
}`,
    },

    bevel: {
      id: 'bevel',
      name: 'Bevel',
      category: 'STYLIZE',
      params: [
        { key: 'depth', label: 'Depth', type: 'range', min: 0, max: 500, step: 1, default: 20 },
        { key: 'lightAngle', label: 'Light angle', type: 'range', min: 0, max: 360, step: 45, default: 0 },
        { key: 'effectThreshold', label: 'Effect threshold', type: 'range', min: 0, max: 4, step: 0.01, default: 0 },
      ],
      presets: {
        Tooooools: { depth: 20, lightAngle: 0, effectThreshold: 0 },
        'Deep Relief': { depth: 120, lightAngle: 135, effectThreshold: 0.5 },
        'Soft Edge': { depth: 8, lightAngle: 315, effectThreshold: 1.5 },
      },
      frag: `${HEAD}
uniform float u_depth;
uniform float u_lightAngle;
uniform float u_effectThreshold;

// Same alpha-blended-against-white channel-average brightness as the
// original chunk's d(pixels, idx) helper, just in 0..1 float units instead
// of 0..255 bytes (r*a + 255*(1-a), averaged over R/G/B, /255).
float brightnessOf(vec4 c) {
  float m = c.a;
  return ((c.r * m + (1.0 - m)) + (c.g * m + (1.0 - m)) + (c.b * m + (1.0 - m))) / 3.0;
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 px = floor(v_uv * u_resolution);

  // tooooools' loop runs x in [1, width-2], y in [1, height-2] and leaves
  // the outer 1px border as literal original pixels (n = pixels.slice()
  // never gets touched there) -- replicate exactly, no wrap/clamp/mirror.
  if (px.x < 1.0 || px.x > u_resolution.x - 2.0 || px.y < 1.0 || px.y > u_resolution.y - 2.0) {
    fragColor = c;
    return;
  }

  float ang = radians(u_lightAngle);
  // lightAngle is always a multiple of 45 deg (UI step), so cos/sin land
  // exactly on {-1, -0.7071, 0, 0.7071, 1} and round() snaps each to one of
  // the 8 neighbor directions, matching Math.round(x+cos)/Math.round(y+sin)
  // in the source. GL v_uv.y=0 is the BOTTOM row while tooooools' canvas
  // y=0 is the TOP row, so the Y term is negated here to keep the light
  // direction reading the same way visually (e.g. angle=90 still looks like
  // light sweeping toward the bottom of the image on screen).
  vec2 dir = vec2(round(cos(ang)), round(-sin(ang)));

  vec2 neighborUv = (px + dir + 0.5) / u_resolution;
  vec4 nc = texture(u_tex, neighborUv);

  float here = brightnessOf(c);
  float there = brightnessOf(nc);
  float diff = there - here; // 0..1 units; tooooools compares this in 0..255 units

  vec3 outCol;
  if (abs(diff) * 255.0 > u_effectThreshold) {
    float v = clamp(here + diff * u_depth, 0.0, 1.0);
    outCol = vec3(v);
  } else {
    outCol = vec3(0.5); // 128/255 neutral gray, exactly like the source's flat-area fill
  }
  fragColor = vec4(outCol, c.a);
}`,
    },

    cellular: {
      id: 'cellular',
      name: 'Cellular',
      category: 'STYLIZE',
      params: [
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 128 },
        { key: 'cellSize', label: 'Cell size', type: 'range', min: 1, max: 10, step: 1, default: 2 },
        { key: 'steps', label: 'Steps', type: 'range', min: 1, max: 50, step: 1, default: 1 },
        {
          key: 'type',
          label: 'Type',
          type: 'select',
          default: 0,
          options: [
            { value: 0, label: 'Classic' },
            { value: 1, label: 'LTL' },
            { value: 2, label: 'MNCAB' },
            { value: 3, label: 'MNCC' },
          ],
        },
        // Classic (Life-like, Moore 3x3 neighborhood, neighbor SUM)
        { key: 'surviveLowerBound', label: 'Survive lower bound', type: 'range', min: 0, max: 8, step: 1, default: 1 },
        { key: 'surviveUpperBound', label: 'Survive upper bound', type: 'range', min: 0, max: 8, step: 1, default: 8 },
        { key: 'birthLowerBound', label: 'Birth lower bound', type: 'range', min: 0, max: 8, step: 1, default: 3 },
        { key: 'birthUpperBound', label: 'Birth upper bound', type: 'range', min: 0, max: 8, step: 1, default: 3 },
        // LTL (Larger-than-Life, 11x11 neighborhood, neighbor SUM)
        { key: 'ltlBirthLower', label: 'LTL birth lower', type: 'range', min: 0, max: 200, step: 1, default: 15 },
        { key: 'ltlBirthUpper', label: 'LTL birth upper', type: 'range', min: 0, max: 200, step: 1, default: 91 },
        { key: 'ltlSurviveLower', label: 'LTL survive lower', type: 'range', min: 0, max: 200, step: 1, default: 47 },
        { key: 'ltlSurviveUpper', label: 'LTL survive upper', type: 'range', min: 0, max: 200, step: 1, default: 102 },
        // MNCAB (two square-block neighborhood AVERAGES, radius 1 and 2, state-independent threshold)
        { key: 'mncaThreshold1', label: 'MNCA threshold 1', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35 },
        { key: 'mncaThreshold2', label: 'MNCA threshold 2', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7 },
        // MNCC (four ring AVERAGES radius 1..4, each in-band ring toggles current state)
        { key: 'mnccThreshold1Lower', label: 'MNCC N1 lower', type: 'range', min: 0, max: 1, step: 0.001, default: 0.262 },
        { key: 'mnccThreshold1Upper', label: 'MNCC N1 upper', type: 'range', min: 0, max: 1, step: 0.001, default: 0.903 },
        { key: 'mnccThreshold2Lower', label: 'MNCC N2 lower', type: 'range', min: 0, max: 1, step: 0.001, default: 0.342 },
        { key: 'mnccThreshold2Upper', label: 'MNCC N2 upper', type: 'range', min: 0, max: 1, step: 0.001, default: 0.378 },
        { key: 'mnccThreshold3Lower', label: 'MNCC N3 lower', type: 'range', min: 0, max: 1, step: 0.001, default: 0.342 },
        { key: 'mnccThreshold3Upper', label: 'MNCC N3 upper', type: 'range', min: 0, max: 1, step: 0.001, default: 0.382 },
        { key: 'mnccThreshold4Lower', label: 'MNCC N4 lower', type: 'range', min: 0, max: 1, step: 0.001, default: 0.889 },
        { key: 'mnccThreshold4Upper', label: 'MNCC N4 upper', type: 'range', min: 0, max: 1, step: 0.001, default: 0.978 },
      ],
      presets: {
        Tooooools: {
          threshold: 128, cellSize: 2, steps: 1, type: 0,
          surviveLowerBound: 1, surviveUpperBound: 8, birthLowerBound: 3, birthUpperBound: 3,
          ltlBirthLower: 15, ltlBirthUpper: 91, ltlSurviveLower: 47, ltlSurviveUpper: 102,
          mncaThreshold1: 0.35, mncaThreshold2: 0.7,
          mnccThreshold1Lower: 0.262, mnccThreshold1Upper: 0.903,
          mnccThreshold2Lower: 0.342, mnccThreshold2Upper: 0.378,
          mnccThreshold3Lower: 0.342, mnccThreshold3Upper: 0.382,
          mnccThreshold4Lower: 0.889, mnccThreshold4Upper: 0.978,
        },
        'LTL Blobs': {
          threshold: 128, cellSize: 3, steps: 20, type: 1,
          surviveLowerBound: 1, surviveUpperBound: 8, birthLowerBound: 3, birthUpperBound: 3,
          ltlBirthLower: 15, ltlBirthUpper: 91, ltlSurviveLower: 47, ltlSurviveUpper: 102,
          mncaThreshold1: 0.35, mncaThreshold2: 0.7,
          mnccThreshold1Lower: 0.262, mnccThreshold1Upper: 0.903,
          mnccThreshold2Lower: 0.342, mnccThreshold2Upper: 0.378,
          mnccThreshold3Lower: 0.342, mnccThreshold3Upper: 0.382,
          mnccThreshold4Lower: 0.889, mnccThreshold4Upper: 0.978,
        },
        'MNCC Mitosis': {
          threshold: 128, cellSize: 2, steps: 20, type: 3,
          surviveLowerBound: 1, surviveUpperBound: 8, birthLowerBound: 3, birthUpperBound: 3,
          ltlBirthLower: 15, ltlBirthUpper: 91, ltlSurviveLower: 47, ltlSurviveUpper: 102,
          mncaThreshold1: 0.35, mncaThreshold2: 0.7,
          mnccThreshold1Lower: 0.262, mnccThreshold1Upper: 0.903,
          mnccThreshold2Lower: 0.342, mnccThreshold2Upper: 0.378,
          mnccThreshold3Lower: 0.342, mnccThreshold3Upper: 0.382,
          mnccThreshold4Lower: 0.889, mnccThreshold4Upper: 0.978,
        },
      },
      // CPU stage (mutually exclusive with `frag`): ported from tooooools' p5 sketch
      // (cellular-automata chunk). Pipeline: binarize by luminance vs threshold ->
      // downsample into a Uint8Array cell grid (cellSize px per cell, ceil(w/h /
      // cellSize) cols/rows) -> run `steps` synchronous toroidal updates of the
      // selected rule set -> paint cells back to full resolution (1 = black, 0 =
      // white, matching their `fill(0)` cells on a `background(255)`).
      //
      // Performance: the original does a naive O(radius^2) neighbor loop per cell
      // per step (fine for their <=1000px canvas). LTL's 11x11 neighborhood and
      // MNCC's four rings (radii 1-4) at RSTR's OUTPUT resolution with cellSize=1
      // would be O(w*h*radius^2*steps) and hang. Ported instead onto a 2D
      // summed-area table (integral image) rebuilt once per step, giving O(1)
      // (amortized <=4 rect-sum lookups) toroidal neighborhood queries regardless
      // of radius. Falls back to the original's exact direct modulo loop only
      // when a grid dimension is smaller than the neighborhood diameter (tiny
      // grids only - correctness-preserving alias-matching edge case, negligible
      // cost). No RNG anywhere in the original rule sets, so this is already
      // fully deterministic.
      cpu: function (rgba, w, h, params) {
        const threshold = params.threshold != null ? params.threshold : 128;
        const cellSize = Math.max(1, Math.round(params.cellSize != null ? params.cellSize : 2));
        const steps = Math.max(0, Math.round(params.steps != null ? params.steps : 1));
        const type = Math.min(3, Math.max(0, Math.round(params.type != null ? params.type : 0)));

        const surviveLowerBound = params.surviveLowerBound != null ? params.surviveLowerBound : 1;
        const surviveUpperBound = params.surviveUpperBound != null ? params.surviveUpperBound : 8;
        const birthLowerBound = params.birthLowerBound != null ? params.birthLowerBound : 3;
        const birthUpperBound = params.birthUpperBound != null ? params.birthUpperBound : 3;

        const ltlBirthLower = params.ltlBirthLower != null ? params.ltlBirthLower : 15;
        const ltlBirthUpper = params.ltlBirthUpper != null ? params.ltlBirthUpper : 91;
        const ltlSurviveLower = params.ltlSurviveLower != null ? params.ltlSurviveLower : 47;
        const ltlSurviveUpper = params.ltlSurviveUpper != null ? params.ltlSurviveUpper : 102;

        const mncaThreshold1 = params.mncaThreshold1 != null ? params.mncaThreshold1 : 0.35;
        const mncaThreshold2 = params.mncaThreshold2 != null ? params.mncaThreshold2 : 0.7;

        const mnccLower = [
          params.mnccThreshold1Lower != null ? params.mnccThreshold1Lower : 0.262,
          params.mnccThreshold2Lower != null ? params.mnccThreshold2Lower : 0.342,
          params.mnccThreshold3Lower != null ? params.mnccThreshold3Lower : 0.342,
          params.mnccThreshold4Lower != null ? params.mnccThreshold4Lower : 0.889,
        ];
        const mnccUpper = [
          params.mnccThreshold1Upper != null ? params.mnccThreshold1Upper : 0.903,
          params.mnccThreshold2Upper != null ? params.mnccThreshold2Upper : 0.378,
          params.mnccThreshold3Upper != null ? params.mnccThreshold3Upper : 0.382,
          params.mnccThreshold4Upper != null ? params.mnccThreshold4Upper : 0.978,
        ];

        const cols = Math.max(1, Math.ceil(w / cellSize));
        const rows = Math.max(1, Math.ceil(h / cellSize));

        // ---- 1. binarize + downsample: cell = 1 ("alive"/black) if ANY pixel in
        // its cellSize x cellSize block has luminance (unweighted R+G+B / 3) <=
        // threshold, exactly matching the original's per-block scan-and-bail. ----
        const grid0 = new Uint8Array(rows * cols);
        for (let gy = 0; gy < rows; gy++) {
          const y0 = gy * cellSize;
          const y1 = Math.min(h, y0 + cellSize);
          const rowBase = gy * cols;
          for (let gx = 0; gx < cols; gx++) {
            const x0 = gx * cellSize;
            const x1 = Math.min(w, x0 + cellSize);
            let on = 0;
            scanY: for (let y = y0; y < y1; y++) {
              const base = y * w;
              for (let x = x0; x < x1; x++) {
                const i = (base + x) * 4;
                if ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 <= threshold) { on = 1; break scanY; }
              }
            }
            grid0[rowBase + gx] = on;
          }
        }

        let grid = grid0;

        if (steps > 0 && rows > 0 && cols > 0) {
          let next = new Uint8Array(rows * cols);
          const W = cols + 1;
          const sat = new Int32Array((rows + 1) * W); // summed-area table, rebuilt every step

          const buildSAT = (g) => {
            for (let x = 0; x <= cols; x++) sat[x] = 0;
            for (let y = 0; y < rows; y++) {
              const cur = (y + 1) * W;
              const prev = y * W;
              let rowSum = 0;
              sat[cur] = 0;
              for (let x = 0; x < cols; x++) {
                rowSum += g[y * cols + x];
                sat[cur + x + 1] = sat[prev + x + 1] + rowSum;
              }
            }
          };

          // inclusive rect sum [r0,r1] x [c0,c1] against the current SAT (no wrap)
          const rectSum = (r0, r1, c0, c1) =>
            sat[(r1 + 1) * W + (c1 + 1)] - sat[r0 * W + (c1 + 1)] - sat[(r1 + 1) * W + c0] + sat[r0 * W + c0];

          // Per-axis wrap-range table for radius r: for every index c in
          // [0,size) precomputes the (<=2) non-wrapping [lo,hi] sub-ranges that
          // together cover the toroidal span [c-r, c+r]. This geometry depends
          // only on (size, r) - never on grid contents - so it is built ONCE
          // per radius, outside the `steps` loop, and reused for every cell in
          // every step (instead of re-deriving the wrap branches per cell per
          // step, which is what made the naive SAT lookup measurably slower on
          // large full-res grids). Returns null when the neighborhood diameter
          // exceeds the axis size (aliasing) - caller then uses the exact
          // direct modulo loop for that radius.
          const buildAxisTable = (size, r) => {
            if (2 * r + 1 > size) return null;
            const r0a = new Int32Array(size);
            const r1a = new Int32Array(size);
            const r0b = new Int32Array(size).fill(-1);
            const r1b = new Int32Array(size);
            for (let c = 0; c < size; c++) {
              const lo = c - r, hi = c + r;
              if (lo >= 0 && hi < size) { r0a[c] = lo; r1a[c] = hi; }
              else if (lo < 0) { r0a[c] = size + lo; r1a[c] = size - 1; r0b[c] = 0; r1b[c] = hi; }
              else { r0a[c] = lo; r1a[c] = size - 1; r0b[c] = 0; r1b[c] = hi - size; }
            }
            return { r0a, r1a, r0b, r1b };
          };

          // O(1) (<=4 rect-sum lookups, no branching, no allocation) toroidal
          // square-neighborhood SUM (radius r, center excluded) using
          // precomputed row/col tables.
          const ringSum = (g, rowT, colT, row, col) => {
            const ra0 = rowT.r0a[row], ra1 = rowT.r1a[row], rb0 = rowT.r0b[row], rb1 = rowT.r1b[row];
            const ca0 = colT.r0a[col], ca1 = colT.r1a[col], cb0 = colT.r0b[col], cb1 = colT.r1b[col];
            let sum = rectSum(ra0, ra1, ca0, ca1);
            if (rb0 >= 0) sum += rectSum(rb0, rb1, ca0, ca1);
            if (cb0 >= 0) sum += rectSum(ra0, ra1, cb0, cb1);
            if (rb0 >= 0 && cb0 >= 0) sum += rectSum(rb0, rb1, cb0, cb1);
            return sum - g[row * cols + col];
          };

          // exact fallback: the original's direct per-offset modulo sum (only
          // reached for grids smaller than the neighborhood diameter - tiny, so
          // the O(radius^2) cost here is negligible)
          const neighborSumDirect = (g, row, col, r) => {
            let sum = 0;
            for (let dy = -r; dy <= r; dy++) {
              const ry = ((row + dy) % rows + rows) % rows;
              const base = ry * cols;
              for (let dx = -r; dx <= r; dx++) {
                if (dy === 0 && dx === 0) continue;
                sum += g[base + (((col + dx) % cols) + cols) % cols];
              }
            }
            return sum;
          };

          const neighborSum = (g, row, col, r, rowT, colT) =>
            rowT && colT ? ringSum(g, rowT, colT, row, col) : neighborSumDirect(g, row, col, r);

          // Build only the axis tables the selected rule set actually needs.
          // Plain named locals (not array/object lookups) so the hot per-cell
          // loop below stays monomorphic for the JIT.
          let rowT1 = null, colT1 = null, rowT2 = null, colT2 = null;
          let rowT3 = null, colT3 = null, rowT4 = null, colT4 = null;
          let rowT5 = null, colT5 = null;
          if (type === 0) {
            rowT1 = buildAxisTable(rows, 1); colT1 = buildAxisTable(cols, 1);
          } else if (type === 1) {
            rowT5 = buildAxisTable(rows, 5); colT5 = buildAxisTable(cols, 5);
          } else if (type === 2) {
            rowT1 = buildAxisTable(rows, 1); colT1 = buildAxisTable(cols, 1);
            rowT2 = buildAxisTable(rows, 2); colT2 = buildAxisTable(cols, 2);
          } else {
            rowT1 = buildAxisTable(rows, 1); colT1 = buildAxisTable(cols, 1);
            rowT2 = buildAxisTable(rows, 2); colT2 = buildAxisTable(cols, 2);
            rowT3 = buildAxisTable(rows, 3); colT3 = buildAxisTable(cols, 3);
            rowT4 = buildAxisTable(rows, 4); colT4 = buildAxisTable(cols, 4);
          }
          const mnccLower1 = mnccLower[0], mnccUpper1 = mnccUpper[0];
          const mnccLower2 = mnccLower[1], mnccUpper2 = mnccUpper[1];
          const mnccLower3 = mnccLower[2], mnccUpper3 = mnccUpper[2];
          const mnccLower4 = mnccLower[3], mnccUpper4 = mnccUpper[3];

          for (let s = 0; s < steps; s++) {
            buildSAT(grid);

            if (type === 0) {
              // Classic: Life-like, Moore 3x3 neighborhood (radius 1), neighbor SUM.
              // Alive cell survives iff sum in [surviveLower,surviveUpper]; dead
              // cell is born iff sum in [birthLower,birthUpper].
              for (let row = 0; row < rows; row++) {
                const rowBase = row * cols;
                for (let col = 0; col < cols; col++) {
                  const n = neighborSum(grid, row, col, 1, rowT1, colT1);
                  const idx = rowBase + col;
                  next[idx] = grid[idx]
                    ? (n >= surviveLowerBound && n <= surviveUpperBound ? 1 : 0)
                    : (n >= birthLowerBound && n <= birthUpperBound ? 1 : 0);
                }
              }
            } else if (type === 1) {
              // LTL (Larger-than-Life): same survive/birth-by-sum logic as
              // Classic but over an 11x11 (radius 5) square neighborhood.
              for (let row = 0; row < rows; row++) {
                const rowBase = row * cols;
                for (let col = 0; col < cols; col++) {
                  const n = neighborSum(grid, row, col, 5, rowT5, colT5);
                  const idx = rowBase + col;
                  next[idx] = grid[idx]
                    ? (n >= ltlSurviveLower && n <= ltlSurviveUpper ? 1 : 0)
                    : (n >= ltlBirthLower && n <= ltlBirthUpper ? 1 : 0);
                }
              }
            } else if (type === 2) {
              // MNCAB: two square-block neighborhood AVERAGES (radius 1 = 8
              // cells, radius 2 = 24 cells). New state ignores current state:
              // cell turns on iff EITHER average falls inside
              // [mncaThreshold1, mncaThreshold2].
              for (let row = 0; row < rows; row++) {
                const rowBase = row * cols;
                for (let col = 0; col < cols; col++) {
                  const avg1 = neighborSum(grid, row, col, 1, rowT1, colT1) / 8;
                  const avg2 = neighborSum(grid, row, col, 2, rowT2, colT2) / 24;
                  const on =
                    (avg1 >= mncaThreshold1 && avg1 <= mncaThreshold2) ||
                    (avg2 >= mncaThreshold1 && avg2 <= mncaThreshold2);
                  next[rowBase + col] = on ? 1 : 0;
                }
              }
            } else {
              // MNCC: four ring AVERAGES (radii 1..4, i.e. 8/24/48/80 cells).
              // Starting from the current state, each ring in turn TOGGLES the
              // state if that ring's average falls inside its own
              // [Lower,Upper] band (rings applied sequentially 1->2->3->4,
              // each acting on the toggle result of the previous ring).
              for (let row = 0; row < rows; row++) {
                const rowBase = row * cols;
                for (let col = 0; col < cols; col++) {
                  let state = grid[rowBase + col];
                  const avg1 = neighborSum(grid, row, col, 1, rowT1, colT1) / 8;
                  if (avg1 >= mnccLower1 && avg1 <= mnccUpper1) state = 1 - state;
                  const avg2 = neighborSum(grid, row, col, 2, rowT2, colT2) / 24;
                  if (avg2 >= mnccLower2 && avg2 <= mnccUpper2) state = 1 - state;
                  const avg3 = neighborSum(grid, row, col, 3, rowT3, colT3) / 48;
                  if (avg3 >= mnccLower3 && avg3 <= mnccUpper3) state = 1 - state;
                  const avg4 = neighborSum(grid, row, col, 4, rowT4, colT4) / 80;
                  if (avg4 >= mnccLower4 && avg4 <= mnccUpper4) state = 1 - state;
                  next[rowBase + col] = state;
                }
              }
            }

            const tmp = grid; grid = next; next = tmp;
          }
        }

        // ---- 3. paint the final grid back to full resolution: 1 = black,
        // 0 = white (their `fill(0)` rects on a `background(255)`); alpha is
        // carried through from the source pixel (the original had no alpha
        // channel concept - opaque p5 canvas). ----
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          const gy = Math.min(rows - 1, (y / cellSize) | 0);
          const gRowBase = gy * cols;
          const rowBase = y * w;
          for (let x = 0; x < w; x++) {
            const gx = Math.min(cols - 1, (x / cellSize) | 0);
            const v = grid[gRowBase + gx] ? 0 : 255;
            const o = (rowBase + x) * 4;
            out[o] = v; out[o + 1] = v; out[o + 2] = v;
            out[o + 3] = rgba[o + 3];
          }
        }
        return out;
      },
    },

    bloom: {
      id: 'bloom',
      name: 'Bloom',
      category: 'STYLIZE',
      params: [
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 1, step: 0.01, default: 0.6 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 0, max: 3, step: 0.05, default: 1 },
        { key: 'radius', label: 'Radius', type: 'range', min: 0.5, max: 6, step: 0.1, default: 2 },
      ],
      presets: {
        'Soft glow': { threshold: 0.7, intensity: 0.8, radius: 2 },
        Dreamy: { threshold: 0.5, intensity: 1.5, radius: 4 },
        Nuclear: { threshold: 0.3, intensity: 2.5, radius: 5 },
      },
      frag: `${HEAD}
uniform float u_threshold;
uniform float u_intensity;
uniform float u_radius;

void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 texel = (1.0 / u_resolution) * max(u_radius, 0.5);
  vec3 bloomSum = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 offset = vec2(float(x), float(y)) * texel;
      vec3 s = texture(u_tex, clamp(v_uv + offset, vec2(0.0), vec2(1.0))).rgb;
      float b = max(dot(s, vec3(0.299, 0.587, 0.114)) - u_threshold, 0.0);
      bloomSum += s * b;
      wsum += 1.0;
    }
  }
  bloomSum /= max(wsum, 1.0);
  vec3 outColor = c.rgb + bloomSum * u_intensity;
  fragColor = vec4(clamp(outColor, 0.0, 1.0), c.a);
}`,
    },
  };

  // Exposed so ui.js's stops-bar control (gradient preview canvas + the
  // double-click-to-add-stop LUT sample) shares the EXACT same interpolation
  // as the cpu() render stage above -- one implementation, not a parallel port.
  EFFECTS.gradientmap.buildLut = buildGradientLut;

  const EFFECT_LIST = Object.keys(EFFECTS).map((id) => EFFECTS[id]);

  function getEffect(id) {
    const def = EFFECTS[id];
    if (!def) throw new Error(`Unknown effect: ${id}`);
    return def;
  }

  function defaultParams(id) {
    const def = getEffect(id);
    const params = {};
    for (const p of def.params) params[p.key] = cloneParamValue(p.default);
    return params;
  }

  RSTR.EFFECTS = EFFECTS;
  RSTR.EFFECT_LIST = EFFECT_LIST;
  RSTR.getEffect = getEffect;
  RSTR.defaultParams = defaultParams;
})((window.RSTR = window.RSTR || {}));
