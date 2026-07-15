// pipeline.js — runs an ordered stack of effects over an image using ping-pong
// framebuffers. The OUTPUT block is applied BEFORE effects: input -> center-crop
// to aspect -> resize (longest side = size) -> run effect passes at THAT
// resolution -> encode to format@quality. The editor canvas shows this exact
// buffer, so preview == exported output. Used identically by editor and engine.
(function (RSTR) {
  'use strict';

  const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main() {
  fragColor = texture(u_tex, v_uv);
}`;

  // Base plate (the pinned "◇ ORIGINAL" row, bottom of the LAYERS stack):
  // a FINAL pass that composites the finished stack result (u_tex, "top")
  // source-over the raw original source texture (u_plate, "bottom") ×
  // u_opacity. This is real Porter-Duff "over", not mix() -- both top and
  // bottom carry their own alpha, and where both are partially transparent
  // a naive mix() gives the wrong answer (see the premultiply/un-premultiply
  // below). u_opacity multiplies the PLATE's alpha only, so it reads as "how
  // strongly the original shows through", not a global fade. See
  // src/preset.js's `source` block and this file's render().
  const PLATE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;   // finished stack result (top / Porter-Duff "source")
uniform sampler2D u_plate; // raw original source texture (bottom / "backdrop")
uniform float u_opacity;   // multiplies the plate's alpha
void main() {
  vec4 top = texture(u_tex, v_uv);
  vec4 bot = texture(u_plate, v_uv);
  float botA = bot.a * u_opacity;
  float outA = top.a + botA * (1.0 - top.a);
  vec3 outRGBPremul = top.rgb * top.a + bot.rgb * botA * (1.0 - top.a);
  vec3 outRGB = outA > 0.0 ? outRGBPremul / outA : vec3(0.0);
  fragColor = vec4(outRGB, outA);
}`;

  // Per-layer opacity, blend = 'normal' fast path: mixes a pass's output back
  // over its own input. UNTOUCHED since before blend modes existed — kept
  // byte-for-byte identical (own program, own code path) so old style codes
  // with no `blend` key render pixel-identical to before this feature landed.
  // MASK support (2026-07-12) is grafted on as a conditional branch that is a
  // pure no-op when u_hasMask == 0 (the default for every pre-mask style
  // code, and every layer not fed by a `mask` layer) -- `o` stays exactly
  // `u_opacity` and the mix() call is byte-for-byte what it always was.
  const BLEND_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;  // effect output
uniform sampler2D u_prev; // the same pass's input
uniform float u_opacity;
uniform sampler2D u_mask;     // preceding MASK layer's raw effect output (luminance = mask)
uniform int u_hasMask;        // 0 = no mask feeding this layer (old behavior, untouched)
uniform int u_maskInvert;
float rstrLumaMask(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  float o = u_opacity;
  if (u_hasMask == 1) {
    float m = rstrLumaMask(texture(u_mask, v_uv).rgb);
    if (u_maskInvert == 1) m = 1.0 - m;
    o *= m;
  }
  fragColor = mix(texture(u_prev, v_uv), texture(u_tex, v_uv), o);
}`;

  // Per-layer BLEND MODES (blend !== 'normal'): W3C Compositing and Blending
  // Level 1 (https://www.w3.org/TR/compositing-1/#blending), ported verbatim
  // -- separable modes + the four non-separable modes via the spec's own
  // Lum/ClipColor/SetLum/Sat/SetSat helpers -- plus RSTR's own alpha /
  // alpha-invert (see src/preset.js BLEND_MODES for the id<->index order this
  // shader's `u_blend` switches on). `b` = backdrop = this pass's input,
  // `s` = source = this pass's raw effect output; final composite is
  // `mix(b, blend(b,s), opacity)` done per-channel INCLUDING alpha, same as
  // the plain BLEND_FRAG above.
  const BLEND_MODE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;  // effect output (source, s)
uniform sampler2D u_prev; // the same pass's input (backdrop, b)
uniform float u_opacity;
uniform int u_blend;
uniform sampler2D u_mask;      // preceding MASK layer's raw effect output (luminance = mask)
uniform int u_hasMask;         // 0 = no mask feeding this layer -- byte-identical to pre-mask output
uniform int u_maskInvert;

// --- W3C non-separable helpers (ported verbatim, do not "simplify") -------
float w3cLum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
float w3cSat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 clipColor(vec3 c) {
  float l = w3cLum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}

vec3 setLum(vec3 c, float l) {
  float d = l - w3cLum(c);
  return clipColor(c + d);
}

// Spec: "the subscripts min, mid, and max ... refer to the color components
// having the minimum, middle, and maximum values upon entry" -- branch on
// WHICH channel is which instead of sorting a vec3.
vec3 setSat(vec3 c, float s) {
  float cmin = min(c.r, min(c.g, c.b));
  float cmax = max(c.r, max(c.g, c.b));
  if (cmax > cmin) {
    if (c.r == cmax) {
      if (c.g == cmin) { c.b = (c.b - cmin) * s / (cmax - cmin); c.r = s; c.g = 0.0; }
      else { c.g = (c.g - cmin) * s / (cmax - cmin); c.r = s; c.b = 0.0; }
    } else if (c.g == cmax) {
      if (c.r == cmin) { c.b = (c.b - cmin) * s / (cmax - cmin); c.g = s; c.r = 0.0; }
      else { c.r = (c.r - cmin) * s / (cmax - cmin); c.g = s; c.b = 0.0; }
    } else {
      if (c.r == cmin) { c.g = (c.g - cmin) * s / (cmax - cmin); c.b = s; c.r = 0.0; }
      else { c.r = (c.r - cmin) * s / (cmax - cmin); c.b = s; c.g = 0.0; }
    }
  } else {
    c = vec3(0.0);
  }
  return c;
}

// --- separable per-channel formulas ---------------------------------------
float blMultiply(float cb, float cs) { return cb * cs; }
float blScreen(float cb, float cs) { return cb + cs - cb * cs; }
// generic HardLight(x,y): the branch is on y. Overlay(Cb,Cs) = HardLight(Cs,Cb)
// per spec, i.e. called with the args swapped -- see case 9 below.
float blHardLightCh(float x, float y) {
  return y <= 0.5 ? blMultiply(x, 2.0 * y) : blScreen(x, 2.0 * y - 1.0);
}
float blColorDodgeCh(float cb, float cs) {
  if (cb <= 0.0) return 0.0;
  if (cs >= 1.0) return 1.0;
  return min(1.0, cb / (1.0 - cs));
}
float blColorBurnCh(float cb, float cs) {
  if (cb >= 1.0) return 1.0;
  if (cs <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - cb) / cs);
}
float blSoftLightCh(float cb, float cs) {
  float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
  return cs <= 0.5 ? cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb) : cb + (2.0 * cs - 1.0) * (d - cb);
}

// u_blend indices match src/preset.js BLEND_MODES order exactly.
float separableChannel(int mode, float cb, float cs) {
  if (mode == 0) return cs;                              // normal
  if (mode == 1) return min(cb, cs);                      // darken
  if (mode == 2) return blMultiply(cb, cs);               // multiply
  if (mode == 3) return clamp(cb + cs - 1.0, 0.0, 1.0);   // linear-burn (not in W3C separable list; Photoshop/Figma extra)
  if (mode == 4) return blColorBurnCh(cb, cs);            // color-burn
  if (mode == 5) return max(cb, cs);                      // lighten
  if (mode == 6) return blScreen(cb, cs);                 // screen
  if (mode == 7) return clamp(cb + cs, 0.0, 1.0);         // linear-dodge (Photoshop/Figma extra)
  if (mode == 8) return blColorDodgeCh(cb, cs);           // color-dodge
  if (mode == 9) return blHardLightCh(cs, cb);            // overlay = HardLight(Cs,Cb)
  if (mode == 10) return blSoftLightCh(cb, cs);           // soft-light
  if (mode == 11) return blHardLightCh(cb, cs);           // hard-light
  if (mode == 12) return abs(cb - cs);                    // difference
  if (mode == 13) return cb + cs - 2.0 * cb * cs;         // exclusion
  return cs;
}

vec3 blendHue(vec3 cb, vec3 cs) { return setLum(setSat(cs, w3cSat(cb)), w3cLum(cb)); }
vec3 blendSaturation(vec3 cb, vec3 cs) { return setLum(setSat(cb, w3cSat(cs)), w3cLum(cb)); }
vec3 blendColorMode(vec3 cb, vec3 cs) { return setLum(cs, w3cLum(cb)); }
vec3 blendLuminosity(vec3 cb, vec3 cs) { return setLum(cb, w3cLum(cs)); }

// RSTR's own: the effect layer's B/W output masks its own input. luma weight
// matches the codebase's existing convention (see e.g. effects.js threshold),
// deliberately NOT the W3C 0.3/0.59/0.11 used by the four modes above -- that
// triple is spec-mandated for Lum() specifically, this is RSTR's own mode.
float rstrLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec4 b = texture(u_prev, v_uv);
  vec4 s = texture(u_tex, v_uv);
  vec4 blended;

  if (u_blend == 18) {                          // alpha
    blended = vec4(b.rgb, b.a * rstrLuma(s.rgb));
  } else if (u_blend == 19) {                   // alpha-invert
    blended = vec4(b.rgb, b.a * (1.0 - rstrLuma(s.rgb)));
  } else if (u_blend >= 14 && u_blend <= 17) {   // hue / saturation / color / luminosity
    vec3 rgb;
    if (u_blend == 14) rgb = blendHue(b.rgb, s.rgb);
    else if (u_blend == 15) rgb = blendSaturation(b.rgb, s.rgb);
    else if (u_blend == 16) rgb = blendColorMode(b.rgb, s.rgb);
    else rgb = blendLuminosity(b.rgb, s.rgb);
    blended = vec4(rgb, s.a);
  } else {
    vec3 rgb = vec3(
      separableChannel(u_blend, b.r, s.r),
      separableChannel(u_blend, b.g, s.g),
      separableChannel(u_blend, b.b, s.b)
    );
    blended = vec4(rgb, s.a);
  }

  float o = u_opacity;
  if (u_hasMask == 1) {
    float m = rstrLuma(texture(u_mask, v_uv).rgb);
    if (u_maskInvert == 1) m = 1.0 - m;
    o *= m;
  }
  fragColor = mix(b, blended, o);
}`;

  function layerOpacity(step) {
    const v = step.opacity != null ? Number(step.opacity) : 1;
    return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  }

  // Same clamp/parse rule as layerOpacity, for the top-level `source` block
  // (RSTR.preset.normalizeSource does the same thing -- duplicated here,
  // defensively, on the same precedent as layerBlend's comment above: the
  // editor drives render() straight off live state, not through preset.js's
  // own validation).
  function sourceOpacity(source) {
    const v = source && source.opacity != null ? Number(source.opacity) : 1;
    return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  }

  // Valid blend id (from RSTR.preset.BLEND_IDS) or 'normal' -- defensive,
  // independent of preset.js's own validatePreset, because the editor drives
  // pipeline.render() straight off live state.mix (never funneled through
  // validatePreset). preset.js loads AFTER this file but BEFORE any render()
  // call actually runs, same precedent as RSTR.preset.normalizeOutput() calls
  // elsewhere in this file.
  function layerBlend(step) {
    const v = step.blend;
    if (!v || v === 'normal') return 'normal';
    const ids = (RSTR.preset && RSTR.preset.BLEND_IDS) || [];
    return ids.indexOf(v) >= 0 ? v : 'normal';
  }

  // --- MASK (per-layer stencil flag) -----------------------------------------
  // Presence of `step.mask` (an object) means this layer is a MASK: it is
  // NEVER composited into the image (render() below routes it into its own
  // branch, entirely separate from the opacity/blend pass) -- its raw effect
  // output's luminance instead becomes a per-pixel multiplier on the blend
  // opacity of the next enabled, non-mask layer. Garbage values (non-object)
  // normalize to "no mask", same defensive posture as layerBlend/layerOpacity
  // above (the editor drives render() straight off live state.mix, never
  // funneled through preset.js's own validatePreset).
  function isMaskLayer(step) {
    return !!(step.mask && typeof step.mask === 'object');
  }
  function maskInvert(step) {
    return !!(step.mask && step.mask.invert === true);
  }

  // --- CPU-stage blend math (dither F-S / ascii) -----------------------------
  // Must produce IDENTICAL results to BLEND_MODE_FRAG above -- same formulas,
  // same order, ported from the same W3C spec section. Operates on 0..1
  // floats; the per-pixel byte<->float conversion happens in applyCpuBlend().
  function cpuW3cLum(c) { return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; }
  function cpuW3cSat(c) { return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); }

  function cpuClipColor(c) {
    let [r, g, b] = c;
    const l = cpuW3cLum(c);
    const n = Math.min(r, g, b);
    const x = Math.max(r, g, b);
    if (n < 0) {
      r = l + ((r - l) * l) / (l - n);
      g = l + ((g - l) * l) / (l - n);
      b = l + ((b - l) * l) / (l - n);
    }
    if (x > 1) {
      r = l + ((r - l) * (1 - l)) / (x - l);
      g = l + ((g - l) * (1 - l)) / (x - l);
      b = l + ((b - l) * (1 - l)) / (x - l);
    }
    return [r, g, b];
  }

  function cpuSetLum(c, l) {
    const d = l - cpuW3cLum(c);
    return cpuClipColor([c[0] + d, c[1] + d, c[2] + d]);
  }

  // Spec's min/mid/max-by-value branching, done via a sorted index list
  // (equivalent to the GLSL version's explicit which-channel-is-which branches).
  function cpuSetSat(c, s) {
    const idx = [0, 1, 2].sort((i, j) => c[i] - c[j]);
    const [iMin, iMid, iMax] = idx;
    const out = [0, 0, 0];
    if (c[iMax] > c[iMin]) {
      out[iMid] = ((c[iMid] - c[iMin]) * s) / (c[iMax] - c[iMin]);
      out[iMax] = s;
    }
    out[iMin] = 0;
    return out;
  }

  function cpuMultiply(cb, cs) { return cb * cs; }
  function cpuScreen(cb, cs) { return cb + cs - cb * cs; }
  function cpuHardLightCh(x, y) { return y <= 0.5 ? cpuMultiply(x, 2 * y) : cpuScreen(x, 2 * y - 1); }
  function cpuColorDodgeCh(cb, cs) {
    if (cb <= 0) return 0;
    if (cs >= 1) return 1;
    return Math.min(1, cb / (1 - cs));
  }
  function cpuColorBurnCh(cb, cs) {
    if (cb >= 1) return 1;
    if (cs <= 0) return 0;
    return 1 - Math.min(1, (1 - cb) / cs);
  }
  function cpuSoftLightCh(cb, cs) {
    const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (d - cb);
  }

  function cpuSeparableChannel(mode, cb, cs) {
    switch (mode) {
      case 'normal': return cs;
      case 'darken': return Math.min(cb, cs);
      case 'multiply': return cpuMultiply(cb, cs);
      case 'linear-burn': return Math.max(0, Math.min(1, cb + cs - 1));
      case 'color-burn': return cpuColorBurnCh(cb, cs);
      case 'lighten': return Math.max(cb, cs);
      case 'screen': return cpuScreen(cb, cs);
      case 'linear-dodge': return Math.max(0, Math.min(1, cb + cs));
      case 'color-dodge': return cpuColorDodgeCh(cb, cs);
      case 'overlay': return cpuHardLightCh(cs, cb); // Overlay(Cb,Cs) = HardLight(Cs,Cb)
      case 'soft-light': return cpuSoftLightCh(cb, cs);
      case 'hard-light': return cpuHardLightCh(cb, cs);
      case 'difference': return Math.abs(cb - cs);
      case 'exclusion': return cb + cs - 2 * cb * cs;
      default: return cs;
    }
  }

  function cpuRstrLuma(c) { return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }

  // b, s = [r,g,b,a] 0..1. Returns blend(b,s) BEFORE the opacity mix (matches
  // the GLSL main()'s `blended` value, pre-mix).
  function blendRGBA(mode, b, s) {
    if (mode === 'alpha') return [b[0], b[1], b[2], b[3] * cpuRstrLuma(s)];
    if (mode === 'alpha-invert') return [b[0], b[1], b[2], b[3] * (1 - cpuRstrLuma(s))];
    if (mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity') {
      const cb3 = [b[0], b[1], b[2]];
      const cs3 = [s[0], s[1], s[2]];
      let rgb;
      if (mode === 'hue') rgb = cpuSetLum(cpuSetSat(cs3, cpuW3cSat(cb3)), cpuW3cLum(cb3));
      else if (mode === 'saturation') rgb = cpuSetLum(cpuSetSat(cb3, cpuW3cSat(cs3)), cpuW3cLum(cb3));
      else if (mode === 'color') rgb = cpuSetLum(cs3, cpuW3cLum(cb3));
      else rgb = cpuSetLum(cb3, cpuW3cLum(cs3));
      return [rgb[0], rgb[1], rgb[2], s[3]];
    }
    return [
      cpuSeparableChannel(mode, b[0], s[0]),
      cpuSeparableChannel(mode, b[1], s[1]),
      cpuSeparableChannel(mode, b[2], s[2]),
      s[3],
    ];
  }

  // Full per-pixel result AFTER the opacity mix: mix(b, blend(b,s), opacity)
  // applied to every channel including alpha. Exported (RSTR._blendPixel) so
  // the verification harness exercises this exact function, not a re-implementation.
  function blendPixel(mode, b, s, opacity) {
    const br = blendRGBA(mode, b, s);
    return [
      b[0] + (br[0] - b[0]) * opacity,
      b[1] + (br[1] - b[1]) * opacity,
      b[2] + (br[2] - b[2]) * opacity,
      b[3] + (br[3] - b[3]) * opacity,
    ];
  }

  function clampByte(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  // Mutates `out` (bytes, 0..255) in place: out := mix(inCopy, blend(inCopy,out), opacity).
  function applyCpuBlend(out, inCopy, blend, opacity) {
    for (let i = 0; i < out.length; i += 4) {
      const b = [inCopy[i] / 255, inCopy[i + 1] / 255, inCopy[i + 2] / 255, inCopy[i + 3] / 255];
      const s = [out[i] / 255, out[i + 1] / 255, out[i + 2] / 255, out[i + 3] / 255];
      const r = blendPixel(blend, b, s, opacity);
      out[i] = clampByte(r[0] * 255);
      out[i + 1] = clampByte(r[1] * 255);
      out[i + 2] = clampByte(r[2] * 255);
      out[i + 3] = clampByte(r[3] * 255);
    }
  }

  // Mask-aware CPU blend (only path a CPU-stage layer takes when a preceding
  // MASK layer is feeding it): identical to applyCpuBlend, but each pixel's
  // effective opacity is additionally scaled by the mask layer's raw-output
  // luminance -- SAME cpuRstrLuma weighting used everywhere else in this
  // file (see cpuRstrLuma above / rstrLuma in BLEND_MODE_FRAG), inverted per
  // `invert`. `maskPixels` is the mask layer's raw RGBA output at the same
  // resolution as `out`/`inCopy`. Never touches applyCpuBlend's own code path
  // (that one stays exactly as it was for the no-mask case).
  function applyCpuBlendMasked(out, inCopy, blend, opacity, maskPixels, invert) {
    for (let i = 0; i < out.length; i += 4) {
      let m = cpuRstrLuma([maskPixels[i] / 255, maskPixels[i + 1] / 255, maskPixels[i + 2] / 255]);
      if (invert) m = 1 - m;
      const o = opacity * m;
      const b = [inCopy[i] / 255, inCopy[i + 1] / 255, inCopy[i + 2] / 255, inCopy[i + 3] / 255];
      const s = [out[i] / 255, out[i + 1] / 255, out[i + 2] / 255, out[i + 3] / 255];
      const r = blendPixel(blend, b, s, o);
      out[i] = clampByte(r[0] * 255);
      out[i + 1] = clampByte(r[1] * 255);
      out[i + 2] = clampByte(r[2] * 255);
      out[i + 3] = clampByte(r[3] * 255);
    }
  }

  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    const bigint = parseInt(h, 16);
    return [((bigint >> 16) & 255) / 255, ((bigint >> 8) & 255) / 255, (bigint & 255) / 255];
  }

  // Max stops a `type: 'stops'` param can upload as uniforms — MUST match the
  // array size declared in any frag using it (currently just gradientmap's
  // `u_stopPos[8]`/`u_stopColor[8]`, see src/effects.js). 8 is plenty for a
  // gradient map; a longer `stops` array is sorted first (so the kept stops
  // are always the lowest-position ones), then truncated, with a console
  // warning — never a crash or a silently wrong shader upload.
  const MAX_STOPS = 8;

  // Fallback identical to buildGradientLut's own fallback (src/effects.js) —
  // used only if a `stops` value somehow reaches here with < 2 valid entries,
  // which shouldn't happen: RSTR.preset.validatePreset's sanitizeStops (for
  // loaded/pasted codes) and the registry's own `default` (for a fresh layer)
  // both already guarantee >= 2 valid stops by this point.
  const FALLBACK_STOPS = [
    { pos: 0, color: '#1a0b2e' },
    { pos: 1, color: '#ff6b35' },
  ];

  // Upload a `type: 'stops'` param as three uniforms on `program`:
  // u_stopPos[8] / u_stopColor[8] / u_stopCount. Stops are sorted ascending
  // by `pos` here (once per draw call, JS side) so the shader itself never
  // needs to sort -- same sort buildGradientLut already applies for the
  // editor's stops-bar preview. A no-op (returns early) on any program that
  // doesn't declare these uniforms, i.e. every effect other than gradientmap.
  function uploadStopsUniform(gl, program, value) {
    let stops = Array.isArray(value)
      ? value.filter((s) => s && typeof s.pos === 'number' && typeof s.color === 'string')
      : [];
    if (stops.length < 2) stops = FALLBACK_STOPS;
    stops = stops.slice().sort((a, b) => a.pos - b.pos);
    if (stops.length > MAX_STOPS) {
      console.warn(`RSTR: gradientmap stops truncated to ${MAX_STOPS} (had ${stops.length})`);
      stops = stops.slice(0, MAX_STOPS);
    }
    const posLoc = gl.getUniformLocation(program, 'u_stopPos[0]');
    const colorLoc = gl.getUniformLocation(program, 'u_stopColor[0]');
    const countLoc = gl.getUniformLocation(program, 'u_stopCount');
    if (!posLoc && !colorLoc && !countLoc) return; // this program has no stops uniforms
    const posArr = new Float32Array(MAX_STOPS);
    const colorArr = new Float32Array(MAX_STOPS * 3);
    for (let i = 0; i < stops.length; i++) {
      posArr[i] = stops[i].pos;
      const rgb = hexToRgb(stops[i].color);
      colorArr[i * 3] = rgb[0];
      colorArr[i * 3 + 1] = rgb[1];
      colorArr[i * 3 + 2] = rgb[2];
    }
    if (posLoc) gl.uniform1fv(posLoc, posArr);
    if (colorLoc) gl.uniform3fv(colorLoc, colorArr);
    if (countLoc) gl.uniform1i(countLoc, stops.length);
  }

  // Given a source w/h and a normalized OUTPUT block, compute the crop source
  // rect (ratio + align anchor) and the final target dimensions (scale mode).
  function computeGeometry(srcW, srcH, output) {
    let cropW = srcW;
    let cropH = srcH;
    let sx = 0;
    let sy = 0;

    const ratio = output.crop && output.crop.ratio;
    if (ratio && ratio !== 'original') {
      const parts = ratio.split(':');
      const targetRatio = Number(parts[0]) / Number(parts[1]);
      if (isFinite(targetRatio) && targetRatio > 0) {
        const srcRatio = srcW / srcH;
        if (srcRatio > targetRatio) {
          cropH = srcH;
          cropW = Math.round(srcH * targetRatio);
        } else {
          cropW = srcW;
          cropH = Math.round(srcW / targetRatio);
        }
        // align anchor picks WHICH region is kept (default centered).
        const a = (output.crop && output.crop.align) || 'C';
        sx = a.indexOf('L') >= 0 ? 0 : a.indexOf('R') >= 0 ? srcW - cropW : Math.round((srcW - cropW) / 2);
        sy = a.indexOf('T') >= 0 ? 0 : a.indexOf('B') >= 0 ? srcH - cropH : Math.round((srcH - cropH) / 2);
      }
    }

    let tw = cropW;
    let th = cropH;
    const sc = output.scale || { mode: 'none' };
    if (sc.mode === 'fit' && sc.size) {
      // Longest side = size (upscaling allowed).
      const scale = sc.size / Math.max(cropW, cropH);
      tw = Math.max(1, Math.round(cropW * scale));
      th = Math.max(1, Math.round(cropH * scale));
    } else if (sc.mode === 'exact') {
      tw = sc.width ? sc.width : cropW;
      th = sc.height ? sc.height : cropH;
    } else if (sc.mode === 'width' && sc.size) {
      tw = Math.max(1, Math.round(sc.size));
      th = Math.max(1, Math.round(cropH * (sc.size / cropW)));
    }
    return { sx, sy, cropW, cropH, tw, th };
  }

  RSTR.Pipeline = class Pipeline {
    constructor(canvas) {
      const g = RSTR.gl;
      this.canvas = canvas;
      this.gl = g.createGLContext(canvas);
      this.quad = g.createFullscreenQuad(this.gl);
      this.copyProgram = g.createProgram(this.gl, g.VERTEX_SHADER, COPY_FRAG);
      this.blendProgram = g.createProgram(this.gl, g.VERTEX_SHADER, BLEND_FRAG);
      this.blendModeProgram = g.createProgram(this.gl, g.VERTEX_SHADER, BLEND_MODE_FRAG);
      this.plateProgram = g.createProgram(this.gl, g.VERTEX_SHADER, PLATE_FRAG);
      this.programs = new Map();
      this.sourceTexture = null;
      this.srcWidth = 0; // = current buffer (post-output) width the effects run at
      this.srcHeight = 0;
      this.fbos = [null, null];
      this.blendFbo = null; // scratch target for a blended pass's raw effect output
      this.plateFbo = null; // holds the finished stack result when the base plate is on, so it can be composited over this.sourceTexture as a final pass
      this.maskFbo = null; // holds a MASK layer's raw effect output (its luminance = the mask) until the next non-mask layer consumes it
      this.seed = 42;
      this.source = null; // raw HTMLImageElement / canvas
      this.rawW = 0;
      this.rawH = 0;
      this.work = null; // offscreen 2D canvas used for crop+resize
    }

    setSeed(seed) {
      this.seed = seed;
    }

    // Store the raw source; call applyOutput() before render().
    setImage(source, width, height) {
      this.source = source;
      this.rawW = width || source.naturalWidth || source.width;
      this.rawH = height || source.naturalHeight || source.height;
    }

    hasImage() {
      return this.source !== null;
    }

    // Reset to the no-image state (drop zone). Used by the editor's NEW IMAGE.
    clearImage() {
      const gl = this.gl;
      if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
      this.sourceTexture = null;
      this.source = null;
      this.rawW = 0;
      this.rawH = 0;
      this.srcWidth = 0;
      this.srcHeight = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Center-crop + resize the raw source per the OUTPUT block, upload the
    // result as the source texture, and size the GL buffers to match.
    applyOutput(output) {
      if (!this.source) return;
      const out = RSTR.preset.normalizeOutput(output);
      const geo = computeGeometry(this.rawW, this.rawH, out);

      if (!this.work) this.work = document.createElement('canvas');
      this.work.width = geo.tw;
      this.work.height = geo.th;
      const wctx = this.work.getContext('2d');
      wctx.clearRect(0, 0, geo.tw, geo.th);
      wctx.drawImage(this.source, geo.sx, geo.sy, geo.cropW, geo.cropH, 0, 0, geo.tw, geo.th);

      const gl = this.gl;
      if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
      this.sourceTexture = RSTR.gl.createTextureFromSource(gl, this.work);
      this.srcWidth = geo.tw;
      this.srcHeight = geo.th;
      this._resize(geo.tw, geo.th);
    }

    _resize(width, height) {
      const gl = this.gl;
      this.canvas.width = width;
      this.canvas.height = height;
      RSTR.gl.deleteFBO(gl, this.fbos[0]);
      RSTR.gl.deleteFBO(gl, this.fbos[1]);
      RSTR.gl.deleteFBO(gl, this.blendFbo);
      RSTR.gl.deleteFBO(gl, this.plateFbo);
      RSTR.gl.deleteFBO(gl, this.maskFbo);
      this.fbos[0] = RSTR.gl.createFBO(gl, width, height);
      this.fbos[1] = RSTR.gl.createFBO(gl, width, height);
      this.blendFbo = RSTR.gl.createFBO(gl, width, height);
      this.plateFbo = RSTR.gl.createFBO(gl, width, height);
      this.maskFbo = RSTR.gl.createFBO(gl, width, height);
    }

    // Returns whichever of the two ping-pong scratch FBOs does NOT currently
    // back `readTexture`, so writing into it can never alias a simultaneous
    // read. A plain `i % 2` alternation (the pre-mask scheme) assumed every
    // iteration advances readTexture by exactly one step; a MASK layer
    // deliberately does NOT (it's a pass-through), so a naive i%2 can pick
    // the SAME fbo that readTexture already points to -- a read/write
    // feedback loop. Which physical fbo ends up holding a given pass's
    // output never affects the rendered pixels, only aliasing does, so this
    // is a safe drop-in for every `this.fbos[i % 2]` site below.
    _pickScratchFbo(readTexture) {
      return readTexture === this.fbos[0].texture ? this.fbos[1] : this.fbos[0];
    }

    _getProgram(effectId) {
      if (!this.programs.has(effectId)) {
        const def = RSTR.getEffect(effectId);
        this.programs.set(effectId, RSTR.gl.createProgram(this.gl, RSTR.gl.VERTEX_SHADER, def.frag));
      }
      return this.programs.get(effectId);
    }

    // `source` = the pinned "◇ ORIGINAL" row's {enabled, opacity} (optional;
    // defaults to {enabled:false, opacity:1} same as RSTR.preset.defaultSource()).
    // When enabled, it's a BASE PLATE: a FINAL pass, AFTER the whole stack has
    // run, that composites the stack's result source-over this.sourceTexture
    // (the raw original, pre-effects) × opacity -- see PLATE_FRAG above. When
    // disabled (the default) this takes the exact pre-existing fast path: the
    // stack's last step targets the canvas directly, zero extra draw calls,
    // zero pixel change.
    render(stack, source) {
      const gl = this.gl;
      if (!this.sourceTexture) return;
      const enabled = (stack || []).filter((s) => s.enabled !== false);

      const plateOn = !!(source && source.enabled === true);
      // With the plate on, the stack's last step can't target the canvas
      // (null) directly -- it needs to land in a texture so _drawPlate can
      // read it as the compositing "top" layer. plateFbo is free for this:
      // nothing else in the loop below ever writes to it.
      const finalTarget = plateOn ? this.plateFbo.framebuffer : null;

      if (enabled.length === 0) {
        this._draw(this.copyProgram, this.sourceTexture, finalTarget, null, null);
      } else {
        const temps = []; // CPU-stage textures to free after the frame
        let readTexture = this.sourceTexture;
        let lastDrawnToFinal = false;
        // MASK chain state (2026-07-12): a MASK layer (step.mask present) is
        // NEVER composited -- it renders its raw effect(input) into
        // this.maskFbo (a dedicated scratch target, see _resize) and
        // `readTexture` is left UNTOUCHED, so the next layer's input is
        // exactly the mask layer's own input. The mask's luminance then
        // multiplies the blend opacity of the next enabled, NON-mask layer
        // (pendingMask, consumed below). Two masks in a row: encountering a
        // new mask layer simply overwrites maskFbo/pendingMask, so the LAST
        // one before a real target wins, and the earlier one's computed mask
        // is discarded unconsumed -- see the isMaskLayer branch just below.
        // A trailing mask (nothing non-mask after it) is a true no-op: it
        // sets pendingMask, the loop ends, nothing ever reads it, and the
        // lastDrawnToFinal fallback after the loop passes the unchanged
        // input straight to finalTarget.
        let pendingMask = null; // { invert } | null -- texture is always this.maskFbo.texture

        for (let i = 0; i < enabled.length; i++) {
          const step = enabled[i];
          const isLast = i === enabled.length - 1;
          const def = RSTR.getEffect(step.effect);

          if (isMaskLayer(step)) {
            if (typeof def.cpu === 'function') {
              // Snapshot readTexture via blendFbo (idle at this point in the
              // loop, never chained into readTexture across iterations, so
              // it can never alias readTexture -- unlike this.fbos[], whose
              // i%2 parity is NOT safe here since this pass-through branch
              // doesn't advance readTexture; see _pickScratchFbo's comment).
              this._draw(this.copyProgram, readTexture, this.blendFbo.framebuffer, null, null);
              const w = this.srcWidth;
              const h = this.srcHeight;
              const pixels = new Uint8ClampedArray(w * h * 4);
              gl.bindFramebuffer(gl.FRAMEBUFFER, this.blendFbo.framebuffer);
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              const out = def.cpu(pixels, w, h, step.params || {}) || pixels;
              const cpuTex = this._uploadPixels(out, w, h);
              this._draw(this.copyProgram, cpuTex, this.maskFbo.framebuffer, null, null);
              gl.deleteTexture(cpuTex);
            } else {
              const program = this._getProgram(step.effect);
              this._draw(program, readTexture, this.maskFbo.framebuffer, step.params, step.effect);
            }
            pendingMask = { invert: maskInvert(step) };
            continue; // pass-through: readTexture unchanged, nothing composited
          }

          const opacity = layerOpacity(step);
          const blend = layerBlend(step);
          const hasMask = pendingMask != null;
          const needsBlend = blend !== 'normal' || opacity < 1 || hasMask;

          if (typeof def.cpu === 'function') {
            // CPU stage: render the current input into an FBO, read the pixels
            // back, run the effect on the CPU, then re-upload as a texture.
            // `frag` and `cpu` are mutually exclusive per the shared contract.
            const inFbo = this._pickScratchFbo(readTexture);
            this._draw(this.copyProgram, readTexture, inFbo.framebuffer, null, null);
            const w = this.srcWidth;
            const h = this.srcHeight;
            const pixels = new Uint8ClampedArray(w * h * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, inFbo.framebuffer);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            // Opacity/blend for CPU stages is applied right here on the CPU:
            // snapshot the input first — cpu() may mutate `pixels` in place.
            const inCopy = needsBlend ? pixels.slice() : null;
            const out = def.cpu(pixels, w, h, step.params || {}) || pixels;
            if (inCopy) {
              if (hasMask) {
                const maskPixels = new Uint8ClampedArray(w * h * 4);
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFbo.framebuffer);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, maskPixels);
                applyCpuBlendMasked(out, inCopy, blend, opacity, maskPixels, pendingMask.invert);
                pendingMask = null;
              } else if (blend === 'normal') {
                // UNCHANGED formula (byte-for-byte) — see BLEND_FRAG's comment.
                for (let j = 0; j < out.length; j++) out[j] = inCopy[j] + (out[j] - inCopy[j]) * opacity;
              } else {
                applyCpuBlend(out, inCopy, blend, opacity);
              }
            }
            const cpuTex = this._uploadPixels(out, w, h);
            temps.push(cpuTex);
            if (isLast) {
              this._draw(this.copyProgram, cpuTex, finalTarget, null, null);
              lastDrawnToFinal = true;
            } else {
              readTexture = cpuTex;
            }
          } else if (needsBlend) {
            // GPU pass with opacity/blend/mask: raw effect into the scratch
            // FBO, then mix/blend it back over this pass's own input into
            // the normal target.
            const program = this._getProgram(step.effect);
            this._draw(program, readTexture, this.blendFbo.framebuffer, step.params, step.effect);
            const outFbo = this._pickScratchFbo(readTexture);
            const target = isLast ? finalTarget : outFbo.framebuffer;
            this._drawBlend(readTexture, this.blendFbo.texture, target, opacity, blend, hasMask ? this.maskFbo.texture : null, hasMask && pendingMask.invert);
            if (hasMask) pendingMask = null;
            if (isLast) lastDrawnToFinal = true;
            else readTexture = outFbo.texture;
          } else {
            const program = this._getProgram(step.effect);
            const outFbo = this._pickScratchFbo(readTexture);
            const target = isLast ? finalTarget : outFbo.framebuffer;
            this._draw(program, readTexture, target, step.params, step.effect);
            if (isLast) lastDrawnToFinal = true;
            else readTexture = outFbo.texture;
          }
        }
        // A trailing mask layer (or a run of nothing but masks at the end)
        // never got consumed and never drew to finalTarget -- pass the
        // unchanged input straight through so it's a true no-op.
        if (!lastDrawnToFinal) {
          this._draw(this.copyProgram, readTexture, finalTarget, null, null);
        }
        for (const t of temps) gl.deleteTexture(t);
      }

      if (plateOn) {
        this._drawPlate(this.plateFbo.texture, this.sourceTexture, sourceOpacity(source));
      }
    }

    // blend = 'normal' routes to the untouched blendProgram (byte-identical
    // to before blend modes existed); any other mode routes to
    // blendModeProgram (BLEND_MODE_FRAG), which also carries a u_blend index.
    // maskTexture/maskInvertFlag (2026-07-12): optional MASK feed -- when
    // maskTexture is falsy, u_hasMask is explicitly set to 0 every call
    // (never left to a stale value from a PREVIOUS layer's draw on this same
    // shared program -- WebGL uniforms persist across draw calls) so a
    // layer with no mask feeding it is byte-identical to before this
    // feature existed.
    _drawBlend(prevTexture, effectTexture, targetFramebuffer, opacity, blend, maskTexture, maskInvertFlag) {
      const gl = this.gl;
      const useModeProgram = blend && blend !== 'normal';
      const program = useModeProgram ? this.blendModeProgram : this.blendProgram;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
      gl.viewport(0, 0, this.srcWidth, this.srcHeight);
      gl.useProgram(program);
      RSTR.gl.bindQuad(gl, program, this.quad);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, effectTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, prevTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'u_prev'), 1);
      gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), opacity);
      const hasMask = !!maskTexture;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, hasMask ? maskTexture : prevTexture); // dummy bind when unused; never sampled since u_hasMask gates it
      gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 2);
      gl.uniform1i(gl.getUniformLocation(program, 'u_hasMask'), hasMask ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_maskInvert'), maskInvertFlag ? 1 : 0);
      if (useModeProgram) {
        const idx = (RSTR.preset.BLEND_IDS || []).indexOf(blend);
        gl.uniform1i(gl.getUniformLocation(program, 'u_blend'), idx >= 0 ? idx : 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0); // leave unit 0 active for _draw's bindings
    }

    // Base plate final composite: PLATE_FRAG composites `topTexture` (the
    // finished stack result) source-over `plateTexture` (this.sourceTexture,
    // the raw original) × opacity, writing straight to the canvas. Always the
    // LAST draw of a frame when the plate is on.
    _drawPlate(topTexture, plateTexture, opacity) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.srcWidth, this.srcHeight);
      gl.useProgram(this.plateProgram);
      RSTR.gl.bindQuad(gl, this.plateProgram, this.quad);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, topTexture);
      gl.uniform1i(gl.getUniformLocation(this.plateProgram, 'u_tex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, plateTexture);
      gl.uniform1i(gl.getUniformLocation(this.plateProgram, 'u_plate'), 1);
      gl.uniform1f(gl.getUniformLocation(this.plateProgram, 'u_opacity'), opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0); // leave unit 0 active for _draw's bindings
    }

    // --- test-only: verification harness hook -------------------------------
    // Runs BLEND_MODE_FRAG directly on two solid 1x1 colors and returns the
    // blended RGBA (0..255 bytes), bypassing the effect stack entirely so
    // exact (backdrop, source) pairs can be checked against
    // independently-computed expected values. Never called by the editor or
    // engine at runtime -- exists purely so scratchpad/verify-blend.mjs can
    // exercise the ACTUAL production shader instead of a re-implementation.
    testBlendPixel(blend, bRGBA, sRGBA, opacity) {
      const gl = this.gl;
      const w = 1;
      const h = 1;
      const mkTex = (rgba) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        return tex;
      };
      const bTex = mkTex(bRGBA);
      const sTex = mkTex(sRGBA);
      const fbo = RSTR.gl.createFBO(gl, w, h);
      const savedW = this.srcWidth;
      const savedH = this.srcHeight;
      this.srcWidth = w;
      this.srcHeight = h;
      this._drawBlend(bTex, sTex, fbo.framebuffer, opacity, blend);
      this.srcWidth = savedW;
      this.srcHeight = savedH;
      const out = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(bTex);
      gl.deleteTexture(sTex);
      RSTR.gl.deleteFBO(gl, fbo);
      return Array.from(out);
    }

    // Upload a raw RGBA buffer (from a CPU stage) as a texture. No Y-flip:
    // readPixels row 0 = bottom, so a straight upload keeps orientation.
    _uploadPixels(pixels, w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return tex;
    }

    _draw(program, texture, targetFramebuffer, params, effectId) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
      gl.viewport(0, 0, this.srcWidth, this.srcHeight);
      gl.useProgram(program);
      RSTR.gl.bindQuad(gl, program, this.quad);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
      gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), this.srcWidth, this.srcHeight);
      gl.uniform1f(gl.getUniformLocation(program, 'u_seed'), this.seed);

      if (effectId) {
        const def = RSTR.getEffect(effectId);
        for (const p of def.params) {
          const value = params && params[p.key] != null ? params[p.key] : p.default;
          // `stops` is an array value, not a single `u_<key>` uniform -- see
          // uploadStopsUniform above (currently gradientmap's only param of
          // this type).
          if (p.type === 'stops') {
            uploadStopsUniform(gl, program, value);
            continue;
          }
          const loc = gl.getUniformLocation(program, `u_${p.key}`);
          if (!loc) continue;
          if (p.type === 'color') {
            const rgb = hexToRgb(value);
            gl.uniform3f(loc, rgb[0], rgb[1], rgb[2]);
          } else {
            gl.uniform1f(loc, Number(value));
          }
        }
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Encode the current buffer to the OUTPUT format/quality.
    encode(output) {
      const out = RSTR.preset.normalizeOutput(output);
      return this.canvas.toDataURL(RSTR.preset.mimeForFormat(out.format), out.quality);
    }

    toBlob(callback, output) {
      const out = RSTR.preset.normalizeOutput(output);
      this.canvas.toBlob(callback, RSTR.preset.mimeForFormat(out.format), out.quality);
    }
  };

  // Geometry helper for the UI dimensions readout (SRC -> OUT), same math the
  // pipeline uses. Returns { sx, sy, cropW, cropH, tw, th }.
  RSTR.computeGeometry = function (srcW, srcH, output) {
    return computeGeometry(srcW, srcH, RSTR.preset.normalizeOutput(output));
  };

  // Test-only export: the CPU-stage blend math, so the verification harness
  // exercises the exact function applyCpuBlend() calls per pixel (not a
  // re-implementation). b, s = [r,g,b,a] 0..1; returns [r,g,b,a] 0..1.
  RSTR._blendPixel = blendPixel;
})((window.RSTR = window.RSTR || {}));
