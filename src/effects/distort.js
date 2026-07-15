// effects/distort.js — DISTORT category effect entries.
(function (RSTR) {
  'use strict';
  const HEAD = RSTR._effectHead;
  Object.assign(RSTR.EFFECTS, {
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
  });
})((window.RSTR = window.RSTR || {}));
