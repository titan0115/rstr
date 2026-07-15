// effects/stylize.js — STYLIZE category effect entries.
(function (RSTR) {
  'use strict';
  const HEAD = RSTR._effectHead;
  Object.assign(RSTR.EFFECTS, {
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
  });
})((window.RSTR = window.RSTR || {}));
