// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, posix as posixPath, relative, sep } from 'node:path';
import { readModuleState } from '../../core/src/module-evolution.js';
import { PRIVATE_IMPORT_RE, packageSources } from './package-sources.js';
import { repoRelative, safeMessage } from './safe-text.js';

/**
 * The individual checks `crm project doctor` runs.
 *
 * Two rules shape every function here, and they are why the file is boring.
 *
 * **Each check names an authority.** Not "the doctor thinks this is wrong" but
 * "`module-evolution` refuses this", "the composition refuses this", "git says
 * this file is tracked". A diagnostic that invents its own opinion is a second
 * source of truth, and the moment it disagrees with the runtime the runtime is
 * right and the tool is noise. DX4 learned this the expensive way; the same
 * `authority` field is used here for the same reason.
 *
 * **Nothing here imports project source.** Composition health comes from AX1,
 * which already loads the project in an isolated child; everything else in this
 * file reads text, JSON and `git ls-files`. That is what lets the doctor be
 * fast and lets it run on a project that will not even boot — which is exactly
 * when you want it.
 */

/** The authorities a finding may cite. A check with no authority is a bug. */
export const AUTHORITIES = Object.freeze([
  'app-inspect', 'solution-plan', 'module-evolution', 'authoring-rule', 'skill-mirror', 'docs-link', 'git',
]);

/** Every status a check may report. `warning` never fails the run. */
export const STATUSES = Object.freeze(['passed', 'warning', 'failed', 'not_applicable']);

/**
 * @param {{id: string, category: string, status: string, authority: string,
 *   subject?: string|null, evidence?: any, reason?: string|null, remediation?: string|null}} input
 */
export function check({ id, category, status, authority, subject = null, evidence = null, reason = null, remediation = null }) {
  if (!STATUSES.includes(status)) throw new Error(`project doctor: unknown status "${status}" for ${id}`);
  if (!AUTHORITIES.includes(authority)) throw new Error(`project doctor: check ${id} cites no known authority`);
  return { id, category, status, authority, subject, evidence, reason, remediation };
}

/** Sorted by id so two runs of the same project produce the same document. */
export function sortChecks(checks) {
  return [...checks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** @param {string} value */
function posix(value) {
  return value.split(sep).join('/');
}

/**
 * Directories, sorted, skipping dotted names and `node_modules`. Sorted because
 * a scan that follows the filesystem reports a different first failure on a
 * different machine.
 *
 * @param {string} dir
 */
function directories(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// composition — AX1 is the authority, and this only reads its report
// ---------------------------------------------------------------------------

/**
 * Composition health, entirely from the AX1 report. Nothing here re-derives a
 * collision, a missing capability or a cycle: `crm app inspect` already answers
 * that, in an isolated child, and a second implementation would be a second
 * thing to keep true.
 *
 * @param {{report: any, failure: string|null}} input
 */
export function compositionChecks({ report, failure }) {
  if (!report) {
    return [check({
      id: 'composition.valid',
      category: 'composition',
      status: 'failed',
      authority: 'app-inspect',
      reason: failure ?? 'the project composition could not be read',
      remediation: 'npm run crm -- app inspect --json',
    })];
  }

  const problems = report.problems ?? [];
  const checks = [check({
    id: 'composition.valid',
    category: 'composition',
    status: problems.length === 0 ? 'passed' : 'failed',
    authority: 'app-inspect',
    evidence: { problems: problems.length, packages: (report.packages ?? []).length },
    reason: problems.length === 0 ? null : `the composition reports ${problems.length} problem(s)`,
    remediation: problems.length === 0 ? null : 'npm run crm -- app inspect --json',
  })];

  // Every AX1 problem travels as its own row, with AX1's own code, so a reader
  // fixes the named edge rather than re-running inspect to find out which.
  for (const problem of problems) {
    checks.push(check({
      id: `composition.problem.${String(problem.code ?? 'unknown').toLowerCase()}`,
      category: 'composition',
      status: 'failed',
      authority: 'app-inspect',
      subject: typeof problem.subject === 'string' ? problem.subject : null,
      evidence: { code: problem.code },
      reason: typeof problem.message === 'string' ? problem.message.slice(0, 400) : null,
      remediation: 'npm run crm -- app inspect --json',
    }));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// packages — source-only. Importing a package is what `package test` is for.
// ---------------------------------------------------------------------------

/** Where a package may live by documented convention. */
const PACKAGE_ROOTS = ['packages', 'examples/custom-packages'];

/**
 * A directory whose `src/index.js` calls `definePackage` is a domain package.
 *
 * The discriminator matters more than it looks. An earlier draft took "has a
 * `src/index.js` under `packages/`" as the rule, which swept in `packages/app`,
 * `packages/sdk`, `packages/mcp`, `packages/providers` and `packages/workflows`
 * — kernel code, which imports `core/src` because it *is* the core — and the
 * boundary check then reported eight violations in a repository that has none.
 * A diagnostic whose first output is a false positive is a diagnostic people
 * turn off.
 *
 * `definePackage` is the package contract's own entry point, so this is the
 * contract's discriminator rather than a naming convention invented here. It is
 * matched as text: reading a package must never mean importing it.
 *
 * @param {string} rootDir
 */
export function discoverPackages(rootDir) {
  const found = [];
  for (const root of PACKAGE_ROOTS) {
    for (const name of directories(join(rootDir, root))) {
      const dir = join(rootDir, root, name);
      const entry = join(dir, 'src', 'index.js');
      if (!existsSync(entry)) continue;
      let source;
      try { source = readFileSync(entry, 'utf8'); } catch { continue; }
      if (!DEFINE_PACKAGE_RE.test(source)) continue;
      found.push({ name, dir, path: posixPath.join(root, name) });
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** `definePackage(` however it was imported or aliased on the way in. */
const DEFINE_PACKAGE_RE = /\bdefinePackage\s*\(/;

/**
 * The one package rule that can be proved from text: no package reaches into
 * `packages/core/src`. The regex is the same one `package validate` and
 * `package test` use — imported, not copied, because ADR-018 addendum 4 records
 * what happened the last time this rule existed in two places.
 *
 * Everything else about a package needs it to be imported, which this command
 * does not do. That gap is `PACKAGE_CONFORMANCE_NOT_RUN`, and it names the
 * command that closes it.
 *
 * @param {{rootDir: string, packages: {name: string, dir: string, path: string}[], composed: string[]}} input
 */
export function packageChecks({ rootDir, packages, composed }) {
  if (packages.length === 0) {
    return [check({
      id: 'packages.source-boundary',
      category: 'packages',
      status: 'not_applicable',
      authority: 'authoring-rule',
      reason: 'NO_PACKAGES_DISCOVERED',
    })];
  }

  const violations = [];
  const unreadable = [];
  for (const pkg of packages) {
    let sources;
    try {
      sources = packageSources(pkg.dir);
    } catch (error) {
      unreadable.push({ package: pkg.path, detail: safeMessage(error, rootDir) });
      continue;
    }
    for (const file of sources) {
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch (error) {
        unreadable.push({ package: pkg.path, detail: safeMessage(error, rootDir) });
        continue;
      }
      if (PRIVATE_IMPORT_RE.test(source)) violations.push(repoRelative(rootDir, file));
    }
  }

  const checks = [check({
    id: 'packages.source-boundary',
    category: 'packages',
    status: violations.length === 0 ? 'passed' : 'failed',
    authority: 'authoring-rule',
    evidence: { scanned: packages.length, violations: violations.sort() },
    reason: violations.length === 0 ? null : `${violations.length} file(s) import a private kernel path`,
    remediation: violations.length === 0 ? null
      : 'Import from packages/core/index.js only; if what you need is not exported, raise it as a missing public export.',
  })];

  if (unreadable.length > 0) {
    checks.push(check({
      id: 'packages.readable',
      category: 'packages',
      status: 'failed',
      authority: 'authoring-rule',
      evidence: { unreadable: unreadable.sort((a, b) => (a.package < b.package ? -1 : 1)) },
      reason: 'a discovered package could not be read',
      remediation: 'Check file permissions, or remove the directory if it is not a package.',
    }));
  }

  // Discovered but not composed is not a fault — `partner-scorecard` is exactly
  // that on purpose — but a reader deserves to be told which is which rather
  // than assuming everything on disk is running.
  const uncomposed = packages.filter((pkg) => !composed.includes(pkg.name)).map((pkg) => pkg.path).sort();
  checks.push(check({
    id: 'packages.composed',
    category: 'packages',
    status: 'passed',
    authority: 'app-inspect',
    evidence: { composed: [...composed].sort(), discoveredButNotComposed: uncomposed },
    reason: null,
    remediation: null,
  }));
  return checks;
}

// ---------------------------------------------------------------------------
// modules — ADR-019 is the authority, and it is the one that throws
// ---------------------------------------------------------------------------

/**
 * Module state and migration-history drift, asked of `readModuleState`.
 *
 * That function is the authority ADR-019 already gives this repository: it
 * refuses a hand-edited state file, a fingerprint that disagrees with the
 * definition it contains, a revision mismatch, an unreadable file and an
 * unsupported `stateVersion`. The doctor's whole job here is to call it for
 * every module and turn a throw into a row instead of a stack trace.
 *
 * A module with **no** state file is not a failure. It predates the file, which
 * is the documented case, and `readModuleState` handles it.
 *
 * @param {{rootDir: string}} input
 */
export function moduleChecks({ rootDir }) {
  const names = directories(join(rootDir, 'packages', 'modules')).filter((name) => name !== 'generated');
  if (names.length === 0) {
    return [check({
      id: 'modules.state',
      category: 'modules',
      status: 'not_applicable',
      authority: 'module-evolution',
      reason: 'NO_MODULES_DISCOVERED',
    })];
  }

  const drifted = [];
  const withState = [];
  for (const name of names) {
    const statePath = join(rootDir, 'packages', 'modules', name, 'module.state.json');
    const hasState = existsSync(statePath);
    try {
      const state = readModuleState(rootDir, name);
      if (state) withState.push(name);
    } catch (error) {
      drifted.push({ module: name, hasStateFile: hasState, detail: safeMessage(error, rootDir) });
    }
  }

  const checks = [check({
    id: 'modules.state',
    category: 'modules',
    status: drifted.length === 0 ? 'passed' : 'failed',
    authority: 'module-evolution',
    evidence: { modules: names.length, withStateFile: withState.sort(), drifted: drifted.sort((a, b) => (a.module < b.module ? -1 : 1)) },
    reason: drifted.length === 0 ? null : `${drifted.length} module(s) have a state file that disagrees with itself`,
    remediation: drifted.length === 0 ? null
      : 'Restore packages/modules/<name>/module.state.json from version control; it is generator output, not a file to edit.',
  })];

  // The migration history, as **inventory** rather than as a second verdict.
  //
  // An earlier draft re-derived every migration checksum here and reported a
  // mismatch as its own failure. That was wrong twice over: `readModuleState`
  // already refuses a tampered checksum — it is the authority, and it throws —
  // so the row could never fire, and if it ever had it would have been this
  // command inventing a rule the runtime owns. DX4 was fixed for exactly that.
  // What is left is what a reader actually cannot get elsewhere: which modules
  // carry a recorded history, and how long it is.
  const history = [];
  for (const name of withState) {
    let state;
    try { state = readModuleState(rootDir, name); } catch { continue; }
    history.push({ module: name, revision: state.revision, migrations: (state.migrations ?? []).map((entry) => entry.name) });
  }
  checks.push(check({
    id: 'modules.migration-history',
    category: 'modules',
    status: withState.length === 0 ? 'not_applicable' : 'passed',
    authority: 'module-evolution',
    evidence: withState.length === 0 ? null : { history },
    reason: withState.length === 0 ? 'NO_MODULE_STATE_FILES'
      : 'recorded by the generator and verified by readModuleState, which refuses a tampered checksum above',
  }));
  return checks;
}

// ---------------------------------------------------------------------------
// solution plans — AX2 is the authority, bound to the one AX1 report
// ---------------------------------------------------------------------------

/** Where a Solution Plan lives by documented convention (`docs/SOLUTION_PLAN.md`). */
const PLAN_ROOTS = ['examples/solution-plans', 'docs/solution-plans'];

/** @param {string} rootDir */
export function discoverPlans(rootDir) {
  const found = [];
  for (const root of PLAN_ROOTS) {
    const dir = join(rootDir, root);
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir).sort()) {
        if (entry.endsWith('.plan.json')) found.push({ path: posixPath.join(root, entry), file: join(dir, entry) });
      }
    } catch { /* an unreadable directory is reported by its own check */ }
  }
  return found;
}

/**
 * Plan staleness. Every discovered plan is parsed, validated and bound to the
 * **one** AX1 report this run already loaded — not to a fresh inspection each,
 * which is what `crm solution check` does per invocation and what would make
 * the doctor slower than the thing it is meant to run before.
 *
 * Plans are optional. A project with none is `not_applicable`, never a failure.
 *
 * @param {{rootDir: string, report: any, plans: {path: string, file: string}[],
 *   parse: (source: string) => any, bind: (plan: any, report: any) => any}} input
 */
export function planChecks({ rootDir, report, plans, parse, bind }) {
  if (plans.length === 0) {
    return [check({
      id: 'plans.current',
      category: 'plans',
      status: 'not_applicable',
      authority: 'solution-plan',
      reason: 'NO_SOLUTION_PLANS_FOUND',
    })];
  }

  const checks = [];
  for (const entry of plans) {
    const id = `plans.${entry.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    let plan;
    try {
      plan = parse(readFileSync(entry.file, 'utf8'));
    } catch (error) {
      checks.push(check({
        id,
        category: 'plans',
        status: 'failed',
        authority: 'solution-plan',
        subject: entry.path,
        reason: safeMessage(error, rootDir),
        remediation: `npm run crm -- solution validate ${entry.path}`,
      }));
      continue;
    }
    if (!report) {
      checks.push(check({
        id,
        category: 'plans',
        status: 'not_applicable',
        authority: 'solution-plan',
        subject: entry.path,
        reason: 'COMPOSITION_UNREADABLE',
        remediation: 'Fix the composition first; a plan can only be bound to an application that loads.',
      }));
      continue;
    }
    const bound = bind(plan, report);
    const problems = bound.problems ?? [];
    const stale = problems.some((problem) => problem.code === 'PLAN_STALE');
    checks.push(check({
      id,
      category: 'plans',
      status: problems.length === 0 ? 'passed' : stale ? 'warning' : 'failed',
      authority: 'solution-plan',
      subject: entry.path,
      evidence: { problems: problems.map((problem) => problem.code).sort() },
      reason: problems.length === 0 ? null
        : stale ? 'the plan was written against a composition that has since moved'
          : `${problems.length} plan problem(s)`,
      remediation: `npm run crm -- solution check ${entry.path} --json`,
    }));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// skill mirrors — only where the project declared mirrors at all
// ---------------------------------------------------------------------------

const SKILL_MIRRORS = ['.claude/skills', '.agents/skills'];

/**
 * Skill mirror drift.
 *
 * A project that never declared mirrors is `not_applicable` — most customer
 * projects have one harness and owe nothing to another. Where both mirror roots
 * exist, the project *has* declared them, and then two things are worth saying:
 * a skill whose two copies differ is **drift**, and a skill present in one
 * mirror only is a **gap**. Drift is worse: the copies silently disagree, and
 * whichever harness a reader is using they cannot tell.
 *
 * Nothing here syncs anything. DX2 owns that, and a doctor that edited source
 * would stop being a doctor.
 *
 * @param {{rootDir: string}} input
 */
export function skillChecks({ rootDir }) {
  const present = SKILL_MIRRORS.filter((mirror) => existsSync(join(rootDir, mirror)));
  if (present.length < 2) {
    return [check({
      id: 'skills.mirrors',
      category: 'skills',
      status: 'not_applicable',
      authority: 'skill-mirror',
      reason: present.length === 0 ? 'NO_SKILLS_DIRECTORY' : 'MIRRORS_NOT_DECLARED',
      evidence: { present },
    })];
  }

  const [primary, secondary] = SKILL_MIRRORS;
  const inPrimary = directories(join(rootDir, primary));
  const inSecondary = directories(join(rootDir, secondary));
  const drifted = [];
  const missing = [];
  const extra = inSecondary.filter((name) => !inPrimary.includes(name)).sort();

  for (const name of inPrimary) {
    const a = join(rootDir, primary, name, 'SKILL.md');
    const b = join(rootDir, secondary, name, 'SKILL.md');
    if (!existsSync(b)) { missing.push(`${secondary}/${name}/SKILL.md`); continue; }
    if (!existsSync(a)) { missing.push(`${primary}/${name}/SKILL.md`); continue; }
    try {
      if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) drifted.push(name);
    } catch (error) {
      drifted.push(`${name} (${safeMessage(error, rootDir)})`);
    }
  }

  return [
    check({
      id: 'skills.mirror-drift',
      category: 'skills',
      status: drifted.length === 0 ? 'passed' : 'failed',
      authority: 'skill-mirror',
      evidence: { compared: inPrimary.length, drifted: drifted.sort() },
      reason: drifted.length === 0 ? null : `${drifted.length} skill(s) differ between the two mirrors`,
      remediation: drifted.length === 0 ? null
        : 'Reconcile the copies by hand. Automatic syncing is DX2, which is not built; this command never edits source.',
    }),
    check({
      id: 'skills.mirror-coverage',
      category: 'skills',
      status: missing.length === 0 && extra.length === 0 ? 'passed' : 'warning',
      authority: 'skill-mirror',
      evidence: { missing: missing.sort(), onlyInSecondary: extra },
      reason: missing.length === 0 && extra.length === 0 ? null
        : `${missing.length + extra.length} skill(s) exist in one mirror only`,
      remediation: missing.length === 0 && extra.length === 0 ? null
        : 'A one-sided skill is invisible to the other harness. DX2 would close this; nothing here writes.',
    }),
  ];
}

// ---------------------------------------------------------------------------
// docs links — repository-relative only, bounded, no web and no anchors
// ---------------------------------------------------------------------------

/** Markdown link targets, ignoring images is unnecessary: a broken image is a broken link. */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Documented roots. A bounded scan, not a filesystem crawl. */
const DOC_ROOTS = ['docs', '.claude/skills', '.agents/skills'];
const ROOT_DOCS = ['README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'DECISIONS.md', 'PRODUCT.md', 'CLAUDE.md'];

/** @param {string} rootDir */
export function discoverDocs(rootDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.isDirectory())) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extname(entry.name) === '.md') found.push(full);
    }
  };
  for (const root of DOC_ROOTS) {
    const dir = join(rootDir, root);
    if (existsSync(dir)) walk(dir);
  }
  for (const name of ROOT_DOCS) {
    const file = join(rootDir, name);
    if (existsSync(file)) found.push(file);
  }
  return found.sort();
}

/**
 * Repository-relative Markdown links that do not resolve.
 *
 * Deliberately narrow. No web URL is fetched — link health on the internet is
 * not a property of this project and would make the command non-deterministic
 * and slow. No anchor is parsed: a heading-to-slug guess is wrong often enough
 * that the noise would train a reader to ignore the check. What is left is the
 * one thing a repository can prove about itself.
 *
 * @param {{rootDir: string, docs: string[]}} input
 */
export function docsChecks({ rootDir, docs }) {
  if (docs.length === 0) {
    return [check({
      id: 'docs.links',
      category: 'docs',
      status: 'not_applicable',
      authority: 'docs-link',
      reason: 'NO_DOCUMENTATION_FOUND',
    })];
  }

  const broken = [];
  for (const file of docs) {
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of source.matchAll(LINK_RE)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
      const [path] = target.split('#');
      if (path === '') continue;
      const resolved = join(file, '..', decodeURIComponent(path));
      if (!existsSync(resolved)) {
        broken.push({ document: repoRelative(rootDir, file), link: target.slice(0, 200) });
      }
    }
  }

  return [check({
    id: 'docs.links',
    category: 'docs',
    status: broken.length === 0 ? 'passed' : 'failed',
    authority: 'docs-link',
    evidence: { documents: docs.length, broken: broken.sort((a, b) => (`${a.document}${a.link}` < `${b.document}${b.link}` ? -1 : 1)) },
    reason: broken.length === 0 ? null : `${broken.length} repository-relative link(s) do not resolve`,
    remediation: broken.length === 0 ? null : 'Fix the path, or remove the link. Only repository-relative links are checked.',
  })];
}

// ---------------------------------------------------------------------------
// hygiene — git is the authority, and without git there is no answer to give
// ---------------------------------------------------------------------------

/**
 * Artifacts that must never be tracked. Conservative on purpose: every entry
 * here is already forbidden by `AGENTS.md` or `.gitignore` in this repository,
 * and a pattern that guesses would make the check something people silence.
 */
const FORBIDDEN = Object.freeze([
  { code: 'TRACKED_ENV_FILE', test: (path) => /(^|\/)\.env($|\.)/.test(path) && !/\.env\.example$/.test(path), label: 'an environment file' },
  { code: 'TRACKED_DATABASE', test: (path) => /\.sqlite(-shm|-wal)?$/.test(path), label: 'a database' },
  { code: 'TRACKED_LOG', test: (path) => /\.log$/.test(path), label: 'a log' },
  { code: 'TRACKED_DEPENDENCIES', test: (path) => /(^|\/)node_modules\//.test(path), label: 'an installed dependency tree' },
  { code: 'TRACKED_BROWSER_PROFILE', test: (path) => /(^|\/)(\.playwright|playwright-report|browser-profile|\.chromium)(\/|$)/.test(path), label: 'a browser profile or report' },
  { code: 'TRACKED_SCAFFOLD_STAGING', test: (path) => /(^|\/)\.scaffold-/.test(path), label: 'scaffold staging' },
  { code: 'TRACKED_TEMPORARY', test: (path) => /(^|\/)\.tmp\//.test(path), label: 'a temporary directory' },
]);

/**
 * Forbidden tracked artifacts, according to git.
 *
 * `git ls-files` and nothing else: the question is "is this *tracked*", and
 * only git can answer it. A project that is not a git repository gets
 * `not_applicable` with a reason — the honest answer — rather than a guess made
 * from what happens to be on disk, which would flag every ignored file every
 * developer has.
 *
 * **No file content is read.** The check is about a path being tracked. Opening
 * a tracked `.env` to describe it would be the tool leaking the very secret it
 * is complaining about.
 *
 * @param {{rootDir: string, run?: (args: string[], cwd: string) => string}} input
 */
export function hygieneChecks({ rootDir, run = defaultGit }) {
  let tracked;
  try {
    tracked = run(['ls-files', '-z'], rootDir).split('\0').filter(Boolean);
  } catch (error) {
    return [check({
      id: 'hygiene.tracked-artifacts',
      category: 'hygiene',
      status: 'not_applicable',
      authority: 'git',
      reason: 'NOT_A_GIT_REPOSITORY',
      evidence: { detail: safeMessage(error, rootDir) },
      remediation: 'Tracked-file status is a question only git can answer; this command does not guess it from disk.',
    })];
  }

  const found = [];
  for (const path of tracked) {
    for (const rule of FORBIDDEN) {
      if (rule.test(path)) found.push({ code: rule.code, path, is: rule.label });
    }
  }

  return [check({
    id: 'hygiene.tracked-artifacts',
    category: 'hygiene',
    status: found.length === 0 ? 'passed' : 'failed',
    authority: 'git',
    evidence: { tracked: tracked.length, forbidden: found.sort((a, b) => (a.path < b.path ? -1 : 1)) },
    reason: found.length === 0 ? null : `${found.length} tracked file(s) must never be committed`,
    remediation: found.length === 0 ? null
      : 'git rm --cached <path> and add it to .gitignore. A committed secret must also be rotated: removing it does not un-publish it.',
  })];
}

/** @param {string[]} args @param {string} cwd */
function defaultGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
}

/**
 * What kind of project this is, from files rather than from a flag.
 *
 * The distinction matters for one reason only: a customer application must not
 * be failed for lacking `packages/core`, which is a framework-repository file.
 * Everything the doctor checks is either present or `not_applicable`.
 *
 * @param {string} rootDir
 */
export function projectKind(rootDir) {
  const isDir = (path) => { try { return statSync(join(rootDir, path)).isDirectory(); } catch { return false; } };
  if (isDir('packages/core') && isDir('packages/cli')) return 'framework-repository';
  if (existsSync(join(rootDir, 'package.json'))) return 'application';
  return 'unknown';
}

/** @param {string} rootDir @param {string} path */
export function relativePath(rootDir, path) {
  return posix(relative(rootDir, path));
}
