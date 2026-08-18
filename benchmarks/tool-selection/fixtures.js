// @ts-check

/**
 * Isolated project states, and the proof that a run did not inherit one.
 *
 * A benchmark of *selection* is worthless if the thing being selected against drifts
 * between runs. So a fixture is a deterministic function of the checkout: a declared
 * copy of this repository with a declared overlay applied, fingerprinted before the
 * agent is handed it and fingerprinted again afterwards. The pair is what makes
 * "premature mutation" an observation instead of an opinion.
 *
 * ## Three refusals, and each one is load-bearing
 *
 * **The benchmark's own artifacts are never copied into a fixture.** A fixture that
 * contains the protocol, the prompt matrix or the expected rails hands the agent the
 * answer sheet, and every number from that run is worthless. `DENY` excludes them —
 * and because a deny-list is exactly the kind of thing that silently rots when a file
 * moves, `verifyIsolation()` re-scans the materialised tree for literal markers
 * afterwards. The deny-list is the intent; the scan is the gate.
 *
 * **A fixture is rebuilt, never reused.** `materializeFixture` refuses a target that
 * already exists, and the runner builds one per cell into a directory that must not
 * exist either. There is deliberately no reset function: resetting means destroying the
 * directory and calling this again, and a helper that wrapped those two lines existed
 * for a while with no production caller at all, while the protocol described it as an
 * enforced guarantee. No run inherits from another because no run can reuse a tree.
 *
 * **A fixture is scratch, and it is outside the checkout.** The target must not
 * resolve inside the framework repository, for the reason `benchmarks/harness/
 * prepare.js` already gives: a run built inside the repository dirties the tree its
 * own fingerprint describes.
 *
 * ## What a fixture is not
 *
 * It is not installed. `node_modules` is never copied and nothing runs `npm install`,
 * so a command the agent selects will usually fail to execute. That is deliberate and
 * it is a stated limitation rather than a defect: this instrument observes **which
 * rail an agent reaches for**, not whether the command then succeeded. A selection
 * followed by an execution failure is a scoreable observation; the protocol says so
 * in `Limitations`, and `dependenciesInstalled` records the operator's choice when a
 * run does install.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { inspectionFingerprint } from '../../packages/core/src/solution-plan.js';

/** Bounds. An oversized fixture fails as an explained refusal, never as a hang. */
export const MAX_FIXTURE_FILES = 6_000;
export const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;

/**
 * Real, shipped domains — not fixture-only inventions. A fixture composed of packages
 * this repository actually merged is a project an agent could plausibly meet; a
 * synthetic one teaches the instrument to measure a world that does not exist.
 *
 * An empty composition was worse than incomplete: the protocol names duplicate-domain
 * invention as a failure mode it tests, and in a composition of zero packages that
 * failure mode cannot occur. It also made `missing-custom-package` byte-identical to
 * `clean-valid`, so TS-04 had no fixture at all.
 */
export const COMPOSED_DOMAINS = Object.freeze([
  { directory: 'contracts', factory: 'createContractsDomain' },
  // TS-09 asks about restructuring lead scoring; without this the prompt names something
  // the fixture does not contain.
  { directory: 'intelligence', factory: 'createIntelligenceDomain' },
  { directory: 'service', factory: 'createServicePackage' },
  { directory: 'lifecycle', factory: 'createLifecyclePackage' },
  { directory: 'work', factory: 'createWorkPackage' },
  { directory: 'delivery', factory: 'createDeliveryPackage' },
]);

/**
 * Passages that describe **what this benchmark grades**, removed from every fixture.
 *
 * The soft-marker argument — "the repository mentions its own work, and doctoring that
 * would make the fixture unfaithful in a less visible way" — is sound for a mention. It is
 * not sound for a *rubric*. `docs/CODER_TOOLING_ROADMAP.md` says the instrument "observes
 * whether a coding agent given a job-shaped prompt selects the right rail, in the right
 * order, without premature mutation": three of the four graded dimensions, in order, in
 * one sentence. `TASKS.md` describes the fixtures, the denominator rule and the leak scan.
 * And `AGENTS.md` and `CLAUDE.md` route every arm to `TASKS.md` on the first read.
 *
 * "No prompt-to-rail mapping appears in a fixture" was literally true and beside the
 * point: an agent does not need to be told which rail TS-03 wants if it has been told that
 * rail choice, ordering and restraint are what is being watched.
 *
 * So the passages are cut, by exact anchor, from every fixture — and the strings they
 * contain are hard markers, so a new one that appears anywhere invalidates the run rather
 * than being counted and shrugged at. Each cut is recorded in the receipt.
 */
export const REDACTIONS = Object.freeze([
  {
    path: 'TASKS.md',
    anchor: 'Pilot the AX3 tool-selection instrument',
    why: 'describes the instrument\'s fixtures, denominator rule and leak scan',
  },
  {
    path: 'docs/CODER_TOOLING_ROADMAP.md',
    anchor: 'One AX3 instrument exists and is a',
    why: 'names three of the four graded dimensions, in order, in one sentence',
  },
]);

/** The declared-current plan, and the only file `rebind` is allowed to touch. */
export const DECLARED_PLAN = 'examples/solution-plans/lead-to-won.plan.json';

/**
 * The checked-in registry source for a composition. Deterministic in the order given,
 * because the fixture's fingerprint depends on these bytes.
 * @param {ReadonlyArray<{ directory: string, factory: string }>} domains
 */
export function compositionSource(domains) {
  return [
    '// @ts-check',
    '',
    '// Generated composition for an isolated project state. Real shipped domains,',
    '// composed so that discovery has something to discover.',
    '//',
    '// This comment deliberately names nothing about how the state was produced. It used',
    '// to, and that made the fixture builder the *author* of a residual disclosure rather',
    '// than the inheritor of one: the justification for keeping the roadmap and task-list',
    '// mentions is that doctoring a real repository would be the less honest edit, and it',
    '// covers nothing that this instrument writes into the tree itself.',
    '',
    ...domains.map((d) => `import { ${d.factory} } from '../../${d.directory}/src/index.js';`),
    '',
    'export const generatedDomains = [',
    ...domains.map((d) => `  ${d.factory}(),`),
    '];',
    '',
  ].join('\n');
}

/**
 * Never copied. The first group is weight and generated state; the second is the
 * benchmark itself, and copying any of it would leak the expected answers.
 */
export const DENY = Object.freeze([
  '.git', 'node_modules', 'data', '.github', 'site/dist', 'coverage',
  // Exactly this benchmark's own artifacts, and nothing more. The first draft denied
  // `benchmarks/` and `docs/benchmarks/` wholesale, which removed the Edition L harness
  // and the JTBD matrix — real repository content that other documents link to. The
  // result was a `clean-valid` fixture that was not clean: `project doctor` reported a
  // broken link out of README.md, in a fixture whose whole purpose is to have nothing
  // wrong with it. A deny-list wide enough to break the thing it is protecting is a
  // deny-list that changes the experiment.
  'benchmarks/tool-selection',
  'docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md',
  'docs/benchmarks/TOOL_SELECTION_PILOT_2026-08-13.md',
  'docs/plans/agent-tool-selection-benchmark.md',
  'tests/agent-tool-selection-prompts.test.js',
  'tests/agent-tool-selection-contract.test.js',
  'tests/agent-tool-selection-scoring.test.js',
]);

/**
 * Literal strings that must not appear anywhere in a materialised fixture. These are
 * the benchmark's own identifiers; finding one means the deny-list missed something
 * and the run is `INVALID_ISOLATION`, not a low score.
 */
export const LEAK_MARKERS = Object.freeze([
  'agentToolSelectionRunContract',
  'toolSelectionPromptSet',
  'expectedFirstFamilies',
  'wrongRailAttractor',
  'expectedRail',
]);

/**
 * Weaker disclosures: strings that tell an agent this repository *has* a
 * tool-selection benchmark, without telling it what the benchmark expects.
 *
 * A fixture is a copy of a real repository, and a real repository mentions its own
 * work in its task list. Doctoring `TASKS.md` to remove that mention would make the
 * fixture unfaithful in a different and less visible way, so the mention stays and is
 * **counted**. A soft marker is published in the receipt as a residual disclosure; it
 * does not invalidate a run, and pretending it does not exist is the only handling
 * that would be dishonest.
 */
export const SOFT_MARKERS = Object.freeze([
  'tool-selection benchmark',
  'tool selection benchmark',
]);

/**
 * Promoted out of the soft list. Each of these names the instrument's own documents or the
 * instrument itself in a passage that describes what it grades; the `redact` overlay cuts
 * the two passages that carry them, and finding one afterwards means a third passage has
 * appeared that nobody has read.
 */
export const RUBRIC_MARKERS = Object.freeze([
  'tool-selection instrument',
  'AGENT_TOOL_SELECTION_PROTOCOL',
  'TOOL_SELECTION_PILOT',
  'selects the right rail, in the right order',
]);

/*
 * The line between the two lists is *what the string carries*, not where it lives.
 *
 * A hard marker carries an answer: `expectedFirstFamilies`, `expectedRail` and
 * `wrongRailAttractor` are the protocol's opinion about what an agent should do, and
 * `agentToolSelectionRunContract` and `toolSelectionPromptSet` name the documents that
 * hold it. Any of them inside a fixture invalidates the run.
 *
 * A soft marker only says the benchmark exists. The roadmap points at the protocol by
 * filename and the task list mentions the instrument, because a repository that hid its
 * own work from its own roadmap would be a stranger fixture than one that does not. Note
 * that the protocol document itself carries hard markers regardless — so if the
 * deny-list ever stops excluding `docs/benchmarks/`, the scan still catches it.
 */

/**
 * The seven project states. Each names the job family it exists for and what an agent
 * is supposed to find in it.
 *
 * Two of them apply no overlay, and that is the honest shape rather than an oversight.
 * `missing-custom-package` is *defined* by an absence — grant management is not in the
 * composition — and removing a shipped package to manufacture the absence would
 * produce a broken composition instead, which is a different fixture answering a
 * different question. `valid-scenarios` is the clean state because the checkout
 * already ships the scenario documents the prompt is about. Both therefore fingerprint
 * identically to `clean-valid`, which is what a fingerprint means and is recorded
 * rather than disguised.
 */
export const FIXTURES = Object.freeze([
  {
    id: 'clean-valid',
    title: 'a healthy checkout with nothing wrong in it, composing five real domains',
    expectedSignal: 'diagnosis passes; the composition loads with five packages',
    overlay: [],
  },
  {
    id: 'structural-drift',
    title: 'two harness mirrors of one Skill that no longer say the same thing',
    expectedSignal: 'a mirror-drift failure from the diagnosis rail',
    overlay: [
      {
        op: 'append',
        path: '.claude/skills/create-crm-module/SKILL.md',
        text: '\n<!-- fixture drift: this line exists in the Claude mirror only, so the two copies of one canonical Skill now say different things. -->\n',
      },
    ],
  },
  {
    // This is one of the two states the repository does not already exhibit, which is
    // why it carries an overlay at all. A naturally stale plan is already checked in
    // (`govern-delivery-change`), but a *declared-current* plan that has gone stale is
    // the sharper case and the one the prompt describes, so the overlay moves the
    // binding of the plan `package.json` declares current.
    id: 'stale-plan',
    title: 'a written intent still declared current, bound to a composition that has moved',
    expectedSignal: 'the plan rail reports the binding no longer matches',
    overlay: [
      {
        op: 'rewrite-json',
        path: 'examples/solution-plans/lead-to-won.plan.json',
        // A binding fingerprint the composition cannot produce. The value is a
        // constant, not a random one, so the fixture is reproducible.
        pointer: ['application', 'inspectionFingerprint'],
        value: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    ],
  },
  {
    id: 'missing-custom-package',
    title: 'a populated checkout that models nothing resembling the requested domain',
    expectedSignal: 'discovery shows four domains and no grant management; a conforming empty start is the safe move',
    // No longer derived from `clean-valid`: it composes a strict subset, so the two are
    // genuinely different states. While both were empty they fingerprinted identically,
    // and TS-04 could not distinguish "this exists, do not rebuild it" from "this is
    // genuinely absent" — which is the only discrimination TS-04 asks for.
    composition: COMPOSED_DOMAINS.filter((domain) => domain.directory !== 'delivery'),
    overlay: [],
  },
  {
    id: 'non-conforming-package',
    title: 'a hand-written domain package that breaks the package contract',
    expectedSignal: 'package test exits 1 with exactly one failed check, boundary.private-import',
    overlay: [
      {
        op: 'write',
        path: 'packages/insurance-claims/src/index.js',
        text: [
          '// A deliberately non-conforming domain package. It is NOT registered in',
          '// packages/domains/generated/index.js, so a checkout carrying it still boots:',
          '// the fixture is about what conformance says, not about a broken application.',
          '//',
          '// It reaches past the one import a package is allowed, importing another',
          "// package's private source rather than a declared capability. Observed",
          '// 2026-08-13: package test exits 1 with exactly one failed check,',
          "// boundary.private-import, 'reaches a private kernel path: src/index.js'.",
          '//',
          '// An earlier draft also claimed that declaring no capabilities, resources or',
          '// policies was a second violation. Running it showed otherwise: conformance',
          '// reports inspection.capabilities as not_applicable, because an empty domain is',
          '// vacuous rather than non-conforming. The declaration below stays empty, and the',
          '// claim that it breaks the contract does not — a fixture may only assert what',
          '// its rail actually said.',
          "import { createHash } from 'node:crypto';",
          "import { canonicalJson } from '../../core/src/solution-plan.js';",
          '',
          '// It carries `packageContract` so the registry recognises it as a package at all.',
          '// Without that the conformance run stops at "No package definition found" — an',
          '// earlier and different failure, which is what this fixture used to produce.',
          'export const insuranceClaims = {',
          '  packageContract: 1,',
          "  name: 'insurance-claims',",
          '  version: 1,',
          "  label: 'Insurance claims',",
          "  description: 'A domain a teammate started and did not finish.',",
          '  capabilities: [],',
          '  resources: [],',
          '  actions: [],',
          '  policies: [],',
          '  metadata: () => ({}),',
          '  fingerprint: () => createHash(\'sha256\').update(canonicalJson({})).digest(\'hex\'),',
          '};',
          '',
          '// Exactly one definition export. A default alongside the named one counts as two',
          '// and stops the run before conformance, which is a different failure again.',
          '',
        ].join('\n'),
      },
      {
        op: 'write',
        path: 'packages/insurance-claims/README.md',
        text: '# insurance-claims\n\nA teammate started this and did not finish it.\n',
      },
    ],
  },
  {
    id: 'valid-scenarios',
    title: 'a healthy checkout that already ships runnable business journeys',
    expectedSignal: 'a business journey can be exercised, with its own stated limits',
    derivedFrom: 'clean-valid',
    overlay: [],
  },
  {
    // No overlay, and that is the point. The gap is **already checked in**:
    // `examples/solution-plans/govern-delivery-change.plan.json` has no evidence
    // document, because no shipped scenario composes the application it was written
    // against, and `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` records the decision
    // not to invent one. Manufacturing a gap by deleting a real evidence document
    // would have produced a *different*, easier state — a plan whose proof merely went
    // missing — and hidden the harder one this repository actually has.
    id: 'implementation-evidence-gap',
    title: 'a checked-in written intent that no evidence document can honestly cite',
    expectedSignal: 'requirement-level proof cannot be produced, and the rail says so rather than passing',
    derivedFrom: 'clean-valid',
    overlay: [],
  },
]);

/**
 * The files this checkout tracks, as repository-relative paths. Read from git, because a
 * directory listing answers a different question — it includes build output, editor
 * droppings and anything an earlier command wrote.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function trackedFiles(repoRoot) {
  const listed = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const files = listed.split('\0').filter(Boolean).sort();
  if (files.length === 0) {
    throw new Error(
      `trackedFiles: git lists no tracked file under ${repoRoot}. A fixture is a copy of a checkout; `
      + 'refusing rather than copying a directory whose contents nothing accounts for.',
    );
  }
  return files;
}

/**
 * How many tracked files differ from what is committed. Zero means the fixture can be
 * rebuilt from the base commit alone; anything else is a fact a receipt should carry
 * rather than a reason to refuse — a person testing a change needs to run this.
 * @param {string} repoRoot
 */
export function uncommittedTrackedFiles(repoRoot) {
  const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no', '-z'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return status.split('\0').filter((entry) => entry.trim() !== '').length;
}

/** @param {string} id */
export function fixtureById(id) {
  return FIXTURES.find((fixture) => fixture.id === id) ?? null;
}

/**
 * Build one fixture into a scratch directory.
 *
 * @param {string} fixtureId
 * @param {string} targetDir must not exist, and must not resolve inside `repoRoot`
 * @param {{ repoRoot: string }} options
 */
export function materializeFixture(fixtureId, targetDir, { repoRoot }) {
  const fixture = fixtureById(fixtureId);
  if (!fixture) throw new Error(`materializeFixture: unknown fixture "${fixtureId}"`);

  const root = realpathSync(repoRoot);
  const target = resolve(targetDir);
  if (target === root || target.startsWith(root + sep)) {
    throw new Error(
      `materializeFixture: refusing to build inside the framework checkout (${target}). A fixture built `
      + 'inside the repository dirties the tree its own fingerprint describes, and the agent ends up '
      + 'working on top of the framework instead of in a copy of it.',
    );
  }
  if (existsSync(target)) {
    throw new Error(
      `materializeFixture: refusing to reuse an existing directory (${target}). A fixture is rebuilt, `
      + 'never topped up — reuse is how one run inherits the previous run\'s mutations.',
    );
  }

  mkdirSync(target, { recursive: true });
  // The file *set* is the checkout's, taken from git rather than from the directory.
  //
  // Copying the directory copied whatever the last command left behind:
  // `site/.used-claims.json` is generated by the GTM check and git-ignored, and it was
  // landing in every fixture — so running `npm run verify` silently changed what every
  // fixture fingerprint was a fingerprint of. A fixture that depends on which commands
  // somebody happened to run is not a deterministic function of anything, and the failure
  // is invisible: the tree looks right and the number moves.
  //
  // File *contents* still come from the working tree, so an uncommitted edit to a tracked
  // file is honoured — that is what a person testing a change expects — and the count of
  // such files is returned so a receipt can say the fixture was not built from a clean
  // commit.
  const copied = [];
  for (const rel of trackedFiles(root)) {
    if (DENY.some((denied) => rel === denied || rel.startsWith(denied + sep) || rel.startsWith(denied + '/'))) continue;
    const source = join(root, rel);
    // Tracked but deleted in the working tree: skipped, not fabricated.
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    cpSync(source, join(target, rel), { dereference: false });
    copied.push(rel);
  }
  if (copied.length === 0) {
    throw new Error(
      `materializeFixture: nothing was copied from ${root}. A fixture with no repository in it would pass `
      + 'every prompt that asks the agent to look at the project.',
    );
  }

  // Composition is the fixture set's *baseline*, not one fixture's overlay. Every fixture
  // is a project that composes real domains, because a project composing nothing cannot
  // exhibit the failure modes this benchmark tests — duplicate-domain invention among
  // them. Applying it here rather than per fixture keeps the property the set already
  // relied on: a fixture with an empty overlay fingerprints identically to `clean-valid`.
  for (const step of baseOverlay(fixture)) applyOverlayStep(target, step);
  for (const step of fixture.overlay) applyOverlayStep(target, step);

  const fingerprint = fingerprintTree(target);
  return {
    fixtureId,
    targetDir: target,
    fingerprint: fingerprint.fingerprint,
    files: fingerprint.files,
    bytes: fingerprint.bytes,
    source: { copied: copied.length, uncommittedTrackedFiles: uncommittedTrackedFiles(root) },
  };
}

/**
 * The steps every fixture gets before its own: write the composition it declares, then
 * re-pin the declared-current plan against it. A fixture may narrow the composition
 * (`missing-custom-package` does) but none may skip it.
 * @param {any} fixture
 */
function baseOverlay(fixture) {
  const domains = fixture.composition ?? COMPOSED_DOMAINS;
  return [
    { op: 'write', path: 'packages/domains/generated/index.js', text: compositionSource(domains) },
    ...REDACTIONS.map((redaction) => ({ op: 'redact', ...redaction })),
    { op: 'rebind', path: DECLARED_PLAN },
  ];
}

/** @param {string} target @param {any} step */
function applyOverlayStep(target, step) {
  const path = join(target, step.path);
  if (!path.startsWith(target + sep)) throw new Error(`overlay: path escapes the fixture: ${step.path}`);
  switch (step.op) {
    case 'write':
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.text);
      return;
    case 'append':
      if (!existsSync(path)) throw new Error(`overlay: cannot append to a missing file: ${step.path}`);
      writeFileSync(path, readFileSync(path, 'utf8') + step.text);
      return;
    case 'delete':
      if (!existsSync(path)) throw new Error(`overlay: cannot delete a missing file: ${step.path}`);
      rmSync(path);
      return;
    case 'rewrite-json': {
      if (!existsSync(path)) throw new Error(`overlay: cannot rewrite a missing file: ${step.path}`);
      const document = JSON.parse(readFileSync(path, 'utf8'));
      let cursor = document;
      for (const key of step.pointer.slice(0, -1)) {
        if (cursor?.[key] === undefined) throw new Error(`overlay: pointer misses in ${step.path}: ${step.pointer.join('.')}`);
        cursor = cursor[key];
      }
      const leaf = step.pointer[step.pointer.length - 1];
      if (cursor?.[leaf] === undefined) throw new Error(`overlay: pointer misses in ${step.path}: ${step.pointer.join('.')}`);
      cursor[leaf] = step.value;
      writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
      return;
    }
    case 'redact': {
      // Remove the paragraph the anchor sits in, and nothing else. A paragraph is the
      // right unit: the roadmap's rubric sentence spans four lines and the task-list entry
      // is one long bullet, and cutting a line out of either would leave a fragment that
      // reads as damage rather than as absence.
      if (!existsSync(path)) throw new Error(`overlay: cannot redact a missing file: ${step.path}`);
      const original = readFileSync(path, 'utf8');
      const paragraphs = original.split(/\n\n/);
      const kept = paragraphs.filter((paragraph) => !paragraph.includes(step.anchor));
      if (kept.length === paragraphs.length) {
        throw new Error(
          `overlay: redaction anchor not found in ${step.path}: "${step.anchor}". The passage this `
          + 'fixture exists to remove has moved or been reworded, and a redaction that silently '
          + 'removes nothing would hand the agent the rubric.',
        );
      }
      writeFileSync(path, kept.join('\n\n'));
      return;
    }
    case 'rebind': {
      // Re-pin the declared-current plan against the composition that was just written.
      //
      // Deliberately narrow, and the narrowness is the safety property: it accepts only
      // `DECLARED_PLAN`, writes only `application.inspectionFingerprint`, and derives the
      // value from the framework's own inspection of the materialised tree rather than
      // from a hard-coded hash that would rot on the next package change. Anything wider
      // is a fixture-authoring tool, and the next person would use it as one.
      if (step.path !== DECLARED_PLAN) {
        throw new Error(`overlay: rebind may only re-pin ${DECLARED_PLAN}, not ${step.path}`);
      }
      if (!existsSync(path)) throw new Error(`overlay: cannot rebind a missing plan: ${step.path}`);

      const inspected = execFileSync(
        process.execPath,
        [join(target, 'packages/cli/bin/accordo.js'), 'app', 'inspect', '--json'],
        { cwd: target, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const report = JSON.parse(inspected);
      const bound = inspectionFingerprint(report);
      if (typeof bound !== 'string' || bound.length !== 64) {
        throw new Error(`overlay: rebind computed no usable composition fingerprint for ${step.path}`);
      }

      const document = JSON.parse(readFileSync(path, 'utf8'));
      if (document?.application?.inspectionFingerprint === undefined) {
        throw new Error(`overlay: rebind found no application.inspectionFingerprint in ${step.path}`);
      }
      document.application.inspectionFingerprint = bound;
      writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
      return;
    }
    default:
      throw new Error(`overlay: unknown op ${step.op}`);
  }
}

/**
 * The fixture's identity: every file's path and content hash, canonically ordered.
 * Two runs of the same fixture on the same commit produce the same value; one edited
 * byte anywhere produces a different one.
 *
 * @param {string} dir
 */
export function fingerprintTree(dir) {
  /** @type {string[]} */
  const entries = [];
  let bytes = 0;
  let files = 0;

  /**
   * `lstatSync`, never `statSync`, and every entry contributes its **type and mode** as
   * well as its bytes.
   *
   * `statSync` follows a symlink, so a dangling one threw ENOENT out of the fingerprint —
   * which runs after the agent has finished and before the receipt is written, so one
   * `ln -s /nowhere x` ended the runner with exit 2, no receipt at all, and a planned cell
   * gone from the denominator without a document saying why. That is the failure this
   * whole instrument encodes a lesson against, arriving through the file system.
   *
   * Hashing type and mode closes the other half: a file replaced by a symlink to itself,
   * or made executable, changed the tree in a way a content-only digest called identical.
   * Empty directories are entries too, because `mkdir -p src/generated` is a mutation.
   * @param {string} current
   */
  const walk = (current) => {
    const names = readdirSync(current).sort();
    if (names.length === 0 && current !== dir) {
      entries.push(`${relative(dir, current).split(sep).join('/')}/\0<empty-directory>`);
    }
    for (const name of names) {
      const path = join(current, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) { walk(path); continue; }
      files += 1;
      bytes += stats.size;
      if (files > MAX_FIXTURE_FILES) {
        throw new Error(
          `fingerprintTree: more than ${MAX_FIXTURE_FILES} files under ${dir}. Refusing rather than `
          + 'sampling: a fingerprint over part of a tree would compare equal across a real mutation.',
        );
      }
      if (bytes > MAX_FIXTURE_BYTES) {
        throw new Error(`fingerprintTree: fixture exceeds ${MAX_FIXTURE_BYTES} bytes. Refusing rather than truncating.`);
      }
      const relativePath = relative(dir, path).split(sep).join('/');
      const mode = (stats.mode & 0o7777).toString(8);
      if (stats.isSymbolicLink()) {
        // The link itself is the content. Whether it resolves is not this function's
        // business, and asking would reintroduce the crash.
        const target = createHash('sha256').update(readlinkSync(path)).digest('hex');
        entries.push(`${relativePath}\0symlink\0${mode}\0${target}`);
        continue;
      }
      if (!stats.isFile()) {
        // A socket, a fifo, a device node: recorded as present, with its type, and never
        // opened.
        entries.push(`${relativePath}\0other\0${mode}\0<not-a-regular-file>`);
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      entries.push(`${relativePath}\0file\0${mode}\0${digest}`);
    }
  };
  walk(dir);

  return {
    fingerprint: createHash('sha256').update(entries.sort().join('\n')).digest('hex'),
    files,
    bytes,
  };
}

/**
 * Prove the fixture the agent was handed carries none of this benchmark's answers.
 *
 * @param {string} dir
 * @returns {{ status: 'clean' | 'leaked', markersScanned: number, findings: Array<{ marker: string, path: string }>, residualDisclosures: Array<{ marker: string, path: string }> }}
 */
export function verifyIsolation(dir) {
  /** @type {Array<{ marker: string, path: string }>} */
  const findings = [];
  /** @type {Array<{ marker: string, path: string }>} */
  const residualDisclosures = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) { walk(path); continue; }
      // A symlink is not read: following one would both crash on a dangling link and
      // scan a file outside the fixture, which is somebody else's content.
      if (!stats.isFile()) continue;
      let text;
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      const relativePath = relative(dir, path).split(sep).join('/');
      for (const marker of [...LEAK_MARKERS, ...RUBRIC_MARKERS]) {
        if (text.includes(marker)) findings.push({ marker, path: relativePath });
      }
      for (const marker of SOFT_MARKERS) {
        if (text.toLowerCase().includes(marker)) residualDisclosures.push({ marker, path: relativePath });
      }
    }
  };
  walk(dir);
  return {
    status: findings.length === 0 ? 'clean' : 'leaked',
    markersScanned: LEAK_MARKERS.length + RUBRIC_MARKERS.length + SOFT_MARKERS.length,
    findings,
    residualDisclosures,
  };
}

