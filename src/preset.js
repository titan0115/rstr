// preset.js — the "style code" format (committed mix + OUTPUT block) plus a
// deterministic short id, AND the localStorage stores (per-effect param presets,
// disabled effects). Classic script — attaches to window.RSTR.preset. Uses a
// synchronous non-crypto hash (cyrb53) so it works over file:// with no async.
//
// OUTPUT schema (v1.5): crop (ratio + 3x3 align anchor) and scale (none | fit |
// exact) are two independent controls.
//   output: {
//     crop:  { ratio: "original"|"1:1"|...|"W:H",  align: "TL".."C".."BR" },
//     scale: { mode: "none"|"fit"|"exact"|"width", size, width, height },
//     format: "png"|"webp"|"jpeg", quality: 0..1
//   }
// "width" (added for the PRE CANVAS scrub): size = target width in px, height
// derives from the post-crop aspect ratio. Independent of "fit" (longest side).
(function (RSTR) {
  'use strict';

  const PRESET_VERSION = 1;

  const RATIOS = ['original', '1:1', '4:5', '5:4', '9:16', '16:9', '3:2', '2:3'];
  const ALIGN_CODES = ['TL', 'T', 'TR', 'L', 'C', 'R', 'BL', 'B', 'BR'];
  const SCALE_MODES = ['none', 'fit', 'exact', 'width'];
  const FORMATS = ['png', 'webp', 'jpeg'];

  // Per-layer BLEND MODES — Figma's BlendMode enum (PASS_THROUGH dropped, it
  // only means anything for groups/frames) plus two RSTR-native alpha modes.
  // Order + grouping matches the plan; `group` is UI-only (optgroup labels).
  // The array INDEX is also the numeric code the GPU blend shader switches on
  // (src/pipeline.js) -- keep this array the single source of truth for both.
  const BLEND_MODES = [
    { id: 'normal', label: 'Normal', group: '' },
    { id: 'darken', label: 'Darken', group: 'Darken' },
    { id: 'multiply', label: 'Multiply', group: 'Darken' },
    { id: 'linear-burn', label: 'Plus darker', group: 'Darken' },
    { id: 'color-burn', label: 'Color burn', group: 'Darken' },
    { id: 'lighten', label: 'Lighten', group: 'Lighten' },
    { id: 'screen', label: 'Screen', group: 'Lighten' },
    { id: 'linear-dodge', label: 'Plus lighter', group: 'Lighten' },
    { id: 'color-dodge', label: 'Color dodge', group: 'Lighten' },
    { id: 'overlay', label: 'Overlay', group: 'Contrast' },
    { id: 'soft-light', label: 'Soft light', group: 'Contrast' },
    { id: 'hard-light', label: 'Hard light', group: 'Contrast' },
    { id: 'difference', label: 'Difference', group: 'Inversion' },
    { id: 'exclusion', label: 'Exclusion', group: 'Inversion' },
    { id: 'hue', label: 'Hue', group: 'Component' },
    { id: 'saturation', label: 'Saturation', group: 'Component' },
    { id: 'color', label: 'Color', group: 'Component' },
    { id: 'luminosity', label: 'Luminosity', group: 'Component' },
    { id: 'alpha', label: 'Alpha', group: 'RSTR' },
    { id: 'alpha-invert', label: 'Alpha invert', group: 'RSTR' },
  ];
  const BLEND_IDS = BLEND_MODES.map((m) => m.id);

  // Unknown/garbage -> 'normal', never throws (same posture as the
  // unknown-effect drop in validatePreset).
  function normalizeBlend(v) {
    return BLEND_IDS.indexOf(v) >= 0 ? v : 'normal';
  }

  // --- MASK (per-layer stencil flag) -----------------------------------------
  // A layer's `mask` property: PRESENCE is the flag (not a nested `enabled`
  // sub-key) -- same convention `opacity`/`blend` already use for "only
  // serialize when it differs from the default". When present, this layer is
  // never composited into the image; its raw effect output's luminance
  // becomes a per-pixel multiplier on the blend opacity of the next enabled,
  // non-mask layer. See src/pipeline.js render()'s isMaskLayer branch for the
  // full mechanics and the "two masks in a row: last one wins" rule.
  // Garbage (non-object) -> null ("no mask"), never throws -- same posture as
  // normalizeBlend above.
  function normalizeMask(m) {
    if (!m || typeof m !== 'object') return null;
    return { invert: m.invert === true };
  }

  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function posInt(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  function normalizeCrop(c) {
    let ratio = 'original';
    let align = 'C';
    if (typeof c === 'string') ratio = c; // legacy: crop was a bare ratio string
    else if (c && typeof c === 'object') {
      ratio = c.ratio || 'original';
      align = c.align || 'C';
    }
    if (ALIGN_CODES.indexOf(align) < 0) align = 'C';
    // ratio is "original" or a "W:H" string (named preset or custom).
    if (ratio !== 'original' && !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(ratio)) ratio = 'original';
    return { ratio, align };
  }

  function normalizeScale(s) {
    s = s || {};
    const mode = SCALE_MODES.indexOf(s.mode) >= 0 ? s.mode : 'none';
    return { mode, size: posInt(s.size), width: posInt(s.width), height: posInt(s.height) };
  }

  // Accepts the v1.5 schema OR the legacy {crop:"1:1", size:1080} schema and
  // returns a fully-populated v1.5 output. Keys in a fixed order for a stable id.
  function normalizeOutput(o) {
    o = o || {};
    const legacy = typeof o.crop === 'string' || o.size !== undefined;
    let crop;
    let scale;
    if (legacy) {
      crop = normalizeCrop(o.crop);
      const size = posInt(o.size);
      scale = normalizeScale({ mode: size ? 'fit' : 'none', size });
    } else {
      crop = normalizeCrop(o.crop);
      scale = normalizeScale(o.scale);
    }
    return {
      crop,
      scale,
      format: FORMATS.indexOf(o.format) >= 0 ? o.format : 'png',
      quality: typeof o.quality === 'number' ? o.quality : 0.92,
    };
  }

  function defaultOutput() {
    return normalizeOutput(null);
  }

  function mimeForFormat(format) {
    return format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
  }

  function extForFormat(format) {
    return format === 'webp' ? 'webp' : format === 'jpeg' ? 'jpg' : 'png';
  }

  function createPreset(name, stack, output, pre, source) {
    const cleanStack = stack.map((s) => {
      const entry = {
        effect: s.effect,
        enabled: s.enabled !== false,
        params: { ...s.params },
      };
      // Serialized only when < 1 so pre-opacity style codes (and their cyrb53
      // ids) stay byte-identical.
      const op = Number(s.opacity);
      if (s.opacity != null && isFinite(op) && op < 1) entry.opacity = Math.max(0, op);
      // Same rule for blend: serialized only when not 'normal' so pre-blend
      // style codes (and their cyrb53 ids) stay byte-identical.
      const bl = normalizeBlend(s.blend);
      if (bl !== 'normal') entry.blend = bl;
      // Same rule for mask: serialized only when the flag is on, so
      // pre-mask style codes (and their cyrb53 ids) stay byte-identical.
      const mk = normalizeMask(s.mask);
      if (mk) entry.mask = mk;
      return entry;
    });
    const preset = { v: PRESET_VERSION, name: name || 'untitled', stack: cleanStack, output: normalizeOutput(output) };
    // Include `pre` ONLY when non-identity, so style codes (and their cyrb53
    // ids) saved before the PRE module existed -- and any untouched-PRE save
    // today -- stay byte-identical.
    if (pre && !preIsIdentity(pre)) preset.pre = normalizePre(pre);
    // Same rule for `source` (the pinned ORIGINAL base-plate row): included
    // ONLY when it differs from the default {enabled:false, opacity:1}, so
    // style codes (and their cyrb53 ids) saved before ORIGINAL existed --
    // and any untouched-source save today -- stay byte-identical.
    if (source && !sourceIsDefault(source)) preset.source = normalizeSource(source);
    return preset;
  }

  // Deterministic 8-hex id of {v, stack, output[, pre][, source]} — same
  // recipe, same code.
  function computePresetId(preset) {
    const canonical = { v: preset.v, stack: preset.stack, output: normalizeOutput(preset.output) };
    if (preset.pre && !preIsIdentity(preset.pre)) canonical.pre = normalizePre(preset.pre);
    if (preset.source && !sourceIsDefault(preset.source)) canonical.source = normalizeSource(preset.source);
    const json = JSON.stringify(canonical);
    return 'rstr_' + cyrb53(json).toString(16).padStart(14, '0').slice(-8);
  }

  function finalizePreset(name, stack, output, pre, source) {
    const preset = createPreset(name, stack, output, pre, source);
    preset.id = computePresetId(preset);
    return preset;
  }

  // --- Legacy effect migrations -----------------------------------------
  // Old style codes referencing effects that were later merged into another
  // effect (2026-07-11: `edge` and `dotpattern` collapsed into `dots` with a
  // `mode` select; 2026-07-13: `threshold` and `quantize` collapsed into
  // `posterize` with a `mode` select, `riso` collapsed into `halftone` with a
  // `mode` select, `recolor` collapsed into a GPU `gradientmap`, and `invert`
  // folded into `adjust` — see src/effects.js). Applied once, up front, in
  // validatePreset — the single choke point both heads (render.html and
  // ui.js) funnel every preset through before using its stack — so it runs
  // BEFORE the unknown-effect drop below and those layers survive instead of
  // being silently dropped. Expected + accepted for every entry: the
  // deterministic `rstr_` id hash CHANGES for a migrated mix (it now encodes
  // the merged effect instead of the old one).
  //
  // Two shapes, both keyed by the OLD effect id:
  //   { effect, params }     -- old param keys carry across unchanged, `params`
  //                             is just spread on top (mode-select merges: the
  //                             old and new param sets never collided, only
  //                             `mode` itself is new).
  //   { effect, transform }  -- for a merge where the old params need actual
  //                             reshaping, not just a key union (recolor's
  //                             fixed stop1/pos1..stop3/pos3, posN in 0..100,
  //                             becoming gradientmap's `stops` array with pos
  //                             in 0..1; invert's `amount`/`channels` becoming
  //                             adjust's `invert`/`invertChannels`).
  //                             transform(oldParams) returns the FULL new
  //                             params object.
  // A legacy entry has exactly one of the two -- never both.
  const LEGACY_EFFECTS = {
    edge: { effect: 'dots', params: { mode: 1 } },
    dotpattern: { effect: 'dots', params: { mode: 2 } },
    threshold: { effect: 'posterize', params: { mode: 1 } },
    quantize: { effect: 'posterize', params: { mode: 2 } },
    riso: { effect: 'halftone', params: { mode: 1 } },
    // recolor's 3 fixed stops -> gradientmap's `stops` array. recolor's pos1/
    // pos2/pos3 are 0..100 (a `range` param); gradientmap's stop `pos` is
    // 0..1 -- divide by 100 and clamp defensively. Every other recolor param
    // (map/posterizeSteps/noiseIntensity/noiseScale/noiseGamma/repetitions)
    // carries across unchanged: gradientmap absorbed them with recolor's own
    // keys and identity defaults, see src/effects.js.
    recolor: {
      effect: 'gradientmap',
      transform(params) {
        params = params || {};
        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        const pos1 = params.pos1 != null ? Number(params.pos1) : 0;
        const pos2 = params.pos2 != null ? Number(params.pos2) : 50;
        const pos3 = params.pos3 != null ? Number(params.pos3) : 100;
        const out = { ...params };
        out.stops = [
          { pos: clamp01((isFinite(pos1) ? pos1 : 0) / 100), color: params.stop1 || '#00278a' },
          { pos: clamp01((isFinite(pos2) ? pos2 : 50) / 100), color: params.stop2 || '#fe76ec' },
          { pos: clamp01((isFinite(pos3) ? pos3 : 100) / 100), color: params.stop3 || '#fefffa' },
        ];
        // Explicit, NOT a spread-through fallback: gradientmap's `map`
        // default moved to 3 (Luminance, see src/effects.js) so it could
        // reproduce the OLD CPU gradientmap's own formula for a bare
        // gradientmap code. recolor's own default was always 0
        // (Brightness), and an old recolor code is free to omit `map`
        // entirely -- without this, that omitted key would now silently
        // fall through to gradientmap's new default (3) instead of
        // recolor's (0), changing the tone curve of every recolor code
        // that never touched the Map dropdown.
        out.map = params.map != null ? Number(params.map) : 0;
        delete out.stop1;
        delete out.stop2;
        delete out.stop3;
        delete out.pos1;
        delete out.pos2;
        delete out.pos3;
        return out;
      },
    },
    // invert's amount/channels -> adjust's invert/invertChannels (same 0..1 /
    // 0..3 encodings, just renamed keys so they sit alongside adjust's own
    // params without colliding). Every other adjust param (brightness, hue,
    // sharpen, ...) is simply absent from the migrated params object and
    // falls back to adjust's own identity defaults wherever it's read
    // (src/pipeline.js's uniform-upload loop already does `params[key] ??
    // default`), so a migrated invert layer only ever inverts -- it doesn't
    // pick up any accidental tone adjustment.
    invert: {
      effect: 'adjust',
      transform(params) {
        params = params || {};
        const out = { ...params };
        out.invert = params.amount != null ? Number(params.amount) : 1;
        out.invertChannels = params.channels != null ? Number(params.channels) : 0;
        delete out.amount;
        delete out.channels;
        return out;
      },
    },
  };

  function migrateLegacyEffects(stack) {
    return stack.map((step) => {
      const legacy = LEGACY_EFFECTS[step.effect];
      if (!legacy) return step;
      const params = legacy.transform ? legacy.transform(step.params || {}) : { ...step.params, ...legacy.params };
      return {
        ...step,
        effect: legacy.effect,
        params,
      };
    });
  }

  function validatePreset(json) {
    if (!json || typeof json !== 'object') throw new Error('Invalid preset: not an object');
    if (json.v !== PRESET_VERSION) throw new Error(`Unsupported preset version: ${json.v}`);
    if (!Array.isArray(json.stack)) throw new Error('Invalid preset: missing stack array');
    for (const step of json.stack) {
      if (!step.effect) throw new Error('Invalid preset: stack entry missing "effect"');
    }
    json.stack = migrateLegacyEffects(json.stack);
    // Drop layers whose effect id isn't registered (e.g. a style code saved
    // before an effect was removed, like the old "grain") instead of letting
    // them crash the pipeline/UI downstream — this is the one upstream point
    // both heads funnel through (render.html and ui.js both call
    // validatePreset before using a preset's stack).
    json.stack = json.stack.filter((step) => {
      if (RSTR.EFFECTS[step.effect]) return true;
      console.warn(`RSTR: unknown effect "${step.effect}" skipped`);
      return false;
    });
    // Sanitize any `stops`-type param (currently just gradientmap's) on every
    // surviving layer -- covers pasted/loaded style codes, which skip the
    // editor's own defaulting/deep-clone path entirely. Old "gradientmap"
    // codes (pre-merge) carry color1..4 params instead of `stops`; those keys
    // are simply left in place and ignored by the effect (accepted precedent:
    // unknown/stale param keys are never stripped elsewhere either) while
    // `stops` itself falls back to the effect's default.
    for (const step of json.stack) {
      const def = RSTR.EFFECTS[step.effect];
      step.params = step.params && typeof step.params === 'object' ? step.params : {};
      for (const p of def.params) {
        if (p.type === 'stops') step.params[p.key] = sanitizeStops(step.params[p.key], p.default);
      }
      if (step.opacity != null) {
        const op = Number(step.opacity);
        if (!isFinite(op) || op >= 1) delete step.opacity;
        else step.opacity = Math.max(0, op);
      }
      if (step.blend != null) {
        if (BLEND_IDS.indexOf(step.blend) < 0) {
          console.warn(`RSTR: unknown blend mode "${step.blend}" on layer "${step.effect}", falling back to normal`);
          delete step.blend;
        } else if (step.blend === 'normal') {
          delete step.blend; // keep 'normal' implicit, same rule as opacity < 1
        }
      }
      if (step.mask != null) {
        const mk = normalizeMask(step.mask);
        if (!mk) delete step.mask; // garbage -> off, never crash
        else step.mask = mk;
      }
    }
    json.output = normalizeOutput(json.output); // migrate/default in place
    json.pre = normalizePre(json.pre); // missing/partial -> defaultPre(), clamped to param ranges
    json.source = normalizeSource(json.source); // missing/garbage -> defaultSource(), never crashes
    return json;
  }

  // A `stops`-type param value must round-trip JSON as an array of
  // { pos: number in 0..1, color: '#rrggbb' } objects with >=2 valid entries;
  // sorted order is NOT required (evaluation always sorts a copy). Anything
  // short of that (missing, malformed, too few survivors) falls back to a
  // deep clone of the effect's own default, never a shared reference to it.
  function sanitizeStops(raw, fallbackDefault) {
    const HEX6 = /^#[0-9a-fA-F]{6}$/;
    const cleaned = (Array.isArray(raw) ? raw : [])
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({ pos: Number(s.pos), color: typeof s.color === 'string' ? s.color.toLowerCase() : '' }))
      .filter((s) => isFinite(s.pos) && s.pos >= 0 && s.pos <= 1 && HEX6.test(s.color));
    if (cleaned.length < 2) return JSON.parse(JSON.stringify(fallbackDefault));
    return cleaned;
  }

  // --- SOURCE (the pinned ORIGINAL row) shared state helpers -----------------
  // `source` is a BASE PLATE, not an input gate: AFTER the whole stack has
  // rendered, its result is composited source-over `original × opacity`
  // (the raw, post-crop/post-scale source texture — NOT the PRE/preprocess
  // buffer) as a FINAL pass. `opacity` multiplies the plate's alpha. This is
  // what lets holes punched by an `alpha`/`alpha-invert` blend layer show the
  // original photo through instead of transparency. See src/pipeline.js
  // render()'s final composite pass and src/ui.js's pinned "◇ ORIGINAL" row.
  //
  // `enabled` DEFAULTS TO FALSE — deliberately, not a style choice. `crt`
  // renders a transparent alpha void outside its curved tube on purpose
  // (see CLAUDE.md); if the plate defaulted on, that void would silently
  // fill with the original image and change the output of every existing
  // style code containing a crt layer. Default-off keeps `enabled:false` the
  // exact pre-existing fast path (zero pixel change), so old style codes
  // (and their `rstr_` ids, via sourceIsDefault below) are unaffected. The
  // editor's ORIGINAL checkbox therefore starts UNCHECKED — intended.
  function normalizeSource(s) {
    s = s || {};
    const enabled = s.enabled === true;
    const opRaw = Number(s.opacity);
    const opacity = isFinite(opRaw) ? Math.min(1, Math.max(0, opRaw)) : 1;
    return { enabled, opacity };
  }

  function defaultSource() {
    return normalizeSource(null);
  }

  function sourceIsDefault(source) {
    const n = normalizeSource(source);
    return n.enabled === false && n.opacity === 1;
  }

  // --- PRE (image preprocessing) shared state helpers -----------------------
  // `preprocess` stays a normal (if `internal`) EFFECTS entry so its params
  // schema (min/max/default) is the single source of truth here -- neither
  // head duplicates the ranges. Used by ui.js (the PRE module) AND by
  // render.html (prepending the pre pass before pipeline.render).
  function defaultPre() {
    return RSTR.defaultParams('preprocess');
  }

  function preIsIdentity(pre) {
    if (!pre) return true;
    const d = defaultPre();
    for (const k of Object.keys(d)) {
      if (pre[k] != null && Number(pre[k]) !== d[k]) return false;
    }
    return true;
  }

  // Missing/partial `pre` -> filled from defaultPre(); every value clamped to
  // its param's [min,max]. Always returns a fully-populated, in-range object.
  function normalizePre(pre) {
    const def = RSTR.getEffect('preprocess');
    const d = defaultPre();
    const out = {};
    for (const p of def.params) {
      const raw = pre && pre[p.key] != null ? Number(pre[p.key]) : d[p.key];
      out[p.key] = isFinite(raw) ? Math.min(p.max, Math.max(p.min, raw)) : d[p.key];
    }
    return out;
  }

  function stackToEditable(stack) {
    return stack.map((s) => {
      const entry = {
        effect: s.effect,
        enabled: s.enabled !== false,
        params: { ...s.params },
        opacity: s.opacity != null ? Number(s.opacity) : 1,
        blend: normalizeBlend(s.blend),
      };
      // mask stays "present only when on" in editor state too -- same
      // presence-is-the-flag convention as the serialized schema, see
      // normalizeMask above.
      const mk = normalizeMask(s.mask);
      if (mk) entry.mask = mk;
      return entry;
    });
  }

  // --- Per-effect named param-presets (localStorage), keyed by effect id ---
  const LS_KEY = (effectId) => `rstr.fx.${effectId}`;

  function loadEffectPresets(effectId) {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY(effectId)) || '{}');
    } catch {
      return {};
    }
  }

  function saveEffectPreset(effectId, name, params) {
    const store = loadEffectPresets(effectId);
    store[name] = { ...params };
    try {
      localStorage.setItem(LS_KEY(effectId), JSON.stringify(store));
    } catch {
      /* non-fatal */
    }
  }

  function deleteEffectPreset(effectId, name) {
    const store = loadEffectPresets(effectId);
    if (!(name in store)) return false;
    delete store[name];
    try {
      localStorage.setItem(LS_KEY(effectId), JSON.stringify(store));
    } catch {
      /* non-fatal */
    }
    return true;
  }

  // --- Disabled effects ("engines") — hidden from the picker, persisted. ---
  const LS_DISABLED = 'rstr.disabledEffects';

  function loadDisabledEffects() {
    try {
      const a = JSON.parse(localStorage.getItem(LS_DISABLED) || '[]');
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }

  function saveDisabledEffects(list) {
    try {
      localStorage.setItem(LS_DISABLED, JSON.stringify(list));
    } catch {
      /* non-fatal */
    }
  }

  // --- Named Style Library — whole styles (layers + output), keyed by name. ---
  const LS_LIBRARY = 'rstr.styleLibrary';

  function loadStyleLibrary() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_LIBRARY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch {
      return {};
    }
  }

  function saveStyleToLibrary(name, style) {
    const lib = loadStyleLibrary();
    lib[name] = style;
    try {
      localStorage.setItem(LS_LIBRARY, JSON.stringify(lib));
    } catch {
      /* non-fatal */
    }
  }

  function deleteStyleFromLibrary(name) {
    const lib = loadStyleLibrary();
    if (!(name in lib)) return false;
    delete lib[name];
    try {
      localStorage.setItem(LS_LIBRARY, JSON.stringify(lib));
    } catch {
      /* non-fatal */
    }
    return true;
  }

  function resolveStyleById(id) {
    const lib = loadStyleLibrary();
    for (const k of Object.keys(lib)) if (lib[k] && lib[k].id === id) return lib[k];
    return null;
  }

  // Parse a pasted Style Code: full JSON (what COPY produces) OR a bare rstr_ id
  // resolved against the saved library. Throws on malformed input.
  function parseStyleCode(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) throw new Error('Nothing to paste');
    if (/^rstr_[0-9a-f]{6,}$/i.test(t)) {
      const s = resolveStyleById(t);
      if (!s) throw new Error(`Unknown id: ${t} (not in your library)`);
      return validatePreset(s);
    }
    let json;
    try {
      json = JSON.parse(t);
    } catch {
      throw new Error('Not valid JSON or a rstr_ id');
    }
    return validatePreset(json);
  }

  RSTR.preset = {
    PRESET_VERSION,
    RATIOS,
    ALIGN_CODES,
    SCALE_MODES,
    FORMATS,
    BLEND_MODES,
    BLEND_IDS,
    normalizeBlend,
    normalizeMask,
    normalizeOutput,
    defaultOutput,
    mimeForFormat,
    extForFormat,
    createPreset,
    computePresetId,
    finalizePreset,
    validatePreset,
    defaultPre,
    preIsIdentity,
    normalizePre,
    defaultSource,
    sourceIsDefault,
    normalizeSource,
    stackToEditable,
    loadEffectPresets,
    saveEffectPreset,
    deleteEffectPreset,
    loadDisabledEffects,
    saveDisabledEffects,
    loadStyleLibrary,
    saveStyleToLibrary,
    deleteStyleFromLibrary,
    resolveStyleById,
    parseStyleCode,
  };
})((window.RSTR = window.RSTR || {}));
