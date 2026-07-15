// effects/color.js — COLOR category effect entries.
(function (RSTR) {
  'use strict';
  const HEAD = RSTR._effectHead;
  Object.assign(RSTR.EFFECTS, {
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
  });
})((window.RSTR = window.RSTR || {}));
