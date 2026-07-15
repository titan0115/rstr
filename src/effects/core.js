// effects/core.js — shared GLSL preamble, param helpers, registry API.
// Category files register entries via Object.assign(RSTR.EFFECTS, …).
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

  RSTR.EFFECTS = RSTR.EFFECTS || {};
  RSTR._effectHead = HEAD;
  RSTR._buildGradientLut = buildGradientLut;

  RSTR.getEffect = function getEffect(id) {
    const def = RSTR.EFFECTS[id];
    if (!def) throw new Error(`Unknown effect: ${id}`);
    return def;
  };

  RSTR.defaultParams = function defaultParams(id) {
    const def = RSTR.getEffect(id);
    const params = {};
    for (const p of def.params) params[p.key] = cloneParamValue(p.default);
    return params;
  };
})((window.RSTR = window.RSTR || {}));
