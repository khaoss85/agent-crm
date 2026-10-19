import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateModuleManifest } from '../packages/core/src/module-manifest.js';
import { LLM_PACKAGE, LLM_RESOURCES, createLlmPackage } from '../packages/llm/src/index.js';
import { assertPackageConforms } from './helpers/package-conformance.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageDir = join(repoRoot, 'packages/llm');
const modulesDir = join(packageDir, 'modules');

/**
 * The llm package conforms to the domain package contract
 * (backlog:6e54d6a7988a): identity, owned resources, the offered
 * capability, public imports only — and no network primitive in package
 * source (the OpenAI adapter speaks through an injected transport).
 */

test('the llm package conforms to the domain package contract', () => {
  const definition = createLlmPackage();
  assert.equal(definition.name, LLM_PACKAGE);
  assertPackageConforms({
    definition,
    dir: packageDir,
    expected: {
      name: 'llm',
      version: 1,
      resources: [...LLM_RESOURCES],
      provides: ['llm-complete@1'],
    },
    // Belt and braces: an LLM package that dials out on its own fails
    // conformance — the deployment injects the transport instead.
    forbiddenImports: [/from\s+['"]node:(https?|net|dgram|tls|dns)['"]/, /\bfetch\s*\(/, /child_process/],
  });
});

test('the llm manifest validates through the same path the starter uses', () => {
  const manifests = readdirSync(modulesDir).filter((file) => file.endsWith('.module.json')).sort();
  assert.deepEqual(manifests, ['llm-call.module.json']);
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(join(modulesDir, file), 'utf8'));
    const normalized = validateModuleManifest(manifest);
    assert.equal(normalized.name, 'llm-call');
    for (const field of normalized.fields) {
      assert.equal(field.writable, 'managed', `${field.name} must be managed: the audit exists only through the package`);
    }
  }
});

test('the llm operation is declared for the app handle', () => {
  const definition = createLlmPackage();
  const operations = definition.operations ?? [];
  assert.deepEqual(operations.map((entry) => `${entry.name}:${entry.appMethod}`), [
    'request-llm-completion:requestLlmCompletion',
  ]);
});
