# RSTR — local shader image tool (design spec)

Date: 2026-07-03
Status: v1 built & verified. **v1.1 rework in progress — see the "v1.1" section at the BOTTOM, which SUPERSEDES conflicting parts above (UI model, module system, launch).**

## Goal
A local shader-based image-effects tool with **two heads sharing one shader pipeline and one preset format**:

1. **Editor** — a static WebGL2 web app. Drop an image, stack shader effects, tweak sliders live, export the look as a **preset** ("style code"). Zero install: open `index.html`.
2. **Engine** — a Node CLI using headless Chrome (Puppeteer + system Chrome). Applies a saved preset to a whole folder of images in batch. Meant to be driven by another agent: "process this folder with style X".

Design invariant: **shader code exists once** (in `src/`). Both heads import it. The engine never re-implements effects.

Name: **RSTR**. (Folder is `RSTR`; the tool is not ASCII-specific — ASCII is one effect among many.)

## Repo layout
```
D:\01_PROJECTS\RSTR\
  index.html            # editor entry — open directly in browser
  src/
    gl.js               # WebGL2 helpers: compile program, fullscreen draw, ping-pong FBOs
    effects.js          # EFFECTS registry: id -> {name, params schema, fragment shader}
    pipeline.js         # Pipeline: image->texture, run ordered passes, output to canvas / read pixels
    preset.js           # (de)serialize preset JSON + deterministic short id (hash of stack)
    ui.js               # editor UI generated from params schema (sliders/colors/selects)
  engine/
    render.html         # minimal headless page: imports src/*, exposes window.RSTR.render(dataURL, preset) -> pngDataURL
    rstr.js             # CLI: puppeteer(system chrome), loop --in images, apply --preset, write --out
    package.json        # dep: puppeteer-core (uses installed Chrome, no big download)
  presets/              # saved style presets (*.json)
  test-assets/          # a couple sample images for self-test
  README.md
```
Both `index.html` and `engine/render.html` import the SAME `src/` ES modules. Shaders live once.

## Preset format ("style code")
```json
{
  "id": "rstr_ab12cd34",
  "name": "my-retro",
  "v": 1,
  "stack": [
    { "effect": "adjust",   "params": { "brightness": 0.1, "contrast": 0.2, "saturation": -0.3, "gamma": 1.0 } },
    { "effect": "pixelate", "params": { "size": 6 } },
    { "effect": "dither",   "params": { "levels": 2, "palette": "mono" } }
  ]
}
```
`id` = deterministic short hash of `{v, stack}`, so the same look always yields the same code. The "style code" a user hands to another agent is either the `id` (resolved against `presets/`) or the full JSON.

## Pipeline
- WebGL2, one fullscreen triangle. Source image -> `texture0`.
- For each **enabled** effect in `stack`: render into a ping-pong FBO with that effect's fragment shader, sampling the previous pass. Full resolution preserved.
- Final pass: draw to the visible canvas (editor) or `readPixels` -> PNG (engine).
- Shared uniforms: `u_tex`, `u_resolution`, `u_seed` (grain determinism), plus per-effect params.

## v1 effects (each = one fragment-shader pass)
1. **adjust** — brightness, contrast, saturation, gamma
2. **pixelate** — block size (px)
3. **posterize** — levels per channel (+ optional b/w threshold)
4. **dither** — Bayer 4x4 ordered; levels; palette: `mono` | `rgb` (retro staple)
5. **halftone** — dot grid; cell size, angle, mono/color
6. **chromatic** — RGB shift amount + angle
7. **scanlines** — frequency, intensity (CRT-ish)
8. **grain** — amount, monochrome toggle, seeded
9. **duotone** — luminance mapped between colorA and colorB

Each registry entry: `{ id, name, params:[{key,label,type:'range'|'color'|'select',min,max,step,default,options}], frag }`.
UI is **generated** from the params schema — no per-effect UI code. Adding an effect (incl. future **ASCII**) = one registry entry.

## Editor UI — brutalist minimalism
Aesthetic (hard constraints):
- **Monospace everywhere**: `ui-monospace, "JetBrains Mono", "SF Mono", Consolas, monospace`.
- **Square corners**: `border-radius: 0` on every element. No rounded anything.
- **Brutalist**: hard 1px borders, high contrast, NO shadows, NO gradients, NO transitions/animation beyond instant. Near-monochrome (black/white/grey) + one accent only if needed. Visible structure — hairline dividers, grid lines.
- **Small, dense elements**: base font ~11-12px, tight paddings (2-6px), compact rows. UPPERCASE labels, small caps feel. Lots of settings visible at once — favor density over whitespace.
- Numeric readouts next to every slider (show the raw value in mono). Sliders can be thin/square-thumbed.

Layout:
- Left: canvas on a checkerboard (alpha). Drag/drop or click to load an image.
- Right panel (dense): "Add effect" dropdown; stack list (name, enable toggle, reorder ↑↓, remove, expand -> sliders with live numeric values).
- Bottom bar: `EXPORT PNG` · `COPY STYLE CODE` · `SAVE PRESET` · `LOAD PRESET` · `RESET` (mono, uppercase, boxed buttons).
- Live re-render on any change (rAF-throttled).

## Export
- Editor: re-render at image native resolution offscreen, `toBlob` PNG, download `<name>-rstr.png`.
- Engine: same pipeline in-page, `toDataURL('image/png')`, Node writes the file.

## Engine CLI
```
node engine/rstr.js --preset presets/my-retro.json --in ./in --out ./out [--suffix -rstr]
```
- Puppeteer via `puppeteer-core` with `executablePath` = installed Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) — no Chromium download.
- Load `engine/render.html` (file://). For each image in `--in`: read -> data URL -> `page.evaluate(RSTR.render(dataURL, preset))` -> png data URL -> write to `--out` with suffix. Log `[i/N] name -> out`.
- `--preset` also accepts a bare id (`rstr_ab12cd34`) resolved against `presets/`.

## Non-goals v1 (YAGNI)
No video/GIF, no layers/masks, no undo history (Reset only), no accounts, no mobile. ASCII effect deferred — architecture is ready for it as a registry entry.

## Acceptance
1. Open `index.html`, load a sample image, add each effect, confirm a visible change, export a PNG.
2. Save a preset; run the engine over `test-assets/` (2-3 images); confirm outputs match the editor look.

---

# v1.1 — UI rework + true double-click (SUPERSEDES conflicting parts above)

## A. No server, no build, hostable — via classic scripts
- **Drop ES modules.** Rewrite `src/*.js` as **classic scripts** attaching to a global namespace `window.RSTR` (no `import`/`export`, no `type="module"`). Classic `<script src>` loads fine over `file://`, so **`index.html` opens by double-click with no server**, and also works when hosted on any static host. This is the fix for the Chrome `file://` ES-module CORS block.
- `index.html` includes, in order: `<script src="src/gl.js"></script>`, `effects.js`, `pipeline.js`, `preset.js`, then `ui.js` (which boots the editor on DOMContentLoaded).
- `engine/render.html` includes the SAME `../src/gl.js`, `effects.js`, `pipeline.js`, `preset.js`, then a small inline script exposing `window.RSTR.render(dataURL, preset) -> pngDataURL`. Shader code still exists **once** (DRY invariant holds).
- Engine `rstr.js`: since classic scripts load over `file://`, you can drop `--allow-file-access-from-files`/`--disable-web-security` (keep the SwiftShader/ANGLE GL flags needed for headless WebGL2). Re-verify the engine still runs.
- Remove `RSTR.cmd` (no longer needed) and update `README.md`: "double-click `index.html`" for the editor; folder is directly hostable as a static site.

## B. New interaction model (settings on the LEFT, canvas on the RIGHT)
Layout mirrors: **left = control panel, right = canvas.**

Left panel, top → bottom:
1. **Effect list** — a column of ALL effect names, always visible (adjust, pixelate, posterize, dither, halftone, chromatic, scanlines, grain, duotone). Exactly one is **selected/active** at a time.
2. **Selecting an effect applies it immediately** — the canvas live-renders `[committed mix] + [active effect on top]`. So you can rapidly click down the list and preview each effect. (If the mix is empty, the active effect shows solo.)
3. **Active effect settings** — that effect's sliders (with mono numeric readouts), directly below the list. Editing re-renders live.
4. **Per-effect named presets** ("pixel1", "dither1", …) — each effect has its OWN small library of param-presets: a select/list of preset names + `SAVE` (name the current sliders) + delete. Persisted in `localStorage`, keyed by effect id. **Ship 2-3 built-in presets per effect** as starting looks so clicking through is immediately interesting; user-saved presets add to the list.
5. **`ADD` button** — its ONLY job is to **commit the active effect (with current params) into the mix** so you can stack/combine multiple effects. After add, the effect joins the mix list below.
6. **Mix list** — the committed stack: each row = effect name, enable toggle, reorder ↑↓, remove. This is the multi-effect combination that defines the final look and the exported style code.

Global actions (a slim bar, top or bottom of the left panel): `EXPORT PNG` · `COPY STYLE CODE` · `SAVE STYLE` · `LOAD STYLE` · `RESET`. These operate on the **whole mix** (the "style code" / preset with the `rstr_` id) — distinct from the per-effect presets in (4).

Keep the brutalist-mono styling from the "Editor UI" section above (monospace, square corners, 1px borders, dense, uppercase, single accent, no shadows/gradients/transitions).

### Preset format update
The exported style = the **mix list** (committed stack). The active-but-not-added preview effect is NOT part of the exported style until `ADD`ed. `preset.js` serializes the mix stack exactly as before (`{id, name, v, stack:[{effect,params}]}`); the deterministic `rstr_` id is a hash of the committed stack.

## C. Acceptance (v1.1)
1. **Double-click `index.html`** (via `file://`, no server) → editor loads, zero console errors.
2. Load an image; click down the effect list — each click instantly previews that effect on the canvas.
3. Adjust sliders; `SAVE` a per-effect preset named e.g. `pixel1`; reload the page; confirm `pixel1` persists and re-applies.
4. `ADD` two different effects into the mix; confirm both apply in order; reorder/remove works.
5. `COPY STYLE CODE`; run the engine over `test-assets/` with that style; outputs match and differ from inputs.

---

# v1.2 — OUTPUT block: crop + resize + format/quality (QUEUED — implement AFTER v1.1 is verified)

Rationale: crop/resize/webp are geometry+codec, **not shaders**. Build them as a single global **OUTPUT** block (not an effect, not a separate tool), shared by editor export and engine batch via the same preset. This makes the "style code" a complete output recipe (effects + crop + size + format + quality) so one batch command yields post-ready images. Pure compress-without-effects stays covered by the existing `image-compress` skill — do not rebuild it.

## Preset addition
```json
"output": {
  "crop": "original",     // "original" | "1:1" | "4:5" | "5:4" | "9:16" | "16:9" | "3:2" | "2:3"  (center crop to aspect)
  "size": null,           // longest side in px; null = keep source size (after crop). Do NOT upscale past source by default.
  "format": "png",        // "png" | "webp" | "jpeg"
  "quality": 0.92         // 0..1 for webp/jpeg; ignored for png
}
```
Default when absent = `{crop:"original", size:null, format:"png", quality:0.92}` (backward-compatible with existing presets). Include the `output` block in the deterministic `rstr_` id hash.

## Processing order (correctness — same in editor preview and engine)
`input → center-crop to aspect → resize (longest side = size, if set) → run effect passes at THAT resolution → encode to format@quality`.
Cropping/resizing BEFORE effects keeps pixel-based effects (pixelate block, halftone cell) WYSIWYG between preview and batch regardless of source resolution. The editor canvas displays this exact buffer (fit to screen), so preview == exported output.

## Editor
An `OUTPUT` panel in the left column (near the global bar): crop select, size input (px, empty = source), format select, quality slider (shown only for webp/jpeg). Draw a center-crop guide overlay on the canvas when crop ≠ original. Export filename extension follows `format`.

## Engine
Read the `output` block; apply the same crop/resize/encode; write each file with the correct extension. `canvas.toDataURL('image/webp', quality)` / `'image/jpeg'` / `'image/png'`.

## Acceptance (v1.2)
1. Set crop=1:1, size=1080, format=webp, quality=0.85; export → a 1080×1080 `.webp`, center-cropped, visibly compressed.
2. Same style via engine over `test-assets/` → all outputs are 1080² webp, differ from inputs.
3. A preset with no `output` block still exports a full-size PNG (default behavior).

---

# v1.3 — tooooools-scale effect library + OUTPUT tab + pure-grayscale brutalism

Three parallel work-streams with STRICT file ownership so two agents don't collide.

## Shared contract (both agents obey)
- **Effect entry schema** (in `effects.js`), extended with `category` + `presets`:
  ```
  { id, name, category, params:[{key,label,type:'range'|'color'|'select',min,max,step,default,options}],
    presets:[{name, params:{...}}], frag }
  ```
- **Category order** (for grouped UI): `TONE`, `HALFTONE`, `COLOR`, `DISTORT`, `STYLIZE`.
- UI groups the effect list by `.category`; effects with no/unknown category fall under `OTHER` (robust to partial state during the build).
- OUTPUT preset block = exactly the v1.2 schema above.

## Stream 1 — EFFECTS (owns `src/effects.js` ONLY)
Expand from 9 to ~24 effects to match tooooools breadth. Each gets a `category`, rich params, and 2-3 built-in `presets`. Grounded in tooooools' real toolset (stippling, dots, patterns, edge, distort, displace, dithering, bevel, recolor, scatter, gradients, CRT, ASCII) + shader standards.

Target catalog (implement all; keep each a single fragment-shader pass):
- **TONE:** `adjust` (have), `levels` (blackPoint/whitePoint/gamma), `threshold` (level/softness), `invert`, `hue` (rotate/sat), `blur` (radius; separable or small-kernel), `sharpen` (amount)
- **HALFTONE:** `halftone` (grid regular|benday, angle, cell, shape dot|line|square, mono|color — expand existing), `dither` (bayer2|4|8, levels, palette mono|rgb — expand existing), `stipple` (density, dotSize), `crosshatch` (spacing, angle, layers), `ascii` (charset ramp, cell, mono|color) ← finally add ASCII
- **COLOR:** `posterize` (have), `duotone` (have), `gradientmap` (2-4 color ramp, luminance-mapped = recolor/gradients), `quantize` (palette size / per-channel)
- **DISTORT:** `pixelate` (have), `displace` (noise amount/scale), `wave` (amplitude/frequency/direction), `scatter` (radius/seed), `chromatic` (have)
- **STYLIZE:** `edge` (sobel, threshold, invert), `emboss` (angle, depth = bevel), `crt` (scanlines, curvature, vignette, mask — expand existing scanlines), `grain` (have), `bloom` (threshold, intensity)

OUT of scope (iterative/video): cellular-automata, animation (slide/stack). Note them as future in README.
Follow the EXACT existing entry pattern (read the current `effects.js` first). Do NOT touch any other file.

## Stream 2 — OUTPUT tab + grayscale recolor + grouped UI (owns `src/ui.js`, `src/pipeline.js`, `src/preset.js`, `index.html`, `engine/*`, `README.md` — NOT `effects.js`)
1. **OUTPUT tab.** Left panel gets a tab strip: `EFFECTS` | `OUTPUT`. EFFECTS tab = current browser (grouped list + active sliders + per-effect presets + Add to mix + mix list). OUTPUT tab = the v1.2 controls (crop select, size px, format png|webp|jpeg, quality slider shown for webp/jpeg), + center-crop guide overlay on canvas when crop≠original. Global bar (Export/Copy/Save style/Load style/Reset) stays always visible above the tabs. Implement the full v1.2 OUTPUT processing (crop→resize BEFORE effects→encode) in `pipeline.js` + `preset.js` + `engine`.
2. **Grouped effect list.** Render the effect column grouped under category headers (TONE/HALFTONE/COLOR/DISTORT/STYLIZE), all visible, scrollable, one active. Group by the effect entry's `.category`.
3. **PURE GRAYSCALE brutalism — REMOVE the orange accent entirely.** No color anywhere. Tokens: background `#0a0a0a`, panels `#000`/`#111`, hairline borders `#2a2a2a`/`#333`, text `#bbb`/`#eee`, muted `#666`. **Active/selected = inverted** (bg `#eee`, text `#000`) or a solid `#fff` 1px outline — NOT a color. Sliders: track `#2a2a2a`, square thumb `#eee`. Buttons: `#111` bg, `#333` border, `#eee` text; hover = invert. Keep everything else brutalist (monospace, square corners, 1px borders, dense, uppercase, no shadows/gradients/transitions).

## Acceptance (v1.3)
1. Double-click `index.html`: 0 console errors; effect list shows ~24 effects grouped by category; UI is fully grayscale (no orange/any hue anywhere).
2. Click through many effects — each previews instantly; ASCII renders as characters.
3. OUTPUT tab: crop=1:1 + size=1080 + webp q=0.85 → Export gives a 1080² webp; crop guide shows on canvas.
4. Engine over `test-assets/` with a style that includes an output block → outputs are 1080² webp, differ from inputs.
5. Per-effect presets still persist; mix stacking still works.

## v1.4 — Settings gear (part of Stream 2; owner: ui.js + preset.js/localStorage)
- Add a **gear button** (`⚙`, boxed, in the always-visible global bar) that opens a **SETTINGS** view (overlay or third tab — pick what stays brutalist). Built as an extensible settings surface (more options later); FIRST option only for now:
- **Enable/disable effects ("engines").** A checklist of ALL effects grouped by category, each toggleable. **Disabled effects are hidden from the EFFECTS browser list**, so the user declutters the panel without editing code. Persist the disabled set in `localStorage` (`rstr.disabledEffects`). Default = all enabled.
- Disabling only hides from the picker: a saved mix/preset that references a disabled effect must STILL render correctly when loaded (do not drop it from the pipeline). 
- Acceptance: open gear → uncheck e.g. `grain` and `wave` → they vanish from the browser list → reload page → they stay hidden → re-check → they return; a mix that already contains a disabled effect still renders.

---

# v1.5 — catalog trim + tooooools-accurate DITHER/STIPPLE + OUTPUT Crop/Scale rework
Two parallel streams, strict file ownership (same split as v1.3).

## Stream A — effects (owns `src/effects.js` ONLY)
1. **Merge CRT + CHROMATIC** into a single `crt` effect (STYLIZE). Fold chromatic aberration into `crt` as params `rgbShift` (amount) + `rgbAngle`. Remove the standalone `chromatic` entry.
2. **Remove** `edge`, `emboss`, `wave` entirely (and their presets).
3. **Expand DITHER** to match tooooools exactly (observed 2026-07-03):
   - `pattern`: select **Bayer | Random | Diffusion** — Bayer = ordered matrix; Random = white-noise threshold; Diffusion = single-pass error-diffusion-style (blue-noise/approx, since true Floyd–Steinberg is sequential and not single-pass-GPU — see note). Label the third "Diffusion (F-S-like)".
   - `pixelSize`: block size (like tooooools "Pixel Size").
   - `colorMode`: bool — per-channel color dither vs 1-bit luminance (tooooools "Color Mode").
   - Presets: `1-bit`, `Color`, `Fine`.
4. **Expand STIPPLE** to match tooooools exactly (observed): all single-pass shader-doable (it's a variable-size grid halftone):
   - `threshold` (0–255 → normalized),
   - `gridType`: select **Regular | Benday** (Benday = alternate rows offset by half a cell),
   - `gridAngle` (degrees, rotate the grid),
   - `xSquares`, `ySquares` (grid counts),
   - `minWidth`, `maxWidth` (dot square size range, mapped from cell luminance).
   - Presets: `Comic`, `Fine`, `Benday`.
Follow the existing entry pattern; do NOT touch other files. Self-verify (throwaway harness in scratchpad): all effects compile/link, each preset changes pixels. Report final catalog + evidence.

NOTE on Floyd–Steinberg: true F-S is sequential error diffusion — not expressible in a single fragment-shader pass and our architecture is pure single-pass GPU. Deliver Bayer + Random + a single-pass "Diffusion" approximation now; a pixel-exact CPU F-S pass is a possible later add (would need a pipeline CPU stage). Flag this in the report.

Resulting catalog = 22 effects: TONE(7) adjust,levels,threshold,invert,hue,blur,sharpen · HALFTONE(5) halftone,dither,stipple,crosshatch,ascii · COLOR(4) posterize,duotone,gradientmap,quantize · DISTORT(3) pixelate,displace,scatter · STYLIZE(3) crt,grain,bloom.

## Stream B — OUTPUT Crop/Scale rework (owns `src/ui.js`, `src/pipeline.js`, `src/preset.js`, `index.html`, `engine/*`, `README.md` — NOT effects.js)
Split OUTPUT into TWO distinct dimension controls (was one conflated crop+size):

- **CROP block**: `ratio` (original | 1:1 | 4:5 | 5:4 | 9:16 | 16:9 | 3:2 | 2:3 | custom W×H) + **`align`** = a Figma-style **3×3 anchor picker** (9 clickable cells: TL T TR / L C R / BL B BR; default C). The anchor decides WHICH region of the source is kept when cropping to the ratio. Brutalist: a 3×3 grid of small squares, active one filled `#eee`.
- **SCALE block**: output size, separate from crop. Provide `mode`: none | longest-side px | exact W×H (+ show W/H inputs for exact). "More size options" = these.
- **FORMAT**: png | webp | jpeg + quality (webp/jpeg only).

Preset `output` schema becomes:
```json
"output": {
  "crop":  { "ratio": "original", "align": "C" },
  "scale": { "mode": "none", "size": null, "width": null, "height": null },
  "format": "png",
  "quality": 0.92
}
```
Migrate old presets (`{crop:"1:1", size:1080,…}` → `crop.ratio` + `scale.mode:"fit",size:1080`). Include the whole `output` block in the `rstr_` id hash. Default when absent = the object above.

**Processing order:** `input → crop to ratio at align anchor → scale (per mode) → effects → encode` (crop+scale BEFORE effects, WYSIWYG). Wire through pipeline.js, preset.js, engine (render.html + rstr.js), and the OUTPUT tab UI. Update the canvas crop-guide overlay to reflect ratio AND align anchor.

## Acceptance (v1.5)
1. Catalog shows 22 effects; `chromatic`, `edge`, `emboss`, `wave` gone; `crt` has an rgb-shift param.
2. DITHER shows Pattern(Bayer/Random/Diffusion) + Pixel Size + Color Mode; each visibly differs. STIPPLE shows Threshold/Grid Type/Grid Angle/X·Y Squares/Min·Max Width; Benday offsets rows.
3. OUTPUT: set ratio=1:1, align=Top-Left, scale=exact 1080×1080 → export crops from the top-left, not center; a center-anchored crop differs. Engine reproduces it. webp/jpeg quality works.
4. Double-click file:// still 0 console errors; grayscale intact.

---

# v1.6 — real Floyd–Steinberg dither, stretching stipple marks, flat list, image reset
Observed in tooooools 2026-07-03: dither's own controls are exactly Pattern(F-S/Bayer/Random)+Pixel Size+Color Mode — the reason it looks better is (a) **true F-S error diffusion** and (b) it dithers on a **downscaled canvas** (Canvas Size ~600 ÷ Pixel Size) giving clean chunky dots. Stipple marks **stretch to fill their grid cell**, so asymmetric X/Y square counts turn dots into lines.

Two parallel streams, strict file ownership.

## Shared contract
- Pipeline gains an optional per-effect **CPU stage**: if an effect entry has `cpu(rgba, w, h, params) -> rgba` (Uint8ClampedArray in/out), the pipeline runs it on the CPU (readback → run → re-upload as texture) instead of a shader pass for that effect. `frag` and `cpu` are mutually exclusive per entry.
- Pipeline gains `clearImage()` — resets to the no-image state (drop zone).

## Stream A — effects (owns `src/effects.js` ONLY)
1. **DITHER → real quality + more settings.** Reimplement dither as a `cpu` effect (not a shader): downsample the buffer by `pixelSize` → dither the small buffer → nearest-neighbour upscale back (this is what makes tooooools' dots clean). Params:
   - `pattern`: **F-S | Bayer | Random** — F-S = true Floyd–Steinberg serpentine error diffusion (now feasible because it's a CPU stage on a small buffer); Bayer = ordered; Random = white-noise.
   - `pixelSize` (block size — the downscale factor),
   - `levels` (2..N quantization steps per channel — NEW, more control),
   - `contrast` (pre-threshold contrast/black-white spread — NEW, gives the punchy tooooools look),
   - `colorMode` (bool — per-channel color vs 1-bit luminance).
   - Presets: `1-bit F-S`, `Chunky`, `Color`.
2. **STIPPLE → stretching marks.** Fix marks so each mark is a rectangle that FILLS its grid cell proportionally to luminance, using the cell's actual width/height (from `xSquares`/`ySquares`). When X≠Y counts (or via min/max width per axis) marks stretch into **lines**, matching tooooools — not fixed squares. Keep params threshold/gridType(Regular·Benday)/gridAngle/xSquares/ySquares/minWidth/maxWidth; ensure they drive the stretch. Presets: `Dots`, `Lines`, `Benday`.
Self-verify with a throwaway scratchpad harness: dither F-S vs Bayer vs Random differ and F-S has no visible ordered grid; stipple with xSquares≪ySquares produces line-like marks (measure anisotropy). Do NOT touch other files.

## Stream B — UI (owns `src/ui.js`, `index.html`, `src/pipeline.js`)
1. **Remove effect categories.** Render a single FLAT list of all effects (no TONE/HALFTONE/… headers, no grouping). Keep it dense/brutalist.
2. **Image reset/replace.** Add a clear affordance so a loaded image can be swapped: a small `✕`/`NEW IMAGE` control (e.g. top-left of the canvas, or in the global bar) that calls `pipeline.clearImage()` and returns to the drop zone; also allow drag-drop / click to load a different image at any time (replace the current one). Right now the image gets stuck with no way back — fix that.
3. Implement the **CPU-stage runner** + **`clearImage()`** in pipeline.js per the Shared contract (so Stream A's dither works and the engine gets it too via the same pipeline).
Keep pure-grayscale brutalism. Verify: flat list (no category headers); load image → `✕`/NEW returns to drop zone → load a different image works; dither (F-S) renders cleanly in both editor and engine; double-click file:// 0 console errors.

## Acceptance (v1.6)
1. No category headers — flat effect list.
2. DITHER: Pattern F-S/Bayer/Random + Pixel Size + Levels + Contrast + Color Mode; F-S looks clean (no ordered grid), chunky at higher Pixel Size.
3. STIPPLE: setting xSquares low + ySquares high turns dots into vertical lines (and vice-versa); Benday offsets rows.
4. Loaded image can be cleared/replaced via the new control; engine still batch-renders (incl. dither F-S) correctly.

---

# v1.7 — editable mix layers (QUEUED after v1.6; owner: `src/ui.js` only)
Problem: once an effect is `ADD`ed to the mix you can't go back and tweak it (e.g. add CRT, then want to adjust it — no way back). Make mix layers editable in place.

Interaction model — the settings panel edits ONE of two targets:
- **NEW mode** (click an effect in the list): the effect is previewed on top of the committed mix; `ADD TO MIX` commits it. (unchanged)
- **EDIT mode** (click a mix layer row): that existing layer becomes the edit target — its params load into the settings panel, and editing sliders / choosing a per-effect preset mutates THAT layer in place with live re-render. No `ADD` (it's already in the mix); changes persist to the layer immediately.

Details:
- Clicking a mix row **selects/highlights** it (inverted) and enters EDIT mode; the panel header shows which is edited (e.g. `EDIT · CRT [2]` vs `NEW · CRT`). In EDIT mode the preview is just the full mix with the selected layer's live edits (no extra top preview); the `ADD TO MIX` button is hidden.
- Clicking an effect in the list returns to NEW mode. Reorder ↑↓ / enable toggle / remove on mix rows stay and must not clobber the current edit selection (keep the selected layer stable across reorders where possible).
- Per-effect presets in EDIT mode apply to the selected layer.

Acceptance: add CRT → click it in the mix → its sliders reappear → change a param → the mix updates live (no second CRT added); switch to another layer edits that one; clicking an effect in the list starts a fresh NEW effect again.

## v1.7b — OUTPUT becomes a layer + dimensions readout (same pass, `ui.js` + minor `index.html`)
The user thinks in layers and wants OUTPUT to be part of the programmable stack (e.g. a style that just crops icons to 512×512, applied in batch).
- **Remove the `EFFECTS | OUTPUT` tab strip.** Instead, show OUTPUT as a **special pinned layer** in the mix stack — a non-removable row (e.g. `◇ OUTPUT`) pinned at the TOP (it runs first: crop/scale is geometry, before effects). Clicking it enters EDIT mode like any layer and shows the crop (ratio + 3×3 align) / scale (mode/size/W·H) / format+quality controls in the settings panel.
- OUTPUT stays its own `output` block in the preset (no schema change) — it's already in the style code, so an effects-empty style still crops/scales in the engine. The pinned layer is just the UI surface for it.
- It can be toggled (enable/disable the crop/scale); default = passthrough (original/none) so it's harmless when unused. Not reorderable, not removable.
- **Dimensions readout** in the OUTPUT editor: live `SRC {w}×{h} → OUT {w}×{h}` (compute the output dims from the loaded image + crop ratio/align + scale mode). Show `— × —` when no image is loaded.
- Processing order unchanged (pipeline already does crop/scale before effects); this is a UI/representation change only.

Acceptance (v1.7b): no OUTPUT tab; a pinned `OUTPUT` layer sits atop the mix; clicking it edits crop/scale/format; the editor shows live SRC→OUT pixel dimensions; a style with only the OUTPUT layer set (no effects) crops/resizes images in both editor export and engine batch (icon-crop use case).

---

# v1.8 — paste Style Code + named Style Library (QUEUED after v1.7; `src/ui.js` + `src/preset.js`)
0. **Guard: OUTPUT editor must be reachable.** First confirm v1.7's pinned OUTPUT layer actually opens its crop/scale/format editor on click (the user saw it "disappear" mid-rework). If it regressed, fix it.
1. **Paste / import a Style Code.** Add a `PASTE CODE` control in the global bar. It accepts either full style JSON (what `COPY STYLE CODE` produces: `{id,name,v,stack,output}`) or a bare `rstr_…` id (resolve against the style library + shipped `presets/`). Parse → validate → load into the mix (layers + output). On malformed input show a brief inline error, don't crash. (Use a small textarea/inline field — NOT a browser `prompt()`/dialog.)
2. **Named Style Library** (full styles = layers + output, distinct from per-effect presets). Persist in `localStorage` (`rstr.styleLibrary` = `{name: style}`). Repurpose the global-bar style controls into a compact STYLES area:
   - `SAVE` → name the current style → store in the library (overwrite-confirm if name exists).
   - a dropdown/list of saved style names → selecting one LOADs it into the mix.
   - `DELETE` removes the selected saved style.
   - keep `COPY CODE` (export current) + the new `PASTE CODE` (import).
   Reuse the existing `preset.js` serialize/deserialize + `rstr_` id logic; the library stores whole styles. Loading a style replaces the current mix + output and re-renders.
Keep grayscale brutalism, flat list, editable layers, pinned OUTPUT layer. 
Acceptance: SAVE current mix as "icons" → it appears in the styles list → RESET → LOAD "icons" restores all layers + output; COPY CODE then PASTE CODE round-trips the same style; pasting a bare `rstr_` id from the library loads it; reload page → saved styles persist; malformed paste shows an error, no crash.

---

# v1.9 — fix stretched image + canvas viewport (zoom/pan) (`src/ui.js` + `index.html` CSS)
**BUG:** any loaded image displays STRETCHED to fill the canvas area — aspect ratio broken. The WebGL canvas renders at the correct processing resolution; the DISPLAY is distorting it (likely CSS `width/height:100%` on a non-matching container). Fix so the image always shows at its true aspect ratio (no stretch), centered.

Add a design-canvas **viewport** (display layer only — do NOT change the shader pipeline or re-render on pan/zoom; use a CSS transform on the canvas element inside an `overflow:hidden` container; the checkerboard stays fixed on the container so panning reveals more of it):
- **On load: fit-to-view** — scale the image to fit the viewport preserving aspect (contain); if it's smaller than the viewport, show at 100%. Center it.
- **Zoom slider** — sets zoom %; show the current zoom % readout (mono).
- **Ctrl + mouse wheel** — zoom in/out, centered on the cursor. (Plain wheel does NOT zoom.)
- **Pan** — drag with the MIDDLE mouse button (wheel button) held.
- **Fit / 100% reset** control.
- The OUTPUT crop-guide overlay must transform together with the canvas (keep it aligned to the image) — put canvas + overlay in the same transformed wrapper.
Keep grayscale brutalism. This affects display only; EXPORT and the engine still output the full processing-resolution image (unaffected by viewport zoom).

Acceptance (v1.9): load a wide (e.g. 1600×600) and a tall image → both show at correct aspect, not stretched, fit-centered; zoom slider changes size without distortion; Ctrl+wheel zooms toward the cursor; middle-drag pans; Fit/100% works; the OUTPUT crop guide stays aligned while zoomed/panned; EXPORT still writes full-res output regardless of on-screen zoom; double-click file:// 0 console errors.


---

# v2.0 — 2026-07-10 session: dotpattern · scrub bars · PRE rework · layer opacity · CRT split · catalog trim (IMPLEMENTED + VERIFIED)

Written after the fact — this session was implemented interactively, verified per item (engine renders + headless-Chrome UI smoke tests), then documented here.

## Effects
1. **NEW `dotpattern` (Dot Pattern)** — square-dot grid sibling of stipple, built from a user photo-ref: sample luminance at the cell center, map brightness→dot size on BOTH axes (unlike stipple's width-only bars). Params: `threshold` (stipple-style size map), `spacing` (grid pitch px), `scale` (dot side at black, % of cell), `gridType` **Regular | Brick** (Brick = alternate COLUMNS staggered half a cell vertically, matching the ref).
2. **NEW `aberration`** — chromatic aberration extracted from CRT (its hardcoded 0.1-strength convergence was near-invisible and coupled to the mask). Modes: **Radial (lens)** — R/B shift grows 0→`amount` px from center to edges; **Linear** — uniform shift along `angle`. R +offset, B −offset, G fixed.
3. **CRT reworked** (two deliberate departures from the tooooools port):
   - convergence params (4) removed → use `aberration` as its own layer;
   - `distortion` range 0–0.08 → **0–2** with a NEW normalized tube-curvature formula: `f = (1 + r²k)/(1 + 0.25k)` — multiplier 1 at edge midpoints, <1 at center (content magnifies = visible bulge), >1 toward corners. The old formula (`coord + cc·(1+d)·d`, d=r²k) grew as r³ — at usable strengths it cropped corners without bending the image.
   - Outside the distorted source: `fragColor = vec4(0)` — **transparent alpha void**, not the old clamp's edge-stretched pixels.
4. **Catalog trim: 29 → 25.** Removed `displace`, `distort` (the whole DISTORT pair), `blur` (lives in PRE), and standalone `hue`/`sharpen` — **merged into `adjust`** as params (chain: sharpen → hue rotate → brightness/contrast/saturation/gamma; old adjust codes render identically — new keys default to identity). Old style codes referencing removed ids: layers dropped by `validatePreset` with a console warning (existing mechanism).

## Pipeline
5. **Per-layer OPACITY** — layer schema gains optional `opacity` (0–1): the pipeline mixes a pass's output back over its own input. GPU layers: raw effect → scratch `blendFbo`, then a BLEND_FRAG pass (`mix(prev, eff, op)`) into the normal target. CPU layers: input snapshot (`pixels.slice()` before `cpu()` — it may mutate in place) blended in JS. Serialized **only when < 1** → old codes/ids stay byte-identical. Verified pixel-exact: gradient → invert@0.5 = flat 50% gray; dither@0.5 over it = 64/192 checker.

## Editor
6. **Scrub bars** (`makeScrub` in ui.js) replace BOTH the PRE rotary knobs and native `<input type=range>`: full-width bar, label left / value right / fill = position; pointer-capture click-or-drag = absolute set, wheel = ±step, dblclick = reset. One control everywhere (PRE + every `range` param + layer Opacity, which renders as the first scrub of any effect target).
7. **PRE rework** — PRE module rows: **Scale · Blur · Grain · Gamma** scrubs + BP/WP levels track.
   - **Scale** = % of source longest side, writes through to `output.scale` (single source of truth; 100% → mode `none`, else `fit`), so downscale happens before effects; open OUTPUT tab stays in sync.
   - **Bake-on-add:** PRE is a live working buffer previewed at the END of the committed mix (right under the NEW preview). `ADD TO MIX` commits it as an explicit `preprocess` layer glued under the new effect, then resets it. Styles no longer serialize a separate `pre` block — pending PRE exports as a trailing `preprocess` stack layer. Legacy codes with a `pre` block: editor converts to a leading `preprocess` layer, engine still prepends (render.html untouched) — same look on both heads.
8. **ADD TO MIX → EDIT jump** — committing switches the edit target to the new layer (previously it stayed in NEW mode, leaving the picked effect previewed ON TOP of the just-committed copy = double-applied).
9. **Panel restructure** — per-effect preset `Save`/`Del` + `ADD TO MIX` moved out of the scroll area into a **pinned footer**; **Styles bar collapsed** by default behind a `▤` toggle in the global bar (`Export · Reset · ▤`); the **⚙ settings gear moved to the canvas top-right** (still toggles the effect-checklist view in the panel).
10. Desktop shortcut `RSTR.lnk` (target `index.html`, icon `icon/rstr.ico`).

## Acceptance (all verified 2026-07-10)
- Engine renders: dotpattern Regular + Brick; CRT distortion 1.0 shows bent shapes + transparent rounded corners; aberration radial fringing; adjust hue=180 + sharpen; opacity blends (GPU + CPU paths pixel-checked).
- Headless-Chrome UI smokes (puppeteer against `file://index.html`): 4 PRE scrubs (Scale/Blur/Grain/Gamma); Scale drag → `fit` + dims readout halves, dblclick → 100%; ADD switches `NEW·`→`EDIT·`, add-btn hides; PRE blur bakes as `1. Preprocess` + resets to 0; Opacity scrub first and persists after ADD (50%); removed effects absent, Adjust shows Hue/Sharpen; CRT shows no convergence params; styles bar toggles; gear sits inside canvas top-right; zero console/page errors throughout.

---

# v2.1 — DONE (2026-07-11): dot-family merge · opacity on mix rows · CRT mask/bloom fixes · reverse-colors (IMPLEMENTED + VERIFIED)

Five items of 2026-07-10 user feedback, all shipped and verified 2026-07-11. Written after the fact, same as v2.0 — implemented interactively, verified per item (byte-identity regression proofs against the pre-merge shaders, pixel/SHA checks, headless-Chrome UI smokes), then documented here.

## Effects (`src/effects.js`)
1. **Dot family collapsed: `dots` + `edge` + `dotpattern` → one `dots`.** Catalog 25 → 23. The merge was clean because `edge` was a strict param-subset of `dots` (same threshold/minDotSize/maxDotSize/cornerRadius/stepSize, minus grid/angle/noise — only the shader body differed) and `dotpattern` just swapped dot-size params for spacing/scale.
   - ONE `frag`; the three old shader bodies moved in **verbatim** as `modeDots()` / `modeEdge()` / `modePattern()`, dispatched by a new `mode` select (Dots 0 / Edge 1 / Pattern 2). Pixel output deliberately unchanged — see byte-identity proof below.
   - `gridType` unified to Regular(0) / **Staggered**(1) with **no value remap**: `dots`' old "Benday" (alternate ROWS offset half a cell in X) and `dotpattern`'s old "Brick" (alternate COLUMNS offset half a cell in Y) were already the same concept at the same value (1) in both shaders.
   - Params = the union of all three, gated in the UI by mode (see Editor §5 below) so the panel doesn't show all 11 controls at once: `mode` (always) · `threshold` 0–255 def 128 (modes 0,1,2) · `gridType` def 0 (0,2) · `gridAngle` −45–45 def 0 (0) · `minDotSize`/`maxDotSize` 0–50 def 1/10 (0,1) · `cornerRadius` 0–20 def 4 (0,1) · `stepSize` 3–20 def 8 (0,1) · `noise` 0–20 def 2 (0) · `spacing` 2–100 def 12 (2) · `scale` 1–100 def 70 (2). Ranges are the union of the old ones (`edge` capped dot size at 40, `dots` at 50 → kept 50). Defaults are `dots`' own defaults, so old `dots` codes render byte-identical without migration; `edge`'s old defaults (e.g. threshold 255) only survive inside its own presets, not as the fresh-pick default — an accepted, deliberate compromise.
   - 9 presets, renamed to stop the old name collision ("Tooooools" existed in two effects): `Dots` / `Benday` / `Rotated Circles` (mode 0), `Edge` / `Edge Fine` / `Edge Bold` (mode 1), `Pattern` / `Pattern Brick` / `Pattern Coarse` (mode 2).
2. **CRT `maskStrength`.** New range param, 0–1 step 0.01, default 1, placed after the mask-pattern select. Shader: `pattern = mix(vec3(1.0), pattern, u_maskStrength);` right before the mask multiplies into the color, so 0 = mask fully washed out, 1 = the port's original look exactly (verified default-omitted preset renders SHA-256-identical to an explicit `maskStrength: 1`).
3. **CRT bloom-vs-distortion bug fixed.** `bloomColor = bloomSample(v_uv)` (undistorted source) → `bloomSample(uv)` (the tube-curvature-distorted coordinate already computed earlier in the shader). The undistorted image no longer ghosts through the warped one, and bloom now dies correctly in the void via the existing early `return vec4(0.0)` instead of glowing over it.

## Migration (`src/preset.js`)
4. **`LEGACY_EFFECTS` map + `migrateLegacyEffects()`**, run in `validatePreset` *before* the unknown-effect drop: `edge → {effect:'dots', params:{mode:1}}`, `dotpattern → {effect:'dots', params:{mode:2}}`. Old param keys pass through unchanged (they're a subset of the merged `dots`' keys); `enabled`/`opacity` untouched. A migrated mix gets a NEW `rstr_` id — the hash covers the mix contents, and the layer's `effect` id genuinely changed. Accepted cost, not a bug: pasting an old style code that used `edge`/`dotpattern` still renders identically, just under a different code.

## Editor (`src/ui.js`, `index.html`)
5. **Opacity moved from the edit panel onto the MIX rows.** Previously the first scrub in the edit panel's param stack (shown in both NEW and EDIT); now a thin scrub on a second line inside each effect layer's row in the MIX stack, reusing the shared `makeScrub` at the existing 11px scrub type size (no new font-size step introduced). `.mix-item` became a column: the old row content is now wrapped in `.mix-row-top`, with a `.mix-opacity` scrub below it compacted to 16px height. The scrub stops its own click from bubbling, so dragging opacity doesn't also select/reorder the row underneath it. `◇ OUTPUT` gets no opacity row (it isn't opacity-mixable); baked `preprocess` layers DO get one (they're ordinary layers once baked). A NEW, uncommitted layer has no opacity UI at all — it lands in the mix at 100% on `ADD TO MIX`, same as before. The now-dead `state.editTarget.opacity` field and its `currentOpacity()`/`setCurrentOpacity()` helpers were deleted. Schema unchanged — `layer.opacity`, serialized only when < 1.
6. **`showIf` panel gating**, new mechanism, needed because a union of 11 params where any one mode reads 5–6 of them would be a worse panel than three separate effects were. `showIf: { key: 'mode', in: [0,1] }` on a param entry; `paramVisible(param, params, def)` skips the control in `buildActiveParams`, and changing a gating `select` (here, `dots`' `mode`) rebuilds the panel so hidden params disappear/reappear. **UI-only** — the pipeline still uploads every param as a uniform regardless of mode, so GL never sees an unset uniform.
7. **REVERSE button** for `recolor` and `gradientmap`. UI-level only: rewrites existing param values, adds no new serialized param. Appended in `buildActiveParams()` when `def.id === 'recolor' || def.id === 'gradientmap'`; full-width brutalist button (`.reverse-colors-btn`, same pattern as the existing `.ascii-copy-btn`). `gradientmap` mirrors every stop's position (`stops[i].pos = 1 - pos`). `recolor` has three independently-keyed stops (`stop1/pos1 … stop3/pos3`, 0–100) whose shader sorts (pos, color) pairs defensively, so instead of a literal "swap the two colors" it mirrors each stop's own position (`posN = 100 - posN`) — for the shipped symmetric default (0/50/100) that's identical to swapping the outer colors, but it stays correct on asymmetric custom stops, which a color-only swap would silently get wrong. Both branches rebuild the params panel and re-render.

## Verification (2026-07-11, headless system Chrome + puppeteer UI smokes against `file://index.html`)
- **Byte-identity regression proof for the merge** — the pre-merge `effects.js` was kept aside and rendered against the same params as the merged one: old `dots` vs merged mode 0 with `mode` key *absent* (the real legacy shape) → identical, 71838 B = 71838 B; same with explicit `mode:0` → identical; old `edge` vs migrated `dots{mode:1}` → identical, 5074 B = 5074 B; old `dotpattern` vs migrated `dots{mode:2}` → identical, 13866 B = 13866 B.
- A legacy style JSON containing both an `edge` layer and a `dotpattern` layer survives `validatePreset` (both migrated, neither dropped by the unknown-effect path) and renders end-to-end.
- `maskStrength` is not a dead param: `shapes.png` center pixel (127,127) reads (101,85,97) at 0, (101,63,72) at 0.5, (101,2,2) at 1; a preset that omits the key renders SHA-256-identical to `maskStrength: 1`.
- CRT `distortion 0.5` + `bloomIntensity 2` + `bloomThreshold 0.1`: all four corners (plus a 2%-inset near-corner) read exactly (0,0,0,0) — the void is not lit by bloom anymore.
- Editor smokes: opacity scrub present on mix rows, absent from the edit panel and from `◇ OUTPUT`; clicking it sets 50% without selecting/reordering the row; switching `dots`' Mode rebuilds the panel with no orphaned controls (9 at Dots → 6 at Edge → 5 at Pattern); REVERSE appears only on `recolor`/`gradientmap` and visibly changes values; CRT panel shows Mask Strength; zero console/page errors throughout.

---

# 2026-07-12 — glitch · CRT scanlines/TV cleanup · stipple seam fix · alpha-safe generative CPU effects · CANVAS SIZE · per-layer blend modes · MASK flag · ORIGINAL base plate · three-column UI rebuild (IMPLEMENTED + VERIFIED)

Written after the fact, same convention as v2.0/v2.1 — implemented interactively over the session, verified per item in headless system Chrome (engine renders + puppeteer UI smokes against `file://index.html`), then documented here. Catalog 23 → 24.

## Effects (`src/effects.js`)
1. **NEW `glitch`** (DISTORT) — horizontal slice displacement: the frame is cut into `sliceHeight`-px rows, each rolling one Bernoulli trial (`amount` = % chance it tears); a torn row samples `v_uv.x` shifted by a per-slice random offset up to `maxShift` px and **wrapped** (`mod 1.0`), not clamped or voided — the classic wrap-around tear, distinct from CRT's alpha-void lens choice. `blockNoise` optionally subdivides a torn slice into narrower blocks along X, each with extra jitter on top of the slice's base shift (0 = one clean VHS-tear bar, 100 = macroblock-style datamosh fragmentation). Presets `VHS Tear` / `Datamosh` / `Subtle`. Deliberately does NOT split RGB channels — `aberration` already owns chromatic aberration; duplicating it here would just be a worse copy, so stack `glitch` + `aberration` for "torn AND fringed." Determinism: a coordinate hash (`glitchHash`), never `Math.random`, so preview == batch. `seedOffset` is a dedicated per-layer uniform (`u_seedOffset`), folded additively into the hash alongside the shared `u_seed` — deliberately NOT keyed `seed`, because `u_seed` is already uploaded unconditionally by the pipeline for every pass and a param literally named `seed` would resolve to that same uniform location and silently shadow it (`seedOffset` still lets two `glitch` layers in one mix roll independently different tears, while a global reseed shifts them together).
2. **CRT `Scanlines` mask** (value 3, appended AFTER Monitor(0)/TV(1)/LCD(2) — never inserted between/before, so old `patternType` values keep rendering byte-identically) — plain horizontal bands, no RGB phosphor triads. Reuses `dotPitch` (line spacing) and `dotScale` (line thickness as a fraction of pitch) instead of adding new params, via the same `smoothstep(edge, edge*(1-falloff), d)` idiom `circularDot`/`rectDot` already use, so it obeys `falloff` and `maskStrength` (`mix(vec3(1.0), pattern, u_maskStrength)`) consistently with the other three masks.
3. **CRT `TV` removed from the picker.** Measured: `TV`'s only difference from `LCD` is a half-element VERTICAL phase shift of alternate subpixel-column groups — both read as the same vertical RGB stripes (mean channel diff 4.5/255, no better at coarse pitch). The `tvPattern()` shader branch and `patternType` value 1 REMAIN untouched so an old style code carrying `patternType:1` still renders byte-identically; the picker now lists Monitor(0) / LCD(2) / Scanlines(3) with a deliberate gap at 1.
4. **Stipple Y-axis micro-gap fixed.** The mark's mask used `mx * my` — an antialiased falloff on BOTH axes — but each fragment belongs to exactly one grid cell, so the Y falloff faded to 0.5 exactly at the cell border with no neighbouring fragment to blend against, leaving a grey seam every `cellY` px. Fixed to `mask = mx` (X falloff only); the bar now fills its full cell height by construction, since there's no partial-coverage neighbour to antialias against on Y. (tooooools avoids this entirely by drawing overlapping `rect()`s onto a canvas — a per-fragment shader can't composite against a neighbour it never sees.)
5. **`patterns` / `gradients` / `scatter` now preserve incoming alpha.** All three are CPU stages that draw their generative output onto an opaque white `<canvas>` (dot patterns, gradient ramps, scattered marks) and read back `getImageData`, whose alpha is 255 everywhere regardless of the source's own alpha — they were forcing `a=255` on every output pixel. That silently punched out the new `◇ ORIGINAL` plate (nothing to source-over if alpha is always 255) and any `alpha`/`alpha-invert` blend holes from an upstream layer. Fix: after drawing, restore each pixel's alpha from the pass's own input (`imgData[i] = top[i]` / equivalent, same top-down w×h×4 coordinate frame) without touching the RGB the generative stage just painted. RGB output is unchanged — byte-identical on any opaque source, since alpha was the only thing wrong.

## Pipeline / preset (`src/pipeline.js`, `src/preset.js`)
6. **CANVAS SIZE — new `output.scale` mode `width`** (`{mode:'width', size:N}`): an explicit working-buffer WIDTH in px; height derives from the post-crop aspect (`th = cropH * (size/cropW)`). Every ported effect param (stipple cell, dot pitch, CRT mask pitch, …) is tuned in absolute pixels against tooooools' ~600px canvas; RSTR's old default rendered effects at the FULL source resolution, so a stipple cell that reads correctly at 600px shrinks to a hairline at 2400px — the effect stops reading entirely. `none`/`fit`/`exact` are untouched; `width` sits alongside them in `SCALE_MODES`.
7. **Per-layer BLEND MODES.** New `BLEND_MODE_FRAG` GPU program + a CPU-path equivalent, selected whenever a layer's `blend !== 'normal'` (the pre-existing `blend === 'normal'` fast path, `BLEND_FRAG`, is untouched byte-for-byte so every old style code renders pixel-identical to before this feature). Catalog = Figma's `BlendMode` enum minus `PASS_THROUGH` (groups-only): Darken/Multiply/Plus darker("linear-burn")/Color burn · Lighten/Screen/Plus lighter("linear-dodge")/Color dodge · Overlay/Soft light/Hard light · Difference/Exclusion · Hue/Saturation/Color/Luminosity, plus RSTR's own **`alpha`**/**`alpha-invert`** (the layer's grayscale output becomes an alpha mask on its backdrop: `a = b.a * luma(s)` or `1 - luma(s)`). Formulas ported verbatim from the **W3C Compositing and Blending Level 1** spec — separable modes directly, the four non-separable modes (Hue/Sat/Color/Luminosity) via the spec's own `Lum`/`ClipColor`/`SetLum`/`Sat`/`SetSat` helpers — and verified against an independent NumPy reference implementation, max error ≤1/255. `BLEND_MODES` in `src/preset.js` is the single source of truth: array index doubles as the shader's `u_blend` switch code. Composite is `mix(backdrop, blend(backdrop, source), opacity)`, same shape as the pre-existing plain-opacity mix, just with `blend()` in place of the raw source. Serialized only when ≠ `'normal'`.
8. **Per-layer MASK flag.** The mix is a linear pipeline, so "reveal layer B through layer A" was inexpressible before this. A layer flagged `mask: {invert}` is NOT composited — the pipeline routes its raw effect output into a dedicated scratch target (`this.maskFbo`) instead of the normal chain — and its luminance becomes an additional multiplier on the blend opacity of the NEXT enabled, non-mask layer: `o = opacity * (invert ? 1-luma(mask) : luma(mask))`, grafted into both `BLEND_FRAG` and `BLEND_MODE_FRAG` as a conditional (`u_hasMask`) that is a pure no-op — `o` stays exactly `u_opacity` — for every layer not fed by a mask, so pre-mask output is byte-identical. `invert` is the common case (stipple/dither marks are black, so masking "through" the marks needs the luminance flipped). Two masks in a row: the LAST one before a real (non-mask) target wins — encountering a new mask layer simply overwrites `maskFbo`/`pendingMask`, discarding the earlier one's computed mask unconsumed. A trailing mask with nothing non-mask after it is a true no-op. Deliberately NOT Photoshop's masking machinery — no mask channels, no linking, no group masks — just the one bit that buys `stipple[MASK,inv] → gradientmap` and `scatter[MASK] → bloom`. Known limit: only reaches the ADJACENT next layer; a distant target would need inter-layer pointers and a real graph (backlog).
9. **`◇ ORIGINAL` base plate.** New pinned BOTTOM row in LAYERS (mirrors `◇ OUTPUT`'s pinned TOP row) — NOT part of `state.mix`, not draggable/removable, no blend control. Implemented as a genuinely separate FINAL pass (`PLATE_FRAG`), after the whole stack, compositing the finished result Porter-Duff **source-over** the raw, un-effected source texture (`u_plate`) × the plate's own `opacity` (which multiplies only the PLATE's alpha, so it reads as "how strongly the original shows through" rather than a global fade). Real Porter-Duff — premultiplied alpha math, not a naive `mix()` — because where both top and bottom are partially transparent a plain `mix()` gives the wrong answer. `enabled` **defaults to `false`**, and that default is load-bearing, not taste: CRT renders a deliberate transparent void outside its tube (its whole "lens" look depends on that void), and a plate ON by default would silently fill it and change the rendered output of every existing `crt` style code the instant this feature shipped. New preset top-level key `source: {enabled, opacity}`, serialized only when it differs from `{enabled:false, opacity:1}`.
   - **History note:** the FIRST implementation used "pipeline input" semantics instead — fading the *source image's own alpha* before the stack ran, driven by the same opacity value. That was wrong: fading the input's alpha doesn't fill anything, it just makes the input itself more transparent going INTO the stack, and any hole an effect punches downstream (`alpha`/`alpha-invert`, CRT's void) stays a hole. The plate approach (composite AFTER the stack, not fade BEFORE it) is what actually fills holes with the original image, and is the one that shipped.
10. **Layer schema is now `{effect, enabled, params, opacity?, blend?, mask?}`.** `opacity` only when < 1 (pre-existing rule), `blend` only when ≠ `'normal'`, `mask` only when present — same "serialize only when non-default" convention for all three, plus the top-level `source` block following the identical rule. This is what keeps every pre-existing style code's `rstr_` id byte-identical: `presets/my-retro.json` still hashes to `rstr_d988923b`, re-verified after EVERY change landed this session, not just once at the end.
11. **Canvas viewport: `freshImage` split.** A genuinely new source image should re-`refitView()` (capped at 100%, never upscale); a buffer resize triggered by dragging PRE's CANVAS scrub on the SAME image should NOT refit — it should hold the on-screen size constant by compensating zoom (`view.zoom *= oldW/newW`), so the effect visibly coarsens or refines instead of the whole image shrinking or jumping. These two behaviours were conflated at first (both routed through one resize handler) and fought each other; split via an explicit `view.freshImage` flag set `true` on a new source load and consumed (then cleared) by the next backing-store resize.

## Editor UI (`src/ui.js`, `index.html`) — substantially rebuilt
12. **Three columns**, replacing the single ~280px left column that had started overflowing and clipping its own pinned footer: **nav** (`#nav-panel` — `RSTR` wordmark → `/Styles` fixed header, library + Save/Del/Copy/Paste + Reset → `/Effects`, the ONLY scrolling region, styled square scrollbar) · **workbench** (`#panel` — PRE always expanded → the EDIT/NEW/OUTPUT settings panel with its own RESET + a PRESETS modal trigger → `ADD TO MIX` → LAYERS/MIX stack → pinned footer, `EXPORT` only) · **canvas**.
13. **`/Effects` catalog is user-organisable**: native HTML5 drag-to-reorder (no library), plus user-created collapsible groups — a group is itself draggable and renameable by double-click; a group cannot nest inside another group. State is `state.effectOrder` (an array mixing plain effect ids with `"@group:<id>"` anchor tokens marking where a group header sits) + `state.effectGroups` (`[{id, name, collapsed, effects:[id,…]}]`), persisted to `rstr.effectOrder` / `rstr.effectGroups`. Reconciled on load to be robust to registry churn: stale ids are dropped, effects newly added to the registry (like `glitch`) are appended, nothing already-ordered is ever lost.
14. **Blend-mode picker is a custom brutalist popover (`buildBlendDropdown`), not a native `<select>`** — a native select's option list is browser-owned and fires no hover events on its `<option>`s, so it structurally cannot drive the live-preview-on-hover the feature needed. The popover is a singleton (built once, re-targeted per open, appended to `#panel` so a mix-list rebuild underneath never orphans it while open): 1px-bordered rows grouped the way the old `<optgroup>`s were, hovering a row previews that blend mode on the canvas immediately (`previewBlendRow` → `onPreview`), leaving without clicking / Esc / an outside click reverts to the committed value (`bd.committed`), clicking or Enter commits. Arrow keys move the highlight and re-preview.
15. **Scrubs gained click-to-type, Shift-coarse, and (opt-in) magnetic snap.** Every scrub's value readout is click-to-type by default (`editable: false` opts a specific instance out): click swaps in a real `<input>`, Enter/blur commits a value CLAMPED to `[min,max]` and rounded to the param's own implied decimal precision (0 decimals for `step >= 1`, 1 for `step >= 0.1`, else 2) but never snapped/magnetised — typing is for exact values — Esc cancels, no native `prompt()`. Holding **Shift** while dragging or scrolling the wheel quantizes to 10× the param's `step` on ANY scrub. The new opt-in `snap` option (used only by PRE's CANVAS scrub, `snap: 100`) is MAGNETIC, not rounding: the fill tracks the cursor at full per-pixel `step` resolution so every intermediate value (e.g. 1234) stays reachable, but a value landing within `SCRUB_MAGNET_TOLERANCE` (8 value-units) of a multiple of `snap` sticks to that multiple; Shift, when held, OVERRIDES the magnet with the coarse 10×-step quantize instead (coarse-and-predictable beats "sticks to the wrong spot").
16. **PRE's Scale scrub renamed CANVAS and repointed at `output.scale.mode:'width'`** (was: a %-of-longest-side control writing `none`/`fit`). `setPreCanvasSize(px)` now sets `state.output.scale = {mode:'width', size:px, width:null, height:null}` directly. On a fresh image load the scrub's range is re-derived (`buildPreSection()` reruns): min 100, max `= max(200, round(2×sourceRawWidth/100)*100)`, and dblclick/PRE-RESET both target the source's own native width — so an image opens processed at 1:1 with no surprise resize, and the user can push up to ~2× or down toward 100px. A loaded/pasted style code's own `output.scale` still wins over this default.
17. **Per-effect presets moved into a modal** (out of the cramped pinned footer, which now holds only `EXPORT`); the effect settings panel gained its own RESET; PRE lost its collapse toggle (always expanded now) and its RESET button now also resets CANVAS back to the source's native width (CANVAS lives outside `state.pre`, so it needed its own explicit reset call — `setPreCanvasSize(preCanvasResetValue())` — alongside `state.pre = defaultPre()`).
18. **Global Ctrl+V.** A page-wide `paste` listener (`handleGlobalPaste`) — deliberately the `paste` `ClipboardEvent`, NOT `navigator.clipboard.read()` (permission-blocked on `file://`, which would break the app's whole double-click-to-run premise). Priority: (1) an image file on the clipboard (screenshot, image copied from a browser) loads via the SAME path as drag-drop/the file input; (2) otherwise, text is run through the same parse/apply path `PASTE CODE` uses (`rstr_` id or full style JSON) — success applies it, garbage shows a toast, never a crash. Paste inside any real `<input>`/`<textarea>` (the inline-input widget, a scrub's click-to-type field, the color picker's hex field) is left alone (`isEditableTarget` guard) so normal text pasting still works there.
19. **OUTPUT's scale-mode select now lists `width` too.** Before this, OUTPUT and PRE both read/write the same `state.output.scale`, but the OUTPUT tab's select didn't offer `width` as an option — so after dragging CANVAS, the OUTPUT tab showed "None (source)" while the image was, in fact, already being resized, and touching that select would have silently reset the size the user had just dialed in. `OUTPUT_SCALE_MODES` / `SCALE_MODE_LABELS` now include `width` → `"Canvas width"`.

## Verification (2026-07-12, headless system Chrome + puppeteer UI smokes against `file://index.html`)
- `glitch`: renders identically across repeated runs at fixed params (coordinate-hash determinism, no `Math.random`); `blockNoise: 0` produces one uniform bar per torn slice, `blockNoise: 100` visibly fragments it; wrap-around confirmed at the frame edge (pixels shifted off one side reappear on the other, not clamped).
- CRT: `Scanlines` (`patternType:3`) renders plain horizontal bands obeying `maskStrength`/`falloff`; a preset omitting `patternType` (defaults to Monitor/0) is unaffected by the change; a style code with an explicit `patternType:1` (`TV`) still renders via the retained shader branch even though `TV` no longer appears in the picker.
- Stipple: the grey seam at cell boundaries is gone at every tested `xSquares`/`ySquares` combination; bars now read as full-height rectangles, matching the width-only brightness mapping described in CLAUDE.md.
- `patterns`/`gradients`/`scatter`: rendering each on top of a source with partial alpha (a PNG with a transparent region) now preserves that transparency in the RGBA output instead of forcing it opaque; RGB channels are byte-identical to the pre-fix render on a fully-opaque source.
- CANVAS SIZE: dragging PRE's CANVAS scrub on a 2400px source visibly changes stipple/dot/CRT-mask scale (coarser marks at a lower `width`); reset returns to the source's native width; a pasted style code carrying its own `output.scale` is not overridden by the CANVAS default.
- Blend modes: each of the 20 modes visibly differs from `normal` on a two-layer test mix; `alpha`/`alpha-invert` correctly punch/fill transparency; hovering a row in the popover live-previews without committing, leaving without clicking reverts.
- MASK: `stipple[MASK, invert] → gradientmap` reveals the gradient only through the stipple marks; a trailing mask with no following layer is confirmed inert; two consecutive mask layers confirmed the second (last) one is the one consumed.
- `◇ ORIGINAL`: OFF by default confirmed on a fresh style and on every pre-existing preset load; toggling it ON fills a `crt` mix's transparent corners with the source image; toggling a `stipple[MASK] → gradientmap` mix's ORIGINAL on fills the un-masked holes with the source instead of leaving them transparent.
- Byte-identity: `presets/my-retro.json` (pre-dating opacity/blend/mask/source) still hashes to `rstr_d988923b` after all of the above shipped.
- Editor smokes: three-column layout renders with zero console/page errors; `/Effects` drag-reorder persists across reload; a new group can be created, renamed, and does not accept a nested group; blend popover keyboard nav (arrows + Enter) works; CANVAS scrub's magnet sticks within tolerance and Shift overrides it; global Ctrl+V loads a copied screenshot and, separately, applies a copied `rstr_` id; pasting inside the inline-input widget still pastes normally into the field instead of being hijacked.

---

# 2026-07-13 — posterize merge · riso · warp · glitch chromaShift · LAYERS drag-reorder · Style Library ↔ engine bridge (IMPLEMENTED + VERIFIED)

Written after the fact, same convention as the three sessions above. Catalog 24 → 22 (posterize absorbs `threshold`/`quantize`) → 24 (`riso` + `warp` land).

## Effects (`src/effects.js`)
1. **`threshold` + `quantize` merged into `posterize`**, same move as the 2026-07-11 `dots` merge: a `mode` select (Posterize 0 / Threshold 1 / Quantize 2), one `frag`, three mode bodies (`modePosterize`/`modeThreshold`/`modeQuantize`) moved in **verbatim** from the pre-merge shaders, dispatched by `u_mode`. Why these three specifically: `quantize` computed the exact same `floor(col*levels+0.5)/levels` as `posterize`, just with one extra pre-step (per-fragment hash-noise dither) — a near-duplicate catalog row, not a different idea; `threshold` is genuinely different math (a luma `smoothstep` cut) but the same "reduce tonal levels" family, so it earns the merge on family rather than on formula. `levels` range is the union of the two pre-merge ranges (posterize 2–16, quantize 2–32 → 2–32); `mode` defaults to 0 so a pre-merge `posterize` style code (no `mode` key at all) renders byte-identical. `mono`'s label was changed to "Color mode" for the panel (key unchanged) purely because the new top-level `mode` select is also called "Mode" and two controls both labeled "Mode" in one panel would read as a bug. 9 presets carried over from all three pre-merge effects, renamed per-family (`Poster 3/6/Mono 4`, `Threshold Hard/Soft/High-key`, `Quantize Clean 8/Textured 6/Rough 4`) to avoid name collisions.
2. **NEW `riso`** (HALFTONE) — Risograph print simulation, and the first effect in RSTR that simulates PHYSICAL PRINTING rather than a digital abstraction of it (a strange gap given the tool's dithering/halftone/1-bit lineage). Three mechanisms, all necessary and all present:
   - **Misregistration** (`risoOffset`): a per-ink CONSTANT offset (a hash of the ink index + combined seed, not a per-pixel jitter — jitter would just be extra grain) applied to BOTH the halftone grid's sampling origin and the cell-center source lookup, so an entire ink separation — marks and the content they carry — shifts together as one rigid unit. That's what a real misregistered print pass looks like; a per-pixel jitter would just look like noise.
   - **Spot inks with rotated screens and per-ink tone curves** (`risoInk`): ink 1 at 15°, ink 2 at 75°, ink 3 (when `inkCount:3`) at 45° — the classic print screen angles chosen specifically so the separations' dot grids don't beat into a coarse moiré against each other. `toneBias` narrows each ink's tone curve (0 = full-range key plate, higher = shadow-only accent plate), so 2–3 inks read as genuinely different plates instead of the same halftone recolored three times.
   - **Overprint**: each ink layer is composited as `result = mix(result, result * ink, coverage)` — a translucent multiply over the paper base (`u_paper`), not a source-over stack — so overlapping ink coverage produces a real third mixed colour where two screens' dots land on the same paper region, the way overlapping translucent ink actually behaves.
   - Plus **ink texture**: a bilinear value-noise lattice (`risoValueNoise`, same fbm-lattice shape as `recolor`'s noise) perturbs each ink's mark radius for a coarse blotchy-coverage look, and a separate per-pixel hash (`risoHash`) perturbs mark alpha for fine grain — two different noise frequencies for two different visual jobs, not one noise reused twice.
   - Params: `inkCount` (2/3, select) · `ink1`/`ink2` (color) · `ink3` (color, `showIf inkCount:[3]`) · `paper` (color) · `cellSize` (screen pitch, 3–24 px) · `registration` (misregistration magnitude, 0–12 px) · `inkTexture` (0–1) · `seedOffset` (reroll, deliberately not named `seed` — same `u_seed`-shadowing reason as `glitch`'s `seedOffset`, documented directly in the param comment this time instead of only in CLAUDE.md). Deterministic (`risoHash`/`risoValueNoise`), never `Math.random`, so preview == batch. Ink 1 is the reference pass at zero offset (`off1 = vec2(0.0)`); inks 2/3 drift relative to it, since relative drift between plates is the only thing that reads as "misregistered" — an absolute per-ink jitter with no anchor would be indistinguishable from generic noise. Output is intentionally colored — like `recolor`/`gradientmap`, the editor chrome stays grayscale but the effect's own pixels don't have to.
3. **NEW `warp`** (DISTORT) — the geometric-remap family that `distort`/`displace` used to cover before their 2026-07-10 removal (they were thin one-slider effects), rebuilt the `dots`/`posterize` way: ONE dense effect, mode = **Swirl(0) / Pinch-Bulge(1) / Ripple(2) / Reeded Glass(3) / Polar↔Rectangular(4)**, one `frag`, five UV-remap-then-sample bodies behind `u_mode`, params gated by `showIf`.
   - **Shared `amount`** (−100..100, default 0) is the ONE intensity dial across all five modes — each mode maps it to its own units internally, and every mode is a verified no-op (bit-exact identity, max_diff 0) at `amount:0`. Sign is meaningful everywhere it can be: Swirl → rotation radians (sign = spin direction); Pinch-Bulge → the sign IS the mode (positive bulges/magnifies the center, negative pinches/sucks content toward a point — the classic vortex-collapse look, one shared power-curve formula `e = 1 + amt`, `rn = pow(r, e)` covering both); Ripple → wave amplitude in px (sign flips phase); Reeded Glass → lens strength (sign flips convex vs concave ribs); Polar has no natural opposite sign, so `amount` is repurposed there as a clamped 0..1 blend dial between the untouched image and the fully polar-transformed one (negative reads as 0).
   - **Shared `centerX`/`centerY`** (modes 0,1,2,4) and **`radius`** (modes 0,1,2) — Reeded Glass excludes both because it's a ribbed pattern tiling the whole frame, not a disc around a point.
   - **Swirl**: rotation strongest at center, falling off QUADRATICALLY (`fall*fall`) to zero at `radius` — zero angle AND zero angular gradient at the boundary, so no seam.
   - **Pinch-Bulge**: samples at `r^e * radius` along the pixel's own angle (angle never touches) — `e>1` pulls the sample closer to center than the pixel itself sits (far pixels show once-central content = magnify), `e<1` pushes the sample outward (near-center pixels show once-peripheral content = pinch/vortex-suck). Stable at dead center by construction (direction is `d/dist`, radius scales to 0 as `dist→0`, so it's `0 * anything`, never `0/0`).
   - **Ripple**: a concentric sine in radial distance, displaced along the RADIAL direction (concentric rings pushing in/out, not a directional wobble), same linear `fall`-to-the-radius-edge as Swirl so it dies out smoothly instead of stopping at a visible ring.
   - **Reeded Glass** (`warpReeded`) — deliberately **NOT a sine wave**, because real reeded glass isn't one: it's modeled as a row of plano-convex CYLINDRICAL lenses, each rib's front surface a circular arc with sag `h(nx) = sqrt(1-nx²)` across the rib (`nx` = normalized position within one rib, −1..1). A thin lens bends a ray sideways proportional to the LOCAL SLOPE of that arc, `dh/dnx = -nx/sqrt(1-nx²)` — exactly zero at the rib's crown (`nx=0`, near-undistorted) and diverging toward the seam (`nx→±1`). That's the actual physical reason real fluted glass reads clear down each rib's center and smears/doubles right at the seams; a plain `sin(nx)` has a bounded, roughly-linear-through-the-middle slope and would produce a uniform gentle wobble instead — the wrong shape entirely. `nxc` clamps just short of ±1 (a real lens seam is a hard discontinuity; this keeps the slope merely steep, not infinite/NaN). `ribAngle` rotates the whole rib grid so flutes can run off-vertical.
   - **Polar↔Rectangular** (`warpPolar`): "To Polar" reads this OUTPUT pixel's own angle/radius around the center to pick a column/row of the SOURCE, wrapping the rectangular source into a disc. "To Rectangular" is the literal inverse — this output pixel's plain (x,y) is read AS (angle,radius) to locate a source point in cartesian space, unwrapping a disc-like arrangement into a strip. Both share `maxRadiusPx` (half the frame diagonal) as the radius that maps to the source's full 0..1 span.
   - **Edge behavior, a real per-mode decision, not a leftover default**: Swirl/Pinch-Bulge/Ripple/Polar all remap a pixel's on-screen position through a lens-like formula (rotate around a center, scale radially, reproject through polar coordinates). Bulge/Ripple-within-radius/Swirl mathematically can never leave the source rectangle (rotation preserves distance from an in-bounds center; the frame's convexity means any point on the center→pixel segment stays inside), but Pinch (sampling up to `radius` px away from a near-edge center) and Polar (remapping edge/corner content around a full circle) both CAN sample outside the source — when any of the four modes does, the shader renders a TRANSPARENT ALPHA VOID, the same call `crt` already made for its barrel-lens distortion: these are optical remaps of a BOUNDED disc, not a repeating or tearing pattern, so "there's no image there" is the honest answer, not a lie told by clamping or wrapping. Reeded Glass is the one mode that CLAMPS instead — it's a bounded, sub-rib-width displacement, not a lens over a disc, and real fluted glass keeps being glass right up to the pane's edge. Neither family wraps — that's `glitch`'s choice alone, because `glitch` is simulating a signal TEAR (where wrap-around is the real-world artifact) and a lens has an edge where a tape glitch doesn't.
   - Determinism: every mode is a pure closed-form remap of `v_uv`/`u_resolution`/params — no hash, no `u_seed`, no `Math.random` anywhere in `warp`.
   - Perspective/Transform/Elastic-grid warps were deliberately NOT added — the goal was keeping `warp` dense (few controls, wide range of looks), not turning it into a dumping ground for every possible UV remap.
4. **`glitch` gained `chromaShift`** (0–100, default 0) — a per-slice chroma split. `glitch` originally shipped reasoning "no RGB split needed, `aberration` already owns that, just stack the two" — that reasoning was wrong: stacking `glitch → aberration` gives a UNIFORM channel offset across the WHOLE frame regardless of which rows tore, but a real broadcast/tape glitch splits color only INSIDE the torn slices, proportional to each slice's OWN displacement, and leaves untorn rows perfectly clean; no combination of a per-slice effect and a whole-frame effect reproduces that at any settings. Fix: `chromaShift` is a PERCENTAGE OF THE SLICE'S OWN `shiftPx` (not an absolute px value — an absolute offset would be invisible on subtle tears and excessive on huge ones, while a percentage stays proportional across every `maxShift` setting and is exactly zero whenever the slice itself is zero-shifted). R samples at `uv.x + shiftPx·chromaShift/100`, B at `uv.x − shiftPx·chromaShift/100` (same +R/−B convention as `aberration`; G stays put), both wrapped with `mod` exactly like the tear itself, so the fringe direction flips with the tear direction. Untorn slices never enter this code path at all, so they carry zero fringe by construction rather than by clamping to zero. When `blockNoise` subdivides a slice into jittered blocks, each block's own jitter is already folded into `shiftPx` before the chroma offset is derived from it, so per-block chroma variation falls out naturally with no separate mechanism. Default 0 renders three identical-coordinate `texture()` fetches (R==G==B sample point), so pre-2026-07-13 `glitch` style codes render byte-identically. This supersedes the effect's original registry comment ("deliberately does NOT split RGB") — updated in place rather than left to contradict the shipped param.

## Migration (`src/preset.js`)
5. **`LEGACY_EFFECTS` gains two entries**: `threshold → {effect:'posterize', params:{mode:1}}`, `quantize → {effect:'posterize', params:{mode:2}}`, applied by the existing `migrateLegacyEffects()` in `validatePreset`, same mechanism as the `dots` family's `edge`/`dotpattern` entries. A migrated mix gets a new `rstr_` id, same accepted cost as every prior legacy migration — the hash covers the mix contents and the layer's `effect` id genuinely changed.

## Editor UI (`src/ui.js`)
6. **LAYERS rows drag-to-reorder**, same idiom as the existing `/Effects` drag-to-reorder: native HTML5 DnD, no library, a 1px insertion line (`.drop-before`/`.drop-after`) tracking the hover position. Unlike an `.effect-row` (a plain text button with nothing else to hijack), a mix row carries several of its OWN interactive children — the eye toggle, `✕`, MASK/INV, the blend-mode popover trigger, and the opacity scrub (itself a click-and-drag control) — so making the whole row `draggable` would swallow pointer gestures meant for those children. Fix: only a dedicated grip handle (`.mix-drag-handle`, a six-dot inline SVG using `currentColor` so it stays crisp and grayscale regardless of what the system monospace stack covers) is the drag SOURCE; `dragover`/`drop` stay on the row itself (and on the two pinned rows) so hovering anywhere over a row still tracks the insertion point. `moveLayerTo(from, to)` reorders `state.mix` and re-locates the currently-EDITed layer by OBJECT IDENTITY (not index) afterward, so a reorder never silently re-targets EDIT onto a different layer that happened to land at the old index. The old ↑/↓ reorder buttons are REMOVED entirely (drag replaces them, not supplements them). `◇ OUTPUT` and `◇ ORIGINAL` stay pinned — not draggable, not displaceable — but remain valid drop targets right at their boundary (a dragged layer can land as the new first/last layer); a `.mix-drag-spacer` on each pinned row keeps its eye-icon column visually aligned with draggable rows' handle column.
7. **Per-layer enable checkbox replaced by an eye toggle** (`makeEyeToggle`/`eyeIconSVG`) — open eye = visible, eye+slash = hidden. Purely a rendering change: the underlying boolean (`layer.enabled`, `state.outputEnabled`, `state.source.enabled`) is unchanged, so there is no schema/serialization impact at all. Motivation was visual consistency, not new capability — a native `<input type="checkbox">` carries unthemeable browser chrome (an accent color, a rounded box) that doesn't fit the grayscale-brutalist rule the rest of the panel follows; the eye icon is inline SVG (`stroke="currentColor"`) so it inherits the same grayscale treatment as every other icon button. `◇ OUTPUT` and `◇ ORIGINAL` use the identical control.

## Style Library ↔ engine bridge (`src/ui.js`, `engine/rstr.js`)
8. **The Style Library only ever lived in the browser's `localStorage`** — invisible to `engine/rstr.js` (which reads `presets/*.json` from disk) and gone forever on a cache clear, since it was the ONLY copy. Two independent fixes, because they're two independent failure modes:
   - **`→ Presets`** writes the currently-selected library style out as one engine-ready `presets/<slug>.json` (`exportStyleToPresets`) — reusing the library entry's already-`finalizePreset()`-produced shape verbatim, never a second serializer. **File System Access** (`showDirectoryPicker`) is the happy path: `file://` IS a secure context and the picker works there (contrary to the assumption that only `https://` gets modern file APIs); the chosen directory handle is persisted in **IndexedDB** (`rstr-fs` / store `handles`, key `presetsDir` — `localStorage` can't hold a `FileSystemHandle`, only IndexedDB can), so every later export writes straight to `presets/` with zero dialog, re-requesting permission only if it was revoked. Falls back to a plain `<a download>` (same JSON either way) when the picker API is missing, throws, or permission is denied outright.
   - **`Export all` / `Import`** round-trip the WHOLE library as one JSON file (`exportAllStyles`/`importLibraryFile`) — a real backup/restore, not just a per-style bridge, since `localStorage` clearing (browser reset, profile wipe, "clear site data") was the single point of failure for the entire library. Import merges into the existing library through the SAME save/validate path normal saves use (never a second serializer): a name collision with an IDENTICAL style (same `rstr_` id) is left alone; a DIFFERENT style under the same name is imported under a disambiguated `"name (2)"` rather than silently overwriting a save.
9. **Engine `--preset` now also accepts a bare name WITH the `.json` extension** (`resolvePreset` in `engine/rstr.js`): since `→ Presets` writes real `.json` files into `presets/`, typing `--preset my-style.json` is the natural thing to do after seeing that filename in the folder, and it used to fail both the direct-path check and the bare-name check (which expected the extension stripped). `resolvePreset` now strips a trailing `.json` before resolving against `presets/` if the direct path didn't already match, so both `--preset my-style` and `--preset my-style.json` resolve identically; the bare-`rstr_`-id-scan fallback (loop every `presets/*.json`, compare `json.id`) is unchanged.

## Verification (2026-07-13, headless system Chrome + puppeteer UI smokes against `file://index.html`)
- Byte-identity regression proof for the `posterize` merge: a preset with `posterize` and no `mode` key renders identical to the explicit `mode:0` pre-merge shader; migrated `threshold → posterize{mode:1}` and `quantize → posterize{mode:2}` render identical to their pre-merge originals at matching params.
- `riso`: `registration:0` shows all inks in perfect alignment (single clean composite); raising `registration` visibly shifts each ink's marks AND its underlying content sample as one rigid unit (not a blur); `inkCount:3` shows a visibly distinct third plate at 45° from the other two; a fully opaque source with `inkTexture:0` still shows blotchy density at `inkTexture:1`.
- `warp`: every mode confirmed bit-exact identity (max_diff 0) at `amount:0`; Swirl/Pinch-Bulge/Ripple/Polar sampling outside the source reads exactly `(0,0,0,0)`; Reeded Glass at the frame edge instead reads a clamped (non-transparent) edge pixel; Pinch (negative amount) visibly sucks content toward center, Bulge (positive) visibly magnifies it, at the same `|amount|`.
- `glitch chromaShift`: untorn rows byte-identical to `chromaShift:0` at any `chromaShift` value (confirms the "untorn rows never enter this code path" claim); a torn slice at `chromaShift:100` shows visible R/B fringing scaled to that slice's own `shiftPx`, absent entirely at `chromaShift:0`; a preset predating this param renders byte-identical to one with `chromaShift:0` explicit.
- LAYERS drag-reorder: dragging the grip handle reorders `state.mix` and updates the rendered stack; dragging the opacity scrub or clicking MASK/blend/eye on a row does NOT start a drag (grip-only drag source confirmed); the currently-EDITed layer stays selected (by identity) after a reorder that changes its index; `◇ OUTPUT`/`◇ ORIGINAL` refuse to become drag sources but accept a drop at their boundary.
- Eye toggle: visually indistinguishable in behavior from the old checkbox (same `enabled` flag, same persistence through save/load); toggling `◇ OUTPUT`'s eye disables crop/scale exactly as the old checkbox did; toggling `◇ ORIGINAL`'s eye is equivalent to the old enable flag.
- Style Library bridge: `→ Presets` on a fresh profile (no persisted directory handle) prompts `showDirectoryPicker` once, then writes silently on every subsequent export in the same session; the written `presets/<slug>.json` round-trips through the ENGINE (`node rstr.js --preset <slug>.json ...`) and renders identically to the same style applied live in the editor; `Export all` → clear `localStorage` → `Import` restores every saved style; importing a library containing a style with a name already in use but a different `rstr_` id lands as `"name (2)"`, not an overwrite.
- Byte-identity: `presets/my-retro.json` (pre-dating this entire session's changes) still hashes to `rstr_d988923b`.
- Editor smokes: zero console/page errors throughout; `posterize`'s panel correctly hides Threshold/Quantize-only params in Posterize mode and vice versa; `riso`'s Ink 3 color control appears only at `inkCount:3`; `warp`'s Center/Radius controls hide correctly for Reeded Glass; `glitch`'s new Chroma Shift scrub sits after Block Noise in panel order.

---

# 2026-07-13 revision — `warp` deleted, `riso` merged into `halftone`, LAYERS drag now whole-row, scrub top-quarter bug fixed, `/Styles` panel trimmed (IMPLEMENTED + VERIFIED)

Written later the SAME day as the section immediately above (`# 2026-07-13 — posterize merge · riso · warp · ...`). This entry does not rewrite that history — `riso` and `warp` genuinely shipped, were used, and are genuinely gone now. Two of that section's five headline items (`riso`, `warp`) are reversed here on user feedback; the other three (`posterize` merge, `glitch`'s `chromaShift`, the Style Library↔engine bridge) stand unchanged. This section also folds in three smaller same-day fixes that never got their own entry.

## `warp` — DELETED
User feedback: he didn't want it. Removed from `src/effects.js` entirely (Swirl/Pinch-Bulge/Ripple/Reeded Glass/Polar↔Rectangular, item 3 of the section above).

The GENERAL insight behind `warp`'s now-deleted per-mode edge-behavior reasoning still holds and lives on in the two effects that actually ship an edge policy: `crt`'s tube-curvature distortion renders a transparent alpha void outside its bounded lens-disc (an optical remap of a disc has no data past its edge — clamping or wrapping would misrepresent that); `glitch`'s slice tear instead wraps (`mod`) because a signal tear is a genuinely repeating artifact, not a bounded lens. The precedent worth keeping: RSTR picks void vs. clamp vs. wrap per effect, deliberately, based on what the effect is physically simulating — never one global default. `warp`'s specific five-mode reasoning (Reeded Glass edge-clamping because real fluted glass stays glass to the pane's edge, Swirl/Pinch/Ripple/Polar voiding because they're optical remaps of a bounded disc) is retired along with the effect itself.

**Backlog correction**: the section above's Backlog note — "the intended replacement for the bundled displacement map in `assets.js` is a layer-driven Displace mode inside `warp`" — is now wrong, since there is no `warp` to add a mode to. Restated honestly: the displacement map stays an unused bundled asset with NO assumed replacement mechanism; if a distort-class effect is ever proposed again, it stands on its own merits, not as a preordained `warp` mode.

**Also**: the effect.app port backlog (blur family, NTSC/dot-crawl, ink bleed, paper scan, curves/color-matrix/vignette into `adjust`) still stands, but geometric distortion is explicitly excluded from it — the user rejected `warp`, so nobody should rebuild swirl/pinch/ripple/polar as a port target.

## `riso` — MERGED into `halftone` as a `mode`
User feedback: riso "should live in halftone" — and by RSTR's OWN rule, written earlier this same session ("Merge by shared MECHANISM, not shared THEME"), he was right. `halftone` is a rotated dot screen: cell-centre luminance → mark size/shape, sampled through one rotated grid. `riso` is the IDENTICAL rotated-dot-screen mechanism, just run 2–3 times at different fixed angles, each pass carrying a per-ink constant offset, composited as translucent overprint over a paper base. Same mechanism (grid-sampling + luminance→mark), different parameterization and a compositing step on top — a `mode`, not a second catalog row. The rule was written, then immediately violated by shipping `riso` standalone in the very same session (see the section above); the user caught the violation before it calcified as precedent. Worth recording plainly: writing a rule doesn't apply it to the thing you just shipped automatically — it has to be re-checked against recent decisions too, not just the next proposal.

`halftone` (`src/effects.js`) now carries:
- **`mode`**: **Mono** (0 — the original single-screen halftone, unchanged) / **Riso** (1). `default: 0` is load-bearing: every pre-existing `halftone` style code (no `mode` key at all) renders byte-identical to before the merge — verified via SHA-256 match against the pre-merge render.
- **`cellSize` is SHARED** between Mono and Riso — both already read the identical screen-pitch key/uniform before the merge, so this is a straight reuse, not a new decision.
- **Riso-only params**: `inkCount` (2/3) · `ink1`/`ink2`/`ink3` (color) · `paper` (color) · `registration` (misregistration magnitude, 0–12) · `inkTexture` (0–1) · `seedOffset` (reroll). Riso's three screen angles (15°/75°/45° — the classic print angles chosen to keep separations' dot grids from beating into moiré against each other) stay INTERNAL constants, never exposed as a param.
- **`angle`** (Mono's own screen-rotation param) is gated `showIf mode:[0]` — Riso doesn't expose it, since its angles are fixed internally per ink.
- **`ink3` is gated on `mode:[1]`, not on `inkCount:[3]`** — flagged as a real mechanism limitation, not an oversight: `showIf` (`src/ui.js`) only supports ONE controller key (`{ key, in: [...] }`, no AND-composition), so a param can't be conditioned on "mode is Riso AND inkCount is 3" simultaneously. Gating on the coarser `mode` means Ink 3's color swatch is visible whenever `inkCount` is 2 as well (harmlessly unused there) — accepted rather than extending `showIf` to multi-key gates for one param.
- Mechanism carried over unchanged from the deleted standalone effect: **misregistration** is a per-ink CONSTANT hash-derived offset (not per-pixel jitter) applied to BOTH the halftone grid's sampling origin and the source-color sample coordinate, so a whole ink separation — marks and the content they carry — shifts together as one rigid unit, the way a real misregistered print pass looks, not a blur. **Overprint**: each ink composites as a translucent multiply over the `paper` base, so overlapping screens produce a genuine third mixed colour rather than a flat recolor. Ink texture (blotchy value-noise coverage + fine per-pixel grain) unchanged.
- `LEGACY_EFFECTS` (`src/preset.js`) gained `riso: { effect: 'halftone', params: { mode: 1 } }`, applied by the existing `migrateLegacyEffects()` in `validatePreset` — a style code carrying the old standalone `riso` effect id migrates automatically, same mechanism as every prior rename (`edge`, `dotpattern`, `threshold`, `quantize`). A migrated mix gets a new `rstr_` id (the hash covers the mix contents), same accepted cost as every migration before it.
- `presets/riso-pink-blue.json` was regenerated against the merged shape (`effect: "halftone"`, `params.mode: 1`); its id changed to **`rstr_6dd26753`** — expected, since the id hashes the mix.

## Catalog: 24 → 22
`adjust, levels, invert, halftone, dither, stipple, dots, patterns, gradients, crosshatch, ascii, posterize, gradientmap, recolor, pixelate, scatter, glitch, aberration, crt, bevel, cellular, bloom`. (`warp` deleted outright; `riso` folded into `halftone` as a mode rather than its own row — net two fewer catalog entries than the section above's "24" snapshot.)

## LAYERS drag — whole row is the source, grip handle removed (`src/ui.js`)
The dedicated `.mix-drag-handle` grip described in the section above is REMOVED. The whole `.mix-item` row is now `draggable = true`, same idiom as an `.effect-row` in `/Effects`. What makes that safe despite a mix row carrying several of its OWN pointer-drag children (opacity scrub, eye toggle, MASK/INV, blend-mode trigger): a capture-phase `pointerdown` listener, `wireMixRowDragToggle(row)`, recomputes `row.draggable = !e.target.closest(MIX_ROW_INTERACTIVE_SELECTOR)` on EVERY press, before the browser's native drag-start decision fires — `MIX_ROW_INTERACTIVE_SELECTOR = '.scrub, .icon-btn, .mix-blend'` is the single list of "this child owns its own gesture" selectors. A press starting on any of those flips the row briefly non-draggable so no row-drag begins from that gesture; a press starting on the row's label/background leaves it draggable and drags normally. `moveLayerTo` still tracks the currently-EDITed layer by object identity across a reorder, unchanged from the grip-handle version. Net effect: simpler (no dedicated handle element, no visual real estate spent on it) at the cost of one shared selector list that must stay in sync with whatever interactive children a mix row grows next.

## Scrub bug fix — top quarter of every range was unreachable by drag (`src/ui.js`, `makeScrub`)
Since click-to-type became the scrub default (v2.0), `.scrub-value` (the value readout, occupying the rightmost ~25% of the bar) called `stopPropagation()` on its own `pointerdown` so the bar's drag handler behind it never saw the event — meaning a drag gesture starting anywhere in that rightmost quarter silently did nothing except open the type-in editor on release; the value itself was unreachable by dragging in that zone. Fixed: `.scrub-value` no longer owns its own pointerdown handler; a pointerdown ANYWHERE on the bar (readout included) now arms a normal drag via pointer capture, same as the rest of the bar. The one special case: when the press started ON the readout, the first value commit is held back until the pointer moves past a 3px tolerance (`CLICK_TOLERANCE`) — so a plain click doesn't nudge the value out from under the user before `pointerup` decides "that never moved, it was a click" and opens the editor (this also keeps Esc-to-cancel meaningful — it cancels onto the value the control still had, not one that already jumped). The instant real movement crosses that tolerance it graduates into an ordinary drag, same position-to-value mapping as anywhere else on the bar.

## `/Styles` panel trimmed (`src/ui.js`)
`PASTE CODE` (a dedicated always-visible button) is REMOVED — the global Ctrl+V handler (`handleGlobalPaste`) already runs clipboard text through the identical `parseStyleCode`/`applyStyle` path from anywhere on the page, making a second button for the same action redundant. `Export all` / `Import` (whole-library backup/restore) are now collapsed behind a `▸/▾ Backup` disclosure toggle (`toggleBackupRow`) — the same collapsed/expanded glyph convention already used by `/Effects` group headers — since a whole-library backup is needed once in a blue moon, not every session, and was occupying two permanent rows in a ~170px column. The panel now reads, top to bottom: pick a style → Save/Del → Copy code (clipboard) / `→ Presets` (disk) → (rarely, behind `Backup`) Export all/Import → Reset.

Worth recording the conceptual point that actually drove the trim: **a style code IS the JSON** — `Copy code` and `→ Presets` are the SAME data going to two different destinations (clipboard vs. disk), not two different formats or two separate features, which is why collapsing only the disk-facing whole-library pair behind one disclosure (rather than inventing a second "export mode") was the right cut. The `rstr_` id, by contrast, is a REFERENCE — a hash of that data, not the data itself — and only resolves if the JSON it names exists somewhere (a `presets/*.json` file for the engine, a library entry for the editor).

## Verification (headless system Chrome + puppeteer UI smokes against `file://index.html`)
- Byte-identity: a pre-merge `halftone` style code (no `mode` key) renders identical (SHA-256 match) to the same code with `mode:0` made explicit.
- A style code carrying the old standalone `riso` effect id migrates via `LEGACY_EFFECTS` to `halftone{mode:1}` and renders identically to its pre-migration standalone-`riso` render at matching params.
- `presets/riso-pink-blue.json` regenerated; new id `rstr_6dd26753` confirmed against the merged shape.
- `warp` confirmed absent from the registry, the `/Effects` list, and `LEGACY_EFFECTS`; a style code referencing `warp` now drops that layer via `validatePreset`'s unknown-effect path (console warning, not a crash) — same handling every other removed effect already gets.
- LAYERS: dragging a row by its label/background starts a reorder and updates the rendered stack; dragging the opacity scrub or clicking eye/MASK/INV/the blend trigger does NOT start a drag (confirms `wireMixRowDragToggle`'s per-press recompute); the currently-EDITed layer stays selected (by identity) after a reorder that changes its index; `◇ OUTPUT`/`◇ ORIGINAL` still refuse to become drag sources but accept a drop at their boundary.
- Scrub: a pointerdown-and-drag starting inside the readout's hit area now moves the value across the FULL range, including the top quarter that was previously dead; a plain click there (released within 3px of the down-point) still opens the type-in editor instead of nudging the value; Esc while editing still cancels onto the pre-edit value.
- `/Styles`: `PASTE CODE` absent from the DOM; Ctrl+V with a style code on the clipboard still applies it from anywhere on the page (unaffected by the button's removal); the `Backup` toggle correctly shows/hides Export all/Import; zero console/page errors throughout.

# 2026-07-13, later still — `recolor` merged into `gradientmap`, `invert` folded into `adjust`, canvas-viewport 1:1 snap (IMPLEMENTED + VERIFIED)

Third dated entry for this same calendar day (after `# 2026-07-13 — posterize merge · riso · warp · ...` and `# 2026-07-13 revision — warp deleted · riso merged · ...`). Two more catalog merges plus one UI behavior change, all verified in the same session.

## Effects (`src/effects.js`)

1. **`gradientmap` absorbs `recolor` outright** — NOT a `mode`-select merge like `dots`/`posterize`/`halftone`. `gradientmap` was a CPU stage: a 256-entry LUT built from a variable-length `stops` array, indexed by luminance. `recolor` was a GPU `frag`: 3 hardcoded stops plus `map` (Brightness/Hue/Saturation), `posterizeSteps`, noise (intensity/scale/gamma), `repetitions`. The registry's `frag`/`cpu` are mutually exclusive, so a `u_mode` branch inside one shader (the trick that merged the dot family, the posterize family, and riso/halftone) was structurally impossible here — the two engines can't coexist in one registry entry. One had to win outright. GPU won: recolor's shader already did the real per-pixel gradient-sample work with room for the extras; the CPU LUT could not absorb `posterizeSteps`/noise/`repetitions` without becoming a second per-pixel CPU loop duplicating what the GPU already does for free.
2. **New pipeline mechanism — `type: 'stops'` params upload as three uniforms**, not one. A variable-length `stops` array can't be a single `u_<key>` uniform, so `src/pipeline.js`'s `_draw()` gained `uploadStopsUniform()`: sorts the array ascending by `pos` (JS side, once per draw call — same sort `buildGradientLut` already did for the editor's LUT preview), truncates anything past 8 stops with a `console.warn` (never a crash), and uploads `u_stopPos[8]` / `u_stopColor[8]` / `u_stopCount` on any program that declares them (a no-op on every other effect's program). `type: 'stops'` was previously documented project-wide as "cpu-only, never a uniform" — that was only ever true because `gradientmap` was its sole user and was CPU-only itself; it no longer holds.
3. **`gradientmap`'s new shader**: `sampleGradient()` is an N-stop generalization of recolor's old hardcoded 3-stop piecewise `mix()` — for N=3 it is bit-for-bit the same math recolor's shader always ran. `map` (the luminance/hue/saturation source) gained a 4th option, **Luminance** (value 3) — see the bug below for why it's the default. `posterizeSteps`/noise (`noiseIntensity`/`noiseScale`/`noiseGamma`)/`repetitions` are recolor's own params, absorbed with recolor's own identity defaults (255/0/0.3/1/1) so a gradientmap code that never touches them runs noise → posterize → repeat as no-ops.
4. **A real bug, found and fixed mid-merge**: the first cut defaulted `map` to recolor's own 0 (Brightness — an unweighted `(r+g+b)/3` blended toward white by alpha). But the old CPU `gradientmap` always indexed its LUT by WEIGHTED luminance (`0.299r + 0.587g + 0.114b`) — a different formula, not rounding noise. Rendered against the same old `gradientmap` codes: **max channel diff 113/255, mean 16** — caught before it shipped. Fix: added `map: 3` (Luminance, the weighted formula) as gradientmap's DEFAULT, so a bare pre-merge `gradientmap` code (which carries no `map` key at all) falls through to the formula it always had. Because that moved the default out from under recolor's own default (0, Brightness), `LEGACY_EFFECTS.recolor`'s `transform()` (see Migration below) now explicitly injects `map: 0` whenever a migrated recolor code omits the key.
5. **The residual difference, understood and accepted**: after the fix, old `gradientmap` codes are NOT fully byte-identical — **max 3/255, mean 0.07–0.39**. Root cause is NOT the map formula; it's `posterizeSteps`. Recolor's default is 255 and its formula is `floor(v·steps)/(steps−1)` — divides by 254, not 255 — a deliberate faithful port of tooooools' original, load-bearing for recolor's OWN byte-identity. The old CPU `gradientmap` had no posterize step at all, so it never ran into this; now every `map` mode runs through the same shared shader and inherits it. Removing the off-by-one would regress `recolor`. 3/255 at mean 0.1 is invisible; accepted as the one deliberate exception (see Decisions in `CLAUDE.md`).
6. **`invert` folded into `adjust`**, same precedent as 2026-07-10's hue/sharpen absorption. `amount`/`channels` become `invert`/`invertChannels` (same 0–1 / 0–3 encodings). Placed **last in the chain, after gamma** (sharpen → hue → tone → invert) — the old standalone `invert` was always a trailing layer, so inverting the fully tone-adjusted result is the closest two-layer equivalent to "adjust, then invert." Default `invert: 0` = identity, so every pre-existing `adjust` code (no invert keys) renders byte-identical.
7. `recolor` and `invert` are both DELETED from the registry.

## Migration (`src/preset.js`)

- `LEGACY_EFFECTS` gained a **`transform(params)` hook** — until now every entry was a `{ effect, params }` shape (old keys survive untouched, only a `mode` key gets spread on top — every mode-select merge to date). `recolor → gradientmap` and `invert → adjust` are the first two that need actual reshaping, not a key union: recolor's fixed `stop1/pos1 … stop3/pos3` (`pos` 0–100) become gradientmap's `stops: [{pos (0–1), color}]` array; invert's `amount`/`channels` become adjust's `invert`/`invertChannels`. `transform(oldParams)` returns the FULL new params object; a legacy entry has exactly one of `params` or `transform`, never both.
- `recolor`'s transform also explicitly sets `out.map = params.map ?? 0` (see the bug above) rather than letting it fall through to gradientmap's new default of 3.
- Existing shape-only entries (`edge`, `dotpattern`, `threshold`, `quantize`, `riso`) are unchanged.

## Editor (`src/ui.js`)

- **Canvas-viewport behavior changed on user request.** A CANVAS-size change (dragging PRE's Canvas scrub) used to *compensate zoom* to hold the on-screen image size constant while the backing store resized underneath it. It now instead **snaps the view to 100%** — the on-screen image shrinks/grows along with the working buffer. Rationale: at 1:1 the effect's marks hold their true pixel size while the picture scales around them, which shows the effect coarsening/refining relative to the content instead of just holding the on-screen size steady. Fit-on-load behavior (`refitView()`, capped at 100% so a small source opens 1:1) is unchanged — only the SAME-image backing-store-resize path changed. Verified: buffer 256→172 (dragging Canvas down), on-screen 172px, zoom reads 100%.

## Verification (2026-07-13, headless system Chrome + puppeteer UI smokes against `file://index.html`)

- `adjust` (no invert keys) → byte-identical to pre-merge.
- `invert` (migrated, amount=1/RGB) → byte-identical to pre-merge standalone `invert`.
- `recolor` (migrated via `LEGACY_EFFECTS`) → byte-identical to pre-merge standalone `recolor`.
- `gradientmap` (pre-merge codes, no `map` key) → NOT byte-identical: max 3/255, mean 0.07–0.39 — the one accepted exception, see above. (Before the `map` default fix: max 113/255, mean 16 — rejected, fixed before shipping.)
- `presets/my-retro.json` (uses none of `recolor`/`gradientmap`/`invert`) keeps its id, `rstr_d988923b`, unchanged.
- Canvas-viewport: buffer 256→172 on a CANVAS drag on the SAME image → on-screen 172px, zoom 100% (previously would have held on-screen size constant via zoom compensation).

## Catalog: 22 → 20

`adjust, levels, halftone, dither, stipple, dots, patterns, gradients, crosshatch, ascii, posterize, gradientmap, pixelate, scatter, glitch, aberration, crt, bevel, cellular, bloom`. (`recolor` absorbed into `gradientmap`; `invert` absorbed into `adjust` — two fewer catalog rows, no new ones.)
