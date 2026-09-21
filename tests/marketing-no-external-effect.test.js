import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(repoRoot, 'packages/marketing/src');
const modulesDir = join(repoRoot, 'packages/marketing/modules');

/**
 * MK1 acceptance, second and third clauses: no provider is contacted by any
 * path in the package, and no external effect is reachable from it.
 *
 * The guarantee is structural — there is no provider registry, no credential
 * field, no network primitive and no dynamic code — so this suite pins the
 * structure rather than re-asserting a behaviour. A future edit that adds a
 * send path fails here first.
 */

const sources = () => readdirSync(srcDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ file, source: readFileSync(join(srcDir, file), 'utf8') }));

test('no network primitive exists anywhere in package source', () => {
  for (const { file, source } of sources()) {
    assert.equal(/\bfetch\s*\(/.test(source), false, `${file} calls fetch`);
    assert.equal(/from\s+['"]node:(https?|http2|net|dgram|tls|dns)['"]/.test(source), false,
      `${file} imports a network module`);
    assert.equal(/require\s*\(\s*['"](https?|net|undici)['"]/.test(source), false,
      `${file} requires a network module`);
    assert.equal(/XMLHttpRequest|WebSocket|navigator\.sendBeacon/.test(source), false,
      `${file} reaches a browser send path`);
    assert.equal(/child_process|spawnSync|execSync/.test(source), false,
      `${file} shells out`);
  }
});

test('no dynamic code and no credential handling exist anywhere in package source', () => {
  for (const { file, source } of sources()) {
    assert.equal(/\beval\s*\(/.test(source), false, `${file} uses eval`);
    assert.equal(/\bnew Function\s*\(/.test(source), false, `${file} builds a function from text`);
    assert.equal(/await import\(/.test(source), false, `${file} imports dynamically`);
    assert.equal(/apiKey|api_key|secret|password|bearer|BEGIN [A-Z ]*PRIVATE KEY/.test(source), false,
      `${file} touches a credential`);
  }
});

test('the package declares no provider of any kind', () => {
  for (const { file, source } of sources()) {
    assert.equal(/register\w*[Pp]rovider|install\w*[Pp]rovider|\w*[Pp]roviderRegistry|\w*[Pp]roviderAdapter/.test(source), false,
      `${file} declares a provider seam`);
    assert.equal(/send[A-Z]\w*\(|publish[A-Z]\w*\(|spend[A-Z]\w*\(/.test(source), false,
      `${file} names a send, publish or spend operation`);
  }
});

test('no manifest field can carry a credential or a provider handle', () => {
  const names = readdirSync(modulesDir).filter((file) => file.endsWith('.module.json'));
  assert.ok(names.length > 0, 'the package owns record modules');
  for (const name of names) {
    const manifest = JSON.parse(readFileSync(join(modulesDir, name), 'utf8'));
    for (const field of manifest.fields) {
      // Handle-shaped names only: `providerRationale` is documented prose a
      // human reads (the acceptance clause requires it), never a resolved
      // handle — the source scan above proves no code could resolve one.
      assert.equal(/credential|secret|token|password|apikey|api_key|providerId|providerKey|providerConfig|providerHandle|endpoint|webhook|auth/i.test(field.name), false,
        `${name}#${field.name} could carry a provider handle`);
    }
  }
});
