#!/usr/bin/env node
// rstr.js — CLI: apply a saved RSTR preset to every image in a folder,
// using headless system Chrome (puppeteer-core, no Chromium download).
// The actual shader work happens in engine/render.html, which imports the
// same src/ modules the editor uses — this file only shuttles files in/out.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.join(__dirname, '..', 'presets');
const RENDER_HTML = path.join(__dirname, 'render.html');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('Could not find an installed Chrome. Set CHROME_PATH env var to override.');
}

function parseArgs(argv) {
  const args = { suffix: '-rstr' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') args.preset = argv[++i];
    else if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--suffix') args.suffix = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    'Usage: node rstr.js --preset <file|id> --in <dir> --out <dir> [--suffix -rstr]\n' +
      '  --preset   path to a preset .json, or a bare id (e.g. rstr_ab12cd34) resolved against presets/\n' +
      '  --in       folder of input images (.png/.jpg/.jpeg/.webp)\n' +
      '  --out      folder to write output PNGs to (created if missing)\n' +
      '  --suffix   filename suffix before the extension (default: -rstr)'
  );
}

async function resolvePreset(presetArg) {
  const direct = path.resolve(presetArg);
  if (existsSync(direct) && direct.endsWith('.json')) {
    return JSON.parse(await readFile(direct, 'utf8'));
  }

  // A bare filename in presets/, with or without the extension: the editor's
  // "-> Presets" export writes real .json files there, so `--preset my-style.json`
  // is the natural thing to type and used to fall through both branches.
  const bare = presetArg.endsWith('.json') ? presetArg.slice(0, -'.json'.length) : presetArg;
  const byName = path.join(PRESETS_DIR, `${bare}.json`);
  if (existsSync(byName)) {
    return JSON.parse(await readFile(byName, 'utf8'));
  }

  if (existsSync(PRESETS_DIR)) {
    const files = await readdir(PRESETS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(PRESETS_DIR, f);
      const json = JSON.parse(await readFile(full, 'utf8'));
      if (json.id === presetArg) return json;
    }
  }

  throw new Error(`Preset not found: ${presetArg} (looked for a file, and by id under ${PRESETS_DIR})`);
}

function bufferToDataURL(buffer, ext) {
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.preset || !args.in || !args.out) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const preset = await resolvePreset(args.preset);
  const inDir = path.resolve(args.in);
  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const allFiles = await readdir(inDir);
  const files = allFiles.filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  if (files.length === 0) {
    console.error(`No images found in ${inDir}`);
    process.exit(1);
  }

  const executablePath = process.env.CHROME_PATH || findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    // Classic <script src> loads over file:// without the file-access/CORS
    // overrides ES modules needed. Only the software-WebGL flags remain.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[render.html]', msg.text());
    });
    page.on('pageerror', (err) => console.error('[render.html]', err.message));

    await page.goto(pathToFileURL(RENDER_HTML).href, { waitUntil: 'load' });
    await page.waitForFunction('window.__RSTR_READY__ === true');

    // OUTPUT block controls the file extension (default png when absent).
    // Handles both the v1.5 nested schema and the legacy {crop:"1:1",size} form.
    const out = preset.output || {};
    const outFormat = out.format || 'png';
    const outExt = outFormat === 'webp' ? 'webp' : outFormat === 'jpeg' ? 'jpg' : 'png';
    const ratio = typeof out.crop === 'string' ? out.crop : (out.crop && out.crop.ratio) || 'original';
    const align = (out.crop && out.crop.align) || 'C';
    const scale = out.scale || {};
    const scaleStr =
      out.size != null
        ? `fit:${out.size}`
        : scale.mode === 'fit'
          ? `fit:${scale.size}`
          : scale.mode === 'width'
            ? `width:${scale.size}`
            : scale.mode === 'exact'
              ? `exact:${scale.width}x${scale.height}`
              : 'none';
    const outSummary = ` output=${ratio}@${align}/${scaleStr}/${outFormat}`;
    console.log(`Preset: ${preset.name ?? '(unnamed)'} ${preset.id ?? ''} — ${preset.stack.length} effect(s)${outSummary}`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = path.extname(file).toLowerCase();
      const base = path.basename(file, path.extname(file));
      const buffer = await readFile(path.join(inDir, file));
      const dataURL = bufferToDataURL(buffer, ext);

      const resultDataURL = await page.evaluate(
        (dataURL, preset) => window.RSTR.render(dataURL, preset),
        dataURL,
        preset
      );

      const outName = `${base}${args.suffix}.${outExt}`;
      const outBuffer = Buffer.from(resultDataURL.split(',')[1], 'base64');
      await writeFile(path.join(outDir, outName), outBuffer);
      console.log(`[${i + 1}/${files.length}] ${file} -> ${outName}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
