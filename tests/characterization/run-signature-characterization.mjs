import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BEHAVIOUR_BEARING_SOURCE, SIGNATURE_SOURCE, buildSignatureBaseline, sigObservation as observation,
} from './signature-harness.mjs';
import {
  runCrashRestartScaleCases, runFailureAndReconcileCases, runJourneyCases, runPureCases,
} from './signature-cases.mjs';

/**
 * Run every Signature & Order case and assemble the baseline document. The
 * SAME function produces the checked-in baseline and the fresh run the test
 * compares against it.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export const SOURCE_FILES = BEHAVIOUR_BEARING_SOURCE;

/** @param {string} [rootDir] */
export function sourceFingerprints(rootDir = repoRoot) {
  const out = {};
  for (const relative of SOURCE_FILES) {
    try {
      out[relative] = createHash('sha256').update(readFileSync(join(rootDir, relative))).digest('hex');
    } catch {
      out[relative] = 'absent';
    }
  }
  return out;
}

/**
 * Architecture evidence for the extraction and for the B7 seam question,
 * measured from source rather than remembered. All `pre_extraction_evidence`:
 * these are the wiring facts the extraction exists to change, so they are
 * recorded and never compared.
 */
export async function runArchitectureEvidence(record, rootDir = repoRoot) {
  const { readsProperty, importsFrom, SCANNER_LIMITS } = await import('./source-scan.mjs');
  const sourceFiles = execFileSync('git', ['ls-files', '--', '*.js', '*.mjs'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((file) => !file.startsWith('tests/'));
  const read = (file) => readFileSync(join(rootDir, file), 'utf8');

  const internalImporters = sourceFiles
    .filter((file) => importsFrom(read(file), /signature-(operations|registry)\.js$/).length > 0).sort();
  record(observation({
    id: 'architecture.signature-internal-importers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: internalImporters,
    note: `Every file with a real import statement naming a Signature internal. Scanner limits: ${SCANNER_LIMITS.join('; ')}.`,
  }));

  const externalOperationImporters = sourceFiles
    .filter((file) => importsFrom(read(file), /external-operation\.js$/).length > 0).sort();
  record(observation({
    id: 'architecture.external-operation-importers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: externalOperationImporters,
    note: 'The evidence behind the neutral-helper verdict: the generic action runtime imports it for any externalOperation action; signature-operations.js is today its only other direct caller.',
  }));

  const appSignatureConsumers = sourceFiles.filter((file) => readsProperty(read(file), 'app', 'signature')).sort();
  record(observation({
    id: 'architecture.app-signature-consumers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: appSignatureConsumers,
    note: 'Every file that reads the ambient app.signature registry handle, in code.',
  }));

  const slotDependants = sourceFiles
    .filter((file) => /signature\/generated/.test(stripCode(read(file)))).sort();
  record(observation({
    id: 'architecture.signature-generated-slot-dependants',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'app-inspect',
    observed: slotDependants,
    note: 'Who depends on the fixed project-owned provider slot packages/signature/generated/.',
  }));

  const serverSource = read('apps/server/src/http-server.js');
  const routeOwnership = {
    eventsRouteInKernelServer: serverSource.includes('/api/signature/providers/:provider/events'),
    reconcileRouteInKernelServer: serverSource.includes('/api/signature/envelopes/:id/reconcile'),
    eventsRouteRawBodyBounded: /rawBody:\s*true,\s*maxBodyBytes:\s*65_?536/.test(serverSource),
    appMethodsWired: ['ingestSignatureEvent', 'reconcileSignature'].filter((name) => serverSource.includes(name)),
  };
  record(observation({
    id: 'architecture.b7-route-ownership',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'http',
    observed: routeOwnership,
    note: 'B7 evidence: the webhook and reconcile routes are owned by apps/server today. No package can contribute an HTTP route, which LEGACY_ALIGNMENT_MATRIX records as the extraction precondition for Signature.',
  }));

  const coreIndex = read('packages/core/index.js');
  record(observation({
    id: 'architecture.kernel-public-api-signature-surface',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: {
      exportsRunExternalOperation: /runExternalOperation/.test(coreIndex),
      exportsWithExternalTimeout: /withExternalTimeout/.test(coreIndex),
      exportsSignatureAnything: /signature/i.test(stripCode(coreIndex)),
      exportsDefinitionFingerprint: /computeDefinitionFingerprint/.test(coreIndex),
      exportsWithTimeout: /withTimeout/.test(coreIndex),
    },
    note: 'Readiness gap, measured: packages/core/index.js — the only import a package may use — exports neither runExternalOperation nor withExternalTimeout, so an extracted Signature package could not run its app-level operations without a new public export or an operations seam.',
  }));

  record(observation({
    id: 'architecture.grep-patterns-used',
    category: 'architecture',
    classification: 'incidental',
    surface: 'sdk',
    observed: [...SIGNATURE_SOURCE.greps],
    note: 'The seam patterns the evidence cases scan for, recorded so a reader of the baseline can reproduce the scan.',
  }));
}

/** The slot is referenced as a path string, so only comments are stripped. */
function stripCode(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Run everything and assemble the document. */
export async function generateBaseline(t) {
  /** @type {any[]} */
  const observations = [];
  const record = (entry) => observations.push(entry);

  await runPureCases(record);
  await runJourneyCases(t, record);
  await runFailureAndReconcileCases(t, record);
  await runCrashRestartScaleCases(t, record);
  await runArchitectureEvidence(record);

  return buildSignatureBaseline({
    source: sourceFingerprints(),
    observations,
  });
}
