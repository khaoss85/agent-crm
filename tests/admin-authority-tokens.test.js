// @ts-check
/**
 * BO-F0-01 — shared visual system: the authority colours are one contract.
 *
 * The Admin stylesheet and the public site read the same tokens from a single
 * source of truth: `apps/admin/public/styles.css` (`:root`) mirrors
 * `site/brand.json` (`flowColors`, `colors`, `siteColors`, `typography`).
 * The names differ on two tokens (Admin `--pending`/`--data` are the brand's
 * `policy`/`evidence`); the values must not. Every authority colour owns one
 * badge component (`.badge[data-authority="<id>"]`) with a fixed meaning taken
 * from the backoffice brief: colours name an authority, never a severity.
 *
 * The last two tests pin the current visual baseline: existing state badges
 * keep the exact pairs the prototype paints, and no literal colour may appear
 * outside `:root`, so a recolour or a new hue fails here before it ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const css = readFileSync(join(root, 'apps/admin/public/styles.css'), 'utf8');
const brand = JSON.parse(readFileSync(join(root, 'site/brand.json'), 'utf8'));

/** @returns {Record<string, string>} `--var` -> `#hex` for the `:root` block. */
function rootVars() {
  const start = css.search(/:root\s*\{/);
  assert.ok(start >= 0, 'styles.css keeps a :root token block');
  let depth = 0;
  let end = -1;
  const open = css.indexOf('{', start);
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, 'the :root block closes');
  const block = css.slice(open, end);
  const vars = {};
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)) {
    vars[match[1]] = match[2].toLowerCase();
  }
  return vars;
}

test('authority tokens in styles.css match the single source in brand.json', () => {
  const vars = rootVars();
  // Admin `--pending`/`--data` are the brand's `policy`/`evidence`: same
  // values, long-standing names. A rename would repaint every Admin screen,
  // so only the values are pinned here.
  const pairs = [
    ['agent', 'agent'],
    ['pending', 'policy'],
    ['human', 'human'],
    ['data', 'evidence'],
    ['accord', 'accord'],
  ];
  for (const [adminToken, flowToken] of pairs) {
    assert.equal(
      vars[adminToken],
      String(brand.flowColors[flowToken]).toLowerCase(),
      `--${adminToken} must stay ${brand.flowColors[flowToken]} (flow.${flowToken})`,
    );
  }
  assert.equal(vars.danger, String(brand.colors.danger).toLowerCase(), 'fault red is one token');
  assert.equal(vars.paper, String(brand.siteColors.paper).toLowerCase(), 'the paper ground is one token');
  assert.match(vars['accent-soft'] ?? '', /^#/);
  assert.ok(
    /Bricolage Grotesque/.test(css) && /Spline Sans Mono/.test(css),
    'the Admin sets the same two faces as the brand',
  );
  assert.ok(
    String(brand.typography.sans).includes('Bricolage Grotesque') &&
      String(brand.typography.mono).includes('Spline Sans Mono'),
    'brand.json declares the same two faces',
  );
});

/**
 * Authority id -> [background token, ink token, fixed meaning].
 * Violet proposes, yellow holds the gate, coral decides, cyan proves,
 * green seals the accord, red is faults only.
 */
const AUTHORITIES = {
  agent: ['agent-soft', 'agent-ink', 'the AI proposes'],
  policy: ['pending-soft', 'pending-ink', 'a deterministic rule holds the gate'],
  human: ['human-soft', 'human-ink', 'a named person decides'],
  evidence: ['data-soft', 'data-ink', 'audit, trace and sources'],
  accord: ['accent-soft', 'accent', 'the agreement the prototype paints green'],
  fault: ['danger-soft', 'danger', 'a fault, owned by no authority'],
};

test('every authority colour owns a badge component with its fixed meaning', () => {
  const flat = css.replace(/\s+/g, ' ');
  for (const [id, [bg, ink, meaning]] of Object.entries(AUTHORITIES)) {
    const rule = `.badge[data-authority="${id}"] { background: var(--${bg}); color: var(--${ink}); }`;
    assert.ok(
      flat.includes(rule),
      `${id} (${meaning}) must render exactly: ${rule}`,
    );
  }
});

test('existing state badges keep their prototype pairs (visual baseline)', () => {
  const flat = css.replace(/\s+/g, ' ');
  const baseline = [
    '.badge.approval_pending, .badge.approval_required, .badge.pending, .badge.blocked { background: var(--pending-soft); color: var(--pending-ink); }',
    '.badge.rejected { background: var(--human-soft); color: var(--human-ink); }',
    '.badge.proposal, .badge.draft { background: var(--agent-soft); color: var(--agent-ink); }',
    '.badge.completed, .badge.approved, .badge.auto_approve, .badge.active { background: var(--accent-soft); color: var(--accent); }',
    '.badge.failed { background: var(--danger-soft); color: var(--danger); }',
  ];
  for (const rule of baseline) {
    assert.ok(flat.includes(rule), `baseline must not drift: ${rule}`);
  }
});

test('the badge census is closed: base, five state rules, six authority rules', () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...noComments.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1].trim());
  const badgeRules = rules.filter((selector) => selector.includes('.badge'));
  const base = badgeRules.filter((selector) => selector === '.badge');
  const state = badgeRules.filter(
    (selector) => selector.includes('.badge.') && !selector.includes('['),
  );
  const authority = badgeRules.filter((selector) => selector.includes('[data-authority='));
  assert.equal(base.length, 1, 'one unpainted .badge base rule');
  assert.equal(state.length, 5, 'exactly five state rules (the pinned visual baseline)');
  assert.equal(authority.length, 6, 'exactly six authority variants, one per authority');
  assert.deepEqual(
    authority.sort(),
    ['accord', 'agent', 'evidence', 'fault', 'human', 'policy']
      .map((id) => `.badge[data-authority="${id}"]`)
      .sort(),
    'no seventh variant may appear without re-capturing the PNG proof',
  );
});

test('no shipped markup or script can match an authority selector', () => {
  // The six rules above paint only `.badge[data-authority="<id>"]`. That
  // attribute appears in styles.css (the definitions) and nowhere else, so no
  // existing Admin screen can ever match the new rules: the before/after PNGs
  // must be identical for that reason, not by luck of the capture. When a new
  // backoffice view starts using data-authority, allowlist its files here with
  // the story id and re-capture the proof with `npm run admin:shots`.
  const pub = join(root, 'apps/admin/public');
  const producers = [];
  const entries = readdirSync(pub);
  for (const file of [...entries, 'index.html']) {
    if (!file.endsWith('.js') && !file.endsWith('.html')) continue;
    const source = readFileSync(join(pub, file), 'utf8');
    if (source.includes('data-authority')) producers.push(file);
  }
  assert.deepEqual(producers, [], 'existing screens must not produce data-authority elements');
});

test('no literal colour outside :root: every paint reads a token', () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = noComments.search(/:root\s*\{/);
  let depth = 0;
  let end = -1;
  const open = noComments.indexOf('{', start);
  for (let i = open; i < noComments.length; i++) {
    if (noComments[i] === '{') depth++;
    if (noComments[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const rest = noComments.slice(0, start) + noComments.slice(end + 1);
  assert.doesNotMatch(rest, /#[0-9a-f]{6}\b/i, 'a literal hex outside :root is a second source');
  const pub = join(root, 'apps/admin/public');
  for (const file of readdirSync(pub)) {
    if (!file.endsWith('.js') && file !== 'index.html') continue;
    const source = readFileSync(join(pub, file), 'utf8');
    assert.doesNotMatch(source, /#[0-9a-f]{6}\b/i, `${file} must paint through tokens, never literals`);
  }
});
