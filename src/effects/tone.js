// effects/tone.js — TONE category effect entries.
(function (RSTR) {
  'use strict';
  const HEAD = RSTR._effectHead;
  Object.assign(RSTR.EFFECTS, {
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
  });
})((window.RSTR = window.RSTR || {}));
