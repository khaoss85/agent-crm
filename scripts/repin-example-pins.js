// @ts-check

/**
 * Repin every checked-in Solution Plan and Implementation Evidence under
 * `examples/` to its live authority — one command, no hand-edits.
 *
 *   node scripts/repin-example-pins.js            recompute every pin and rewrite the drifted files
 *   node scripts/repin-example-pins.js --check     fail when any pin drifted (the PR fast gate message)
 *   node scripts/repin-example-pins.js --root <dir>  run the authorities against another checkout
 *
 * ## Why the pins stay checked in, and why two PRs can still collide on them
 *
 * A plan's `inspectionFingerprint` is the AX2 currency claim: `crm solution
 * check` recomputes it from the live inspection and reports `PLAN_STALE`
 * when the composition moved, so a plan cannot silently survive a
 * composition nobody re-examined. An evidence document's `planFingerprint`
 * and `applicationInspectionFingerprint` bind it to the exact plan bytes and
 * composition it was gathered against, and each `source.artifact` entry pins
 * the bytes of the file it cites (`EVIDENCE_SOURCE_HASH_MISMATCH` when the
 * file moved). All four values are digests of content the repository itself
 * carries — there is no separately observed value to record instead.
 *
 * That is also why two PRs that change the composition can still touch the
 * same pin lines: one checked-in currency value per example cannot hold two
 * divergent compositions, and git cannot merge two divergent digests. What
 * this command removes is the hand-edit and the hunt across files: merge
 * `main`, run `npm run repin:example-pins`, commit the rewritten files.
 * A PR that does not move an authority passes `--check` without touching
 * any example file.
 *
 * ## Authorities
 *
 *   lead-to-won plan + evidence      the live inspection of this repository
 *   activate-support-and-manage-cases the service fixture project (the same
 *     plan + evidence                  `project(t, { withService: true })` the
 *                                      Service currency test inspects)
 *   govern-delivery-change plan       the delivery fixture project (the same
 *                                      `project(t, { withDelivery: true })`
 *                                      the M14b2 currency test inspects)
 *   verifier-fixture-exit-zero pair  the scenario run, via
 *                                      scripts/repin-verifier-fixture.js
 *   govern-customer-identity pair    no live authority binds it (no test
 *                                      inspects its composition): its
 *                                      composition pins are frozen and only
 *                                      the derived values (plan fingerprint,
 *                                      artifact hashes) are refreshed.
 *
 * A `*.plan.json` with no authority above, or an evidence document whose
 * `plan` field names no known plan, refuses: a new example must declare
 * what it is bound to before it can be repinned.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectApplicationCommand } from '../packages/cli/src/app-inspect-command.js';
import { fingerprintPlan, inspectionFingerprint, validateSolutionPlan } from '../packages/core/src/solution-plan.js';
import { validateImplementationEvidence } from '../packages/core/src/implementation-evidence.js';
import { project as composeFixtureProject } from '../tests/helpers/contracts-project.js';
import { repinVerifierFixture } from './repin-verifier-fixture.js';

export const REPIN_EXAMPLE_PINS_CONTRACT = 1;

const PLANS_DIR = 'examples/solution-plans';
const EVIDENCE_DIR = 'examples/implementation-evidence';

/** Plan path (repo-relative) -> where its composition pin comes from. */
export const PLAN_AUTHORITIES = Object.freeze({
  'examples/solution-plans/lead-to-won.plan.json': { type: 'root' },
  'examples/solution-plans/activate-support-and-manage-cases.plan.json': { type: 'fixture', options: { withService: true } },
  'examples/solution-plans/govern-delivery-change.plan.json': { type: 'fixture', options: { withDelivery: true } },
  'examples/solution-plans/verifier-fixture-exit-zero.plan.json': { type: 'verifier-fixture' },
  'examples/solution-plans/govern-customer-identity.plan.json': { type: 'frozen' },
});

const sink = () => {};

/** Canonical bytes for a checked-in example document: 2-space JSON, literal UTF-8, trailing newline. */
function canonicalBytes(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function hex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * @param {{rootDir?: string, check?: boolean, inspect?: Function, inspectFixture?: Function,
 *   scenario?: Function, readFile?: Function, out?: Function, err?: Function}} options
 *   `inspect` and `inspectFixture` both answer like `inspectApplicationCommand`
 *   (the `{ exitCode, report }` envelope); the fingerprint is always derived
 *   here via `inspectionFingerprint`, never typed by the caller.
 */
export async function repinExamplePins({
  rootDir = process.cwd(),
  check = false,
  inspect = inspectApplicationCommand,
  inspectFixture = null,
  scenario = undefined,
  readFile = readFileSync,
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  const root = resolve(rootDir);
  const fail = (message) => {
    err(`repin-example-pins: ${message}\n`);
    return { exitCode: 2, compositionFingerprints: {}, drifted: [], wrote: [] };
  };

  let planNames;
  let evidenceNames;
  try {
    planNames = readdirSync(join(root, PLANS_DIR)).filter((name) => name.endsWith('.plan.json')).sort();
    evidenceNames = readdirSync(join(root, EVIDENCE_DIR)).filter((name) => name.endsWith('.evidence.json')).sort();
  } catch (error) {
    return fail(`cannot list the example documents: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Every plan needs a declared authority before anything is computed.
  for (const name of planNames) {
    if (!Object.hasOwn(PLAN_AUTHORITIES, `${PLANS_DIR}/${name}`)) {
      return fail(`${PLANS_DIR}/${name} has no authority in PLAN_AUTHORITIES: declare what it is bound to first.`);
    }
  }

  /** @type {Map<string, {plan: any, fingerprint: string|null}>} */
  const repinnedPlans = new Map();
  /** @type {string[]} */
  const drifted = [];
  /** @type {Map<string, string>} relative -> bytes to write */
  const pending = new Map();
  const compositionFingerprints = {};

  // Both authorities answer with whatever `inspect` answers (the real AX1
  // report envelope, or a stubbed one in tests); the fingerprint is always
  // derived here, never typed by the caller.
  const fingerprintOf = (answered) => inspectionFingerprint(answered?.report ?? answered);

  const inspectFixtureAuthority = inspectFixture ?? (async (options) => {
    const cleanups = [];
    const fixtureRoot = composeFixtureProject({ after: (fn) => cleanups.push(fn) }, options);
    try {
      return inspect({ rootDir: fixtureRoot, json: true, capture: true });
    } finally {
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* the inspection already ran; cleanup is best-effort */ }
      }
    }
  });

  const inspectRootAuthority = async () => inspect({ rootDir: root, json: true, capture: true });

  // Resolve every authority first, before any file is touched: a repin that
  // cannot observe is not a repin.
  for (const name of planNames) {
    const relative = `${PLANS_DIR}/${name}`;
    const authority = PLAN_AUTHORITIES[relative];
    if (authority.type === 'verifier-fixture' || authority.type === 'frozen') continue;
    try {
      const fingerprint = fingerprintOf(authority.type === 'root'
        ? await inspectRootAuthority()
        : await inspectFixtureAuthority(authority.options));
      if (!hex64(fingerprint)) return fail(`${relative}: its authority produced no composition fingerprint.`);
      compositionFingerprints[relative] = fingerprint;
    } catch (error) {
      return fail(`${relative}: its authority failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const readJson = (relative) => JSON.parse(readFile(join(root, relative), 'utf8'));

  // Repin the plans (except the verifier pair, owned by repin-verifier-fixture.js).
  for (const name of planNames) {
    const relative = `${PLANS_DIR}/${name}`;
    const authority = PLAN_AUTHORITIES[relative];
    if (authority.type === 'verifier-fixture') continue;
    let raw;
    try {
      raw = readJson(relative);
    } catch (error) {
      return fail(`cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== 'object' || !raw.application || typeof raw.application !== 'object') {
      return fail(`${relative} has no application section to pin.`);
    }
    const repinned = { ...raw, application: { ...raw.application } };
    if (authority.type !== 'frozen') {
      repinned.application.inspectionFingerprint = compositionFingerprints[relative];
    }
    const checked = validateSolutionPlan(repinned);
    if (!checked.valid) {
      return fail(`the repinned ${relative} is invalid: ${checked.problems.map((problem) => problem.message).join('; ')}`);
    }
    const fingerprint = fingerprintPlan(checked.plan);
    repinnedPlans.set(relative, { plan: checked.plan, fingerprint });
    if (raw.application.inspectionFingerprint !== repinned.application.inspectionFingerprint) {
      drifted.push(`${relative}#application.inspectionFingerprint`);
    }
    pending.set(relative, canonicalBytes(repinned));
  }

  // The verifier pair first: it validates and writes through its own command,
  // so the evidence loop below reads back the live pins it just wrote instead
  // of overwriting them with the stale bytes this turn started from — a
  // refusal anywhere leaves the tree untouched either way.
  const verifierArgs = { rootDir: root, check, out: sink, err: sink };
  if (scenario !== undefined) verifierArgs.scenario = scenario;
  const verifier = await repinVerifierFixture(verifierArgs);
  if (verifier.exitCode === 2) {
    verifier.err?.('');
    return fail('the verifier fixture refused its repin; nothing was written.');
  }
  for (const field of verifier.drifted) drifted.push(field);
  if (verifier.exitCode !== 0 && !check) return fail('the verifier fixture repin failed; nothing was written.');

  // Repin the paired evidences: the plan fingerprint and the composition pin
  // follow the (possibly repinned) plan, and every cited source artifact is
  // re-hashed from the live bytes — the same comparison `crm solution
  // verify` reports as EVIDENCE_SOURCE_HASH_MISMATCH.
  for (const name of evidenceNames) {
    const relative = `${EVIDENCE_DIR}/${name}`;
    let raw;
    try {
      raw = readJson(relative);
    } catch (error) {
      return fail(`cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== 'object' || typeof raw.plan !== 'string') {
      return fail(`${relative} names no plan to bind to.`);
    }
    const planRelative = raw.plan;
    if (!repinnedPlans.has(planRelative) && !Object.hasOwn(PLAN_AUTHORITIES, planRelative)) {
      return fail(`${relative} names ${planRelative}, which is no checked-in plan.`);
    }
    const paired = planRelative.endsWith('verifier-fixture-exit-zero.plan.json')
      ? null
      : repinnedPlans.get(planRelative);
    if (paired === undefined) return fail(`${relative} names ${planRelative}, which has no repinned plan.`);
    const repinned = { ...raw };
    if (paired !== null) {
      repinned.planFingerprint = paired.fingerprint;
      repinned.applicationInspectionFingerprint = paired.plan.application.inspectionFingerprint;
    }
    for (const requirement of repinned.requirements ?? []) {
      for (const ref of requirement?.evidence ?? []) {
        if (!ref || typeof ref !== 'object' || ref.kind !== 'source.artifact') continue;
        let actual;
        try {
          actual = createHash('sha256').update(readFile(join(root, ref.path), 'utf8')).digest('hex');
        } catch (error) {
          return fail(`${relative} cites ${ref.path}, which cannot be read: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (ref.sha256 !== actual) {
          drifted.push(`${relative}#source.artifact ${ref.path}`);
          ref.sha256 = actual;
        }
      }
    }
    const checkedEvidence = validateImplementationEvidence(repinned);
    if (!checkedEvidence.valid) {
      return fail(`the repinned ${relative} is invalid: ${checkedEvidence.problems.map((problem) => problem.message).join('; ')}`);
    }
    if (paired !== null) {
      if (raw.planFingerprint !== repinned.planFingerprint) drifted.push(`${relative}#planFingerprint`);
      if (raw.applicationInspectionFingerprint !== repinned.applicationInspectionFingerprint) {
        drifted.push(`${relative}#applicationInspectionFingerprint`);
      }
    }
    pending.set(relative, canonicalBytes(repinned));
  }

  if (check) {
    if (drifted.length === 0) {
      out('repin-example-pins --check: every example pin binds its live authority.\n');
      return { exitCode: 0, compositionFingerprints, drifted, wrote: [] };
    }
    err('repin-example-pins --check: the example pins drifted from their live authorities:\n');
    for (const field of drifted) err(`  drifted ${field}\n`);
    err('Run `npm run repin:example-pins` and commit the rewritten files.\n');
    return { exitCode: 1, compositionFingerprints, drifted, wrote: [] };
  }

  /** @type {string[]} */
  const wrote = [];
  for (const [relative, bytes] of pending) {
    const current = readFile(join(root, relative), 'utf8');
    if (current !== bytes) {
      writeFileSync(join(root, relative), bytes);
      wrote.push(relative);
    }
  }
  for (const relative of verifier.wrote) {
    if (!wrote.includes(relative)) wrote.push(relative);
  }
  if (wrote.length === 0) {
    out('repin-example-pins: every example pin is already current; nothing written.\n');
  } else {
    out(`repin-example-pins: repinned ${wrote.length} file(s): ${wrote.join(', ')}.\n`);
  }
  return { exitCode: 0, compositionFingerprints, drifted, wrote };
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/repin-example-pins.js [--check] [--root <dir>]\n');
    process.exit(0);
  }
  const root = flagValue(argv, '--root');
  if (root !== null && root === '') {
    process.stderr.write('repin-example-pins: a flag value is missing.\n');
    process.exit(2);
  }
  const result = await repinExamplePins({
    ...(root !== null ? { rootDir: root } : {}),
    check: argv.includes('--check'),
  });
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`repin-example-pins: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
