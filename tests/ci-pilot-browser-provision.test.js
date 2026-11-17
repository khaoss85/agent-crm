// @ts-check

/**
 * Provisioning-path proof for `scripts/ci-pilot-browser.sh`
 * (backlog:ae2d5d3c): on a runner with no drivable Chromium the script
 * installs the headless shell the pilot's pinned playwright-core expects
 * and then runs the pilot browser proof — offline, with stub `npx`/`npm`
 * on PATH and an empty HOME, so no clone, no download and no browser run
 * can happen here. The real run path (provision + 10/10 green) is proved
 * by the CI fast job on a client-touching PR.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execGit } from './helpers/isolated-git.js';

const SCRIPT = new URL('../scripts/ci-pilot-browser.sh', import.meta.url).pathname;

/** @param {string} dir */
function git(dir, ...args) {
  execGit(args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A throwaway agent-crm repo whose PR diff touches the served client. */
function clientTouchingRepo() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-run-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  fs.mkdirSync(join(dir, 'apps', 'admin', 'public'), { recursive: true });
  fs.writeFileSync(join(dir, 'apps', 'admin', 'public', 'app.js'), 'export const x = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-qb', 'pr');
  fs.writeFileSync(join(dir, 'apps', 'admin', 'public', 'app.js'), 'export const x = 2;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'touch the client');
  return dir;
}

/**
 * A fake pilot checkout naming a pinned playwright-core. With `drifted`
 * the checkout also carries a fake playwright-core module whose
 * executablePath() points at a build the script's hardcoded list does not
 * know — the drift a fresh playwright release brings.
 * @param {{ driftedBin?: string }} [opts]
 */
function fakePilot(opts = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-pilot-'));
  fs.writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fake-pilot', devDependencies: { 'playwright-core': '1.64.1' } }),
  );
  if (opts.driftedBin) {
    const mod = join(dir, 'node_modules', 'playwright-core');
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(join(mod, 'package.json'), JSON.stringify({ name: 'playwright-core', main: 'index.js' }));
    fs.writeFileSync(
      join(mod, 'index.js'),
      `module.exports = { chromium: { executablePath: () => ${JSON.stringify(opts.driftedBin)} } };\n`,
    );
  }
  return dir;
}

/**
 * Stub bin dir: `npx` records its args and fakes the headless-shell install
 * into the (overridden) HOME cache; `npm` records its args and exits 0.
 * @returns {{ bin: string, logDir: string }}
 */
function stubBin(home) {
  const bin = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-bin-'));
  const logDir = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-log-'));
  // The stub "installs" wherever STUB_INSTALL_REL says (default: the
  // hardcoded Linux cache path the script knows); the drift test points it
  // at a build the script does not know instead. STUB_INSTALL_REL reaches
  // the stub through the environment, so the bash below must not contain
  // a JS ${...} interpolation.
  const npxLog = JSON.stringify(join(logDir, 'npx-args'));
  const npxStub =
    '#!/usr/bin/env bash\necho "$@" >> ' + npxLog + '\n' +
    'rel="${STUB_INSTALL_REL:-.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell}"\n' +
    'mkdir -p "$HOME/$(dirname "$rel")"\n' +
    'touch "$HOME/$rel"\n' +
    'chmod +x "$HOME/$rel"\n';
  fs.writeFileSync(join(bin, 'npx'), npxStub);
  fs.writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(join(logDir, 'npm-args'))}\n`);
  fs.chmodSync(join(bin, 'npx'), 0o755);
  fs.chmodSync(join(bin, 'npm'), 0o755);
  return { bin, logDir };
}

/** @param {string} file */
function logged(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * @param {Record<string, string>} extra
 */
function runGate(repo, pilot, home, extra) {
  const { bin, logDir } = stubBin(home);
  const out = execFileSync('bash', [SCRIPT], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      BASE_REF: 'main',
      AGENT_CRM_DIR: repo,
      HEAD_SHA: 'test-head',
      PILOT_DIR: pilot,
      PILOT_SKIP_INSTALL: '1',
      PILOT_GIT_URL: 'file:///nonexistent-pilot-remote',
      // Ignore the runner's machine-wide browsers: with a fresh HOME the
      // resolve step would otherwise find the runner's own Chromium and
      // never reach the install this file is meant to prove.
      PILOT_BROWSER_IGNORE_SYSTEM: '1',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { out, logDir };
}

test('a client-touching diff with no browser provisions the pinned shell, then runs the proof', () => {
  const repo = clientTouchingRepo();
  const pilot = fakePilot();
  const home = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-home-'));
  try {
    const { out, logDir } = runGate(repo, pilot, home, {});
    assert.match(out, /no drivable Chromium found, installing the browser for playwright-core 1\.64\.1/);
    assert.match(logged(join(logDir, 'npx-args')), /playwright@1\.64\.1 install chromium/);
    assert.match(logged(join(logDir, 'npm-args')), /run test:browser/);
    assert.match(out, /pilot-browser: PASS in \d+s/);
  } finally {
    for (const dir of [repo, pilot, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a playwright release the hardcoded list does not know still resolves through executablePath', () => {
  const repo = clientTouchingRepo();
  const home = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-home-'));
  const rel = '.cache/ms-playwright/chromium-9999/chrome-linux/chrome';
  const pilot = fakePilot({ driftedBin: join(home, rel) });
  try {
    const { out, logDir } = runGate(repo, pilot, home, { STUB_INSTALL_REL: rel });
    assert.match(logged(join(logDir, 'npx-args')), /playwright@1\.64\.1 install chromium/);
    assert.match(logged(join(logDir, 'npm-args')), /run test:browser/);
    assert.match(out, /pilot-browser: PASS in \d+s/);
  } finally {
    for (const dir of [repo, pilot, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ACCORDO_BROWSER_BIN skips the provisioning install', () => {
  const repo = clientTouchingRepo();
  const pilot = fakePilot();
  const home = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-home-'));
  try {
    const { out, logDir } = runGate(repo, pilot, home, { ACCORDO_BROWSER_BIN: '/bin/true' });
    assert.doesNotMatch(out, /installing the headless shell/);
    assert.equal(logged(join(logDir, 'npx-args')), '');
    assert.match(logged(join(logDir, 'npm-args')), /run test:browser/);
    assert.match(out, /pilot-browser: PASS in \d+s/);
  } finally {
    for (const dir of [repo, pilot, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
