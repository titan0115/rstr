# RSTR

A local shader-based image-effects tool with two heads sharing one shader pipeline and one preset ("style code") format:

- **Editor** (`index.html`) — load an image, click through effects to preview them live, stack them into a mix, export a PNG or a style code.
- **Engine** (`engine/rstr.js`) — a Node CLI that applies a saved style to a whole folder of images in batch, using headless system Chrome.

Shader code lives once, in `src/`. Both heads load the same files — the engine never re-implements an effect. The `src/*.js` files are **classic scripts** on a global `window.RSTR` namespace (no ES modules, no bundler), so the editor opens by double-click over `file://` and also works when hosted on any static host.

## Repo layout
```
index.html            editor entry — double-click to open
src/
  gl.js                WebGL2 helpers (compile, fullscreen quad, textures, ping-pong FBOs)
  effects.js            EFFECTS registry: id -> { name, params, built-in presets, and a frag shader OR a cpu stage }
  pipeline.js           OUTPUT (crop/scale) + runs an ordered effect stack (shader or CPU passes) + encodes to format@quality
  preset.js             style (de)serialize + deterministic id + per-effect & disabled-effect stores (localStorage)
  ui.js                 boots the editor and implements the interaction model
engine/
  render.html            headless page: loads src/*, exposes window.RSTR.render(dataURL, preset)
  rstr.js                CLI: puppeteer-core + installed Chrome, batch-applies a style to a folder
  package.json
presets/                 saved style codes (*.json)
test-assets/             sample PNGs for self-testing (synthesized, see scripts/gen-test-assets.mjs)
scripts/
  gen-test-assets.mjs    regenerates test-assets/ (no dependencies, no network)
```

The UI is pure-grayscale brutalism (monospace, square corners, 1px hairlines, no hue — active/selected is inverted, not colored). The only colors on screen are the loaded image and any `color`-type effect params (e.g. Duotone swatches).

## 1. Editor

**Launch: double-click `index.html`.** It opens directly in your browser over `file://` — no server, no build step. (The same folder is also directly hostable as a static site.)

### Layout
- **Left = controls, right = canvas.**
- Left panel, top to bottom: the **mix stack**, the flat **effect list**, the **PRE module**, the **edit panel** (scrollable) — then a **pinned footer** (per-effect preset `Save`/`Del` + `Add to mix`, always visible), the collapsible **Styles bar**, and the **global bar** (`Export` · `Reset` · `▤`).
- **Global bar** — `Export` (PNG/webp/jpeg of the current look) · `Reset` · `▤` (toggles the Styles bar).
- **Styles bar** (collapsed by default, opened by `▤`) — the named **Style Library** (whole styles = layers + output, distinct from per-effect presets): a dropdown of saved styles (select to load), `Save` (name the current style — inline, stored in `localStorage` `rstr.styleLibrary`, with overwrite confirm), `Del`, `Copy code` (copy the style JSON to the clipboard), and `Paste code` (import a style — see below).
- **Canvas overlays** — `✕ New image` top-left, the **`⚙` Settings gear top-right**, zoom controls bottom-left.

**Effect list** — the full catalog (25 effects) as a single flat list (includes ASCII and a clean Floyd–Steinberg dither). Clicking an effect enters **NEW mode**: it's previewed on the canvas on top of the committed mix, so you can rapidly click down the list to compare looks.

**Range controls are scrub bars** — a full-width bar per param (label left, value right, fill = position): click or drag anywhere to set the value, mouse-wheel = ±1 step, double-click = reset to default.

**PRE module** — quick image preprocessing: **Scale** (percent of the source's longest side — writes through to OUTPUT's scale, so downscaling happens *before* effects), **Blur / Grain / Gamma** scrubs, and a black-point/white-point levels track. PRE is a *working buffer*: it previews at the end of the current mix, and **`Add to mix` bakes it into the mix as its own `Preprocess` layer** glued under the effect you add, then resets. The baked layer is editable/reorderable like any other.

**Edit panel** — edits ONE target, shown in its header:
  - `NEW · <Effect>` — a freshly picked effect; its controls/presets are here and **`Add to mix`** commits it as a layer (and switches to editing that layer).
  - `EDIT · <Effect> [n]` — an existing mix layer (click its row). Its params load here and editing them (or picking a per-effect preset) mutates that layer **in place**, live — no `Add`. Clicking an effect in the list returns to NEW mode.
  - `EDIT · OUTPUT` — the pinned OUTPUT layer (see below).
  - **Opacity** — the first scrub for any effect target: layer-level opacity (0–100%) that mixes the layer's output back over its input.
  - **Per-effect presets** — each effect ships 2-3 built-in starter looks; `Save`/`Del` manage your own named presets (`localStorage`, keyed per effect; user presets show `*`).

**Mix stack** — the layers that define the exported style, top to bottom:
  - **`◇ OUTPUT`** (pinned at the top, not reorderable/removable) — the geometry step that runs *first*. Click it to edit **Crop** (`ratio` = `original / 1:1 / 4:5 / 5:4 / 9:16 / 16:9 / 3:2 / 2:3 / custom W×H` + a Figma-style **3×3 align anchor** deciding which region is kept), **Scale** (`none` / `longest side px` / `exact W×H`), and **Format** (`png / webp / jpeg` + quality). Its checkbox toggles crop+scale on/off (off = passthrough). A live **dimensions readout** shows `SRC w×h → OUT w×h`. When ratio ≠ original a rule-of-thirds crop guide + anchor marker overlays the canvas.
  - **Effect layers** — name, enable toggle, reorder ↑↓, remove; click a row to EDIT it. The selected layer is highlighted (inverted).

Because OUTPUT is its own preset block, a style with **no effects** — just the OUTPUT layer set — still crops/scales in batch (e.g. crop a folder of icons to 512×512). Processing order is `input → crop to ratio at the align anchor → scale → effects → encode`, identical in editor preview and engine, so what you see is what you export.

**SETTINGS** (the `⚙` gear at the top-right of the canvas) — an extensible settings surface. First option: **enable/disable effects ("engines")** — a checklist of all effects; unchecking one hides it from the effect list (declutter without editing code). The disabled set persists in `localStorage` (`rstr.disabledEffects`). Disabling only hides from the picker — a saved mix that references a disabled effect still renders.

### Using it
1. Drop an image onto the canvas (or click it to pick a file). To swap it, use the **✕ New image** control at the top-left of the canvas (returns to the drop zone), or just drag-drop a new image over the canvas at any time.
2. Click effects to preview; tune sliders or pick a per-effect preset.
3. `Add to mix` to keep an effect; repeat to stack. Click a mix layer to re-edit it in place; reorder/toggle/remove with its row controls.
4. Click the `◇ OUTPUT` layer to set crop/scale/format/quality; the dimensions readout shows the resulting size.
5. `Export` renders the **committed mix** at the OUTPUT resolution and downloads `<name>-rstr.<ext>` (extension follows the format). `Reset` clears the mix and output.
6. **Styles**: `Save` stores the current style in your local library; pick it from the dropdown to reload it (replaces the mix + output). `Copy code` puts the style JSON on the clipboard; `Paste code` opens an inline field that accepts either a full style JSON **or** a bare `rstr_…` id (resolved against your library) — malformed input shows an inline error and never crashes. The NEW-mode preview effect is *not* part of the style until you `Add` it.

### Canvas viewport
The image always displays at its true aspect ratio, fit-to-view and centered on load (never upscaled past 100%). It's a display-only viewport — zoom/pan never re-render the pipeline, and `Export`/the engine always output the full processing-resolution image regardless of on-screen zoom. Controls (bottom-left of the canvas): a **zoom slider** + `%` readout, **`Fit`** / **`100%`** buttons, **Ctrl + mouse-wheel** to zoom toward the cursor (plain wheel does nothing), and **middle-mouse drag** to pan. The checkerboard stays fixed as you pan; the OUTPUT crop guide is inside the same transformed wrapper as the canvas, so it stays aligned while zooming/panning.

To use a style with the **engine**, `Copy code` and paste the JSON into a `presets/*.json` file (the browser Style Library lives in `localStorage`; the engine reads `presets/`).

## 2. Engine

```
cd engine
npm install
node rstr.js --preset ../presets/my-retro.json --in ../test-assets --out ../out
```

```
Usage: node rstr.js --preset <file|id> --in <dir> --out <dir> [--suffix -rstr]
  --preset   path to a style .json, or a bare id (e.g. rstr_ab12cd34) resolved against presets/
  --in       folder of input images (.png/.jpg/.jpeg/.webp)
  --out      folder to write output PNGs to (created if missing)
  --suffix   filename suffix before the extension (default: -rstr)
```

It launches the Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` (override with the `CHROME_PATH` env var) via `puppeteer-core` — no Chromium download. It loads `engine/render.html` once, then for each image in `--in`: reads it, converts to a data URL, calls `window.RSTR.render(dataURL, preset)` in-page (the same `src/pipeline.js` the editor uses — crop → resize → effects → encode), and writes the result to `--out`. **The output file extension follows the style's `output.format`** (`png` / `webp` / `jpg`), so a webp style yields `.webp` files.

The only launch flags are the software-WebGL ones headless Chrome needs to render off-screen (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox`), verified against the installed Chrome 149. Because the shared core is classic scripts, no file-access/CORS overrides are required.

## Style code format

```json
{
  "id": "rstr_6f77ab4f",
  "name": "webp-1080",
  "v": 1,
  "stack": [
    { "effect": "adjust", "enabled": true, "params": { "brightness": 0.05, "contrast": 0.3, "saturation": -0.2, "gamma": 1 } },
    { "effect": "duotone", "enabled": true, "params": { "colorA": "#101010", "colorB": "#f0f0f0" } }
  ],
  "output": {
    "crop":  { "ratio": "1:1", "align": "C" },
    "scale": { "mode": "fit", "size": 1080, "width": null, "height": null },
    "format": "webp",
    "quality": 0.85
  }
}
```

`id` is a short deterministic hash of `{v, stack, output}` — the same recipe always produces the same id. Hand another agent either the id (if the style already lives in `presets/`) or the full JSON. The `output` block is optional; when absent it defaults to `{crop:{ratio:"original",align:"C"}, scale:{mode:"none",…}, format:"png", quality:0.92}` (backward-compatible full-size PNG). Legacy `{crop:"1:1", size:1080}` styles are auto-migrated on load (→ `crop.ratio` + `scale.mode:"fit"`). `presets/` ships `my-retro.json` (effects only, default output) and `webp-1080.json` (1:1 / 1080 / webp).

A stack entry may also carry `"opacity": 0.5` (layer-level, 0–1; serialized only when < 1 — full-opacity styles stay byte-identical to older codes) and may reference the internal `preprocess` effect (how the editor's PRE block is committed). Legacy codes with a top-level `"pre"` block still load: the editor converts it to a leading `preprocess` layer, the engine prepends it. Layers whose effect id no longer exists (e.g. the removed `displace`/`distort`/`blur`/`hue`/`sharpen` — hue and sharpen now live inside `adjust`) are dropped with a console warning instead of crashing.

## Adding a new effect

Add one entry to `EFFECTS` in `src/effects.js` (id, name, params schema, built-in presets, and **either** a `frag` fragment shader **or** a `cpu(rgba, w, h, params) -> rgba` CPU stage — mutually exclusive). The editor UI (flat list + settings checklist), per-effect presets, and the pipeline all read this registry — nothing else changes. Effect entries may still carry a `category` field; the UI ignores it (flat list). A `cpu` effect is run by the pipeline via readback → JS → re-upload as a texture, so it works identically in the editor and the engine (e.g. the Floyd–Steinberg dither).

**Future (out of scope for now):** iterative/stateful effects (cellular-automata) and animation (slide/stack) — they need a multi-frame runtime the single-pass pipeline doesn't have yet.

## Self-test

`scripts/gen-test-assets.mjs` synthesizes `test-assets/gradient.png`, `shapes.png`, `radial.png` with a hand-rolled PNG encoder (no native deps, no network). Regenerate with `node scripts/gen-test-assets.mjs`.

## Contributing

Contributions are welcome. The whole app is classic scripts on `window.RSTR` — no build, no framework, no bundler. To hack on the editor, double-click `index.html` and reload after edits. Most changes are one entry in the `EFFECTS` registry (see **Adding a new effect** above). Open an issue to discuss larger changes, then send a PR — every PR gets an automatic Vercel preview deploy.

## License

RSTR is free software licensed under the [GNU General Public License v3.0](LICENSE). You may use, study, share, and modify it; any distributed derivative must also be released under the GPL-3.0. It comes with no warranty.

Copyright © 2026 Kirill Peskov

To confirm the engine actually applies shaders (not a passthrough), run it over `test-assets/` and compare bytes/sizes, or decode both images to pixels (e.g. via a `<canvas>` in any browser) and diff. During development this was verified for the example styles and individual effects — every case showed 90-100% of pixels changed, average per-channel differences in the tens-to-hundreds (out of 255), never zero. The `webp-1080` style was confirmed to produce 1080×1080 `.webp` output in both the editor export and the engine.
