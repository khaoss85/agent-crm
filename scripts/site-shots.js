// @ts-check

/**
 * Renders the built site to PNGs: the GitHub social preview and page captures.
 *
 * These are the images a repository card and a link unfurl show, and the source
 * material a launch gallery gets cropped from. Hand-made ones drift from the
 * product within a release; here
 * they are generated from the same templates and the same claims ledger as the
 * site, so an image can no longer claim something the tests stopped supporting.
 *
 * Requires a Chromium binary. It looks for CHROMIUM_BIN, then the Playwright
 * locations this repository's CI images provide. If none is present the script
 * exits 0 with a message: shots are a publishing convenience, not a build gate.
 *
 * Run: npm run site:shots      Output: site/dist/shots/
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = process.cwd();
const dist = join(root, 'site', 'dist');
const shots = join(dist, 'shots');

if (!existsSync(dist)) {
  console.error('site/dist does not exist — run `npm run site:build` first.');
  process.exit(1);
}

const binary = findChromium();
if (!binary) {
  console.log('No Chromium binary found (set CHROMIUM_BIN to override). Skipping image generation.');
  process.exit(0);
}

// The plain headless shell gives an exact viewport. The full browser in its
// current headless mode reserves window chrome, which silently crops the bottom
// ~77px of every shot — the kind of defect nobody notices until it is on a
// repository card.
const targets = [
  {
    name: 'social-preview.png',
    // GitHub renders the social preview at 1280x640; 2x keeps the type sharp.
    html: wrapSvg('social-preview.svg'),
    width: 1280,
    height: 640,
    scale: 2,
    note: 'GitHub social preview — Settings → General → Social preview',
  },
  {
    name: 'hero.png',
    file: 'index.html',
    width: 1270,
    height: 760,
    scale: 2,
    note: 'Above the fold — the promise, the proof line and the two calls to action',
  },
  // Full-page renders rather than per-section frames. A #fragment does not settle
  // before a headless screenshot fires, so anchor-targeted shots silently return
  // the hero — an image that looks fine and shows the wrong thing. Capturing the
  // whole page is deterministic; crop from it for a gallery when there is a launch
  // to build one for.
  {
    name: 'page-landing.png',
    file: 'index.html',
    width: 1270,
    height: 5200,
    scale: 1,
    note: 'Full landing page, top to bottom',
  },
  {
    name: 'page-evidence.png',
    file: 'evidence.html',
    width: 1270,
    height: 4200,
    scale: 1,
    note: 'Full evidence page — the complete claims ledger',
  },
];

rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'site-shots-'));
const manifest = [];

try {
  for (const target of targets) {
    let url;
    if (target.html) {
      const path = join(scratch, `${target.name}.html`);
      writeFileSync(path, target.html);
      url = `file://${path}`;
    } else {
      url = `file://${join(dist, target.file)}`;
    }

    const result = spawnSync(binary, [
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      // Let layout and any web font settle before the frame is captured.
      '--virtual-time-budget=2000',
      `--force-device-scale-factor=${target.scale}`,
      `--screenshot=${join(shots, target.name)}`,
      `--window-size=${target.width},${target.height}`,
      url,
    ], { encoding: 'utf8', timeout: 60_000 });

    const output = join(shots, target.name);
    if (result.status !== 0 && !existsSync(output)) {
      console.error(`  ✗ ${target.name}: chromium exited ${result.status}`);
      process.exitCode = 1;
      continue;
    }
    const { width, height } = readPngSize(output);
    manifest.push({ file: target.name, width, height, note: target.note });
    console.log(`  ✓ ${target.name}  ${width}×${height}  ${target.note}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

writeFileSync(join(shots, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n${manifest.length} image(s) in site/dist/shots.`);

/**
 * Inlines the SVG in a zero-margin page. Referencing it with <img> lets the
 * document's own layout scale it, which is how a 1280x640 asset quietly becomes
 * 1265x632.
 * @param {string} name
 */
function wrapSvg(name) {
  const svg = readFileSync(join(dist, name), 'utf8');
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0;overflow:hidden}svg{display:block;width:1280px;height:640px}</style>',
    svg,
  ].join('\n');
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    '/opt/pw-browsers/chromium/chrome-linux/headless_shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // A glob-free scan for any versioned Playwright headless shell.
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const entry of readDirSafe(base)) {
    const path = join(base, entry, 'chrome-linux', 'headless_shell');
    if (existsSync(path)) return path;
  }
  return null;
}

/** @param {string} directory */
function readDirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** @param {string} path */
function readPngSize(path) {
  const data = readFileSync(path);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
