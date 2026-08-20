#!/usr/bin/env node
// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson, collectSource, resolveFrameworkSource,
} from '../packages/create-accordo/src/project-bootstrap.js';

export const PACKAGE_ASSEMBLY_CONTRACT = 1;

const repositoryRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const STAGING_PREFIX = '.accordo-package-assembly-';

const PUBLICATION_FILES = Object.freeze([
  { source: 'packages/create-accordo/bin/create-accordo.js', target: 'bin/create-accordo.js', mode: 0o755 },
  { source: 'packages/create-accordo/src/project-bootstrap.js', target: 'src/project-bootstrap.js' },
  { source: 'packages/create-accordo/src/project-files.js', target: 'src/project-files.js' },
  { source: 'packages/create-accordo/README.package.md', target: 'README.md' },
  { source: 'LICENSE', target: 'LICENSE' },
]);

const PROBLEM_CODES = Object.freeze([
  'TARGET_MISSING',
  'TARGET_PATH_INVALID',
  'TARGET_NOT_A_DIRECTORY',
  'TARGET_NOT_EMPTY',
  'TARGET_INSIDE_SOURCE',
  'SOURCE_INVALID',
  'ASSEMBLY_NOT_WRITTEN',
  'TARGET_CLAIMED',
]);

const LIMITATIONS = Object.freeze([
  ['NOT_PUBLISHED', 'this is a publication candidate assembled from checked-in source. It does not contact npm, stage a version or make `npm create accordo` work'],
  ['PROVENANCE_NOT_CREATED', 'a local assembly has no provenance attestation. npm creates provenance only when the package is published from the configured trusted GitHub Actions workflow'],
  ['TRUSTED_PUBLISHER_NOT_INSPECTED', 'the npm trusted-publisher setting is external state. This command cannot prove the registry authorizes the workflow, which action it allows or whether 2FA is enabled'],
  ['SOURCE_IS_A_COPY', 'the package carries a copy of the framework source. Projects created from it own that source, and upgrades mean merging rather than changing a dependency version'],
  ['GENERATED_PROJECT_IS_LOCAL_ONLY', 'the package creates local-development software: SQLite only, and no authentication ships'],
]);

/** @param {string} path */
function statSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

/**
 * Resolve every existing parent component without following the final target.
 * That keeps a target symlink visible to lstat while preventing a parent
 * symlink from disguising an output that is physically inside the source tree.
 * @param {string} path
 */
function canonicalTarget(path) {
  const finalName = basename(path);
  let cursor = dirname(path);
  const missing = [];
  while (!statSafe(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('the output path has no resolvable parent');
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missing, finalName);
}

/** @param {unknown} value */
function echoable(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '\ufffd').slice(0, 240);
}

/** @param {unknown} error @param {string[]} roots */
function safeMessage(error, roots) {
  let message = error instanceof Error ? error.message : String(error);
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(root).join('.');
  }
  return message.split('\n')[0].slice(0, 300);
}

/** @param {string} root */
function sourceManifest(root) {
  const parsed = JSON.parse(readPublicationSource(root, 'packages/create-accordo/package.json').toString('utf8'));
  if (parsed.name !== 'create-accordo' || typeof parsed.version !== 'string' || parsed.private !== true) {
    throw new Error('packages/create-accordo/package.json must remain the private create-accordo source manifest with a version');
  }
  return parsed;
}

/** @param {string} root @param {string} relativePath */
function readPublicationSource(root, relativePath) {
  const path = join(root, ...relativePath.split('/'));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} must be a regular file; publication assembly never follows symbolic links`);
  }
  return readFileSync(path);
}

/** @param {string} version */
export function publicationManifest(version) {
  return {
    name: 'create-accordo',
    version,
    description: 'Create a local Accordo CRM project for coding agents: deterministic, offline, inspectable, and owned as source.',
    type: 'module',
    engines: { node: '>=22.16.0' },
    bin: { 'create-accordo': 'bin/create-accordo.js' },
    files: ['bin', 'src', 'framework', 'README.md', 'LICENSE'],
    keywords: [
      'crm', 'crm-framework', 'coding-agent', 'codex', 'claude-code', 'gemini-cli',
      'mcp', 'workflow', 'customer-hub', 'revenue-operations',
    ],
    repository: {
      type: 'git',
      url: 'git+https://github.com/khaoss85/agent-crm.git',
      directory: 'packages/create-accordo',
    },
    homepage: 'https://accordo.dev',
    bugs: { url: 'https://github.com/khaoss85/agent-crm/issues' },
    license: 'MIT',
    publishConfig: { access: 'public', provenance: true },
  };
}

/**
 * @param {string} root
 * @returns {{files: {relativePath:string, content:Buffer, mode?:number}[], packageVersion:string, sourceFingerprint:string}}
 */
export function collectAssemblyFiles(root = repositoryRoot) {
  const canonicalRoot = realpathSync(root);
  const manifest = sourceManifest(canonicalRoot);
  const frameworkRoot = resolveFrameworkSource(join(canonicalRoot, 'packages/create-accordo/src'));
  if (frameworkRoot !== canonicalRoot) throw new Error('the create-accordo source does not resolve back to this repository root');
  const framework = collectSource(canonicalRoot);
  if (framework.problems.length) {
    throw new Error(`the declared framework source is invalid: ${framework.problems.map((problem) => problem.code).join(', ')}`);
  }

  /** @type {{relativePath:string, content:Buffer, mode?:number}[]} */
  const files = [];
  const publicManifest = `${JSON.stringify(publicationManifest(manifest.version), null, 2)}\n`;
  files.push({ relativePath: 'package.json', content: Buffer.from(publicManifest) });

  for (const entry of PUBLICATION_FILES) {
    files.push({
      relativePath: entry.target,
      content: readPublicationSource(canonicalRoot, entry.source),
      ...(entry.mode ? { mode: entry.mode } : {}),
    });
  }
  for (const entry of framework.files) {
    files.push({
      relativePath: `framework/${entry.path}`,
      content: readFileSync(join(canonicalRoot, ...entry.path.split('/'))),
    });
  }
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));

  const sourceFingerprint = createHash('sha256')
    .update(canonicalJson(framework.files.map((file) => [file.path, file.hash])))
    .digest('hex');
  return { files, packageVersion: manifest.version, sourceFingerprint };
}

/** @param {{directory:unknown,cwd?:string,root?:string}} input */
export function planPackageAssembly({ directory, cwd = process.cwd(), root = repositoryRoot }) {
  /** @type {{code:string,message:string}[]} */
  const problems = [];
  let target = null;

  if (typeof directory !== 'string' || directory.trim() === '') {
    problems.push({ code: 'TARGET_MISSING', message: 'an output directory is required: assemble-create-accordo <directory>' });
  } else if (/[\u0000-\u001f\u007f]/.test(directory)) {
    problems.push({ code: 'TARGET_PATH_INVALID', message: 'the output directory contains a control character or null byte' });
  } else {
    const requestedTarget = isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory);
    target = canonicalTarget(requestedTarget);
    const fromRoot = relative(root, target);
    const insideRoot = fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
    if (insideRoot) {
      problems.push({ code: 'TARGET_INSIDE_SOURCE', message: 'the publication directory must be outside the repository it is assembled from' });
    }
    const stat = statSafe(target);
    if (stat && !stat.isDirectory()) {
      problems.push({ code: 'TARGET_NOT_A_DIRECTORY', message: `${echoable(basename(target))} exists and is not a directory` });
    } else if (stat) {
      try {
        const entries = readdirSync(target);
        if (entries.length) problems.push({ code: 'TARGET_NOT_EMPTY', message: `the output directory contains ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; nothing is overwritten` });
      } catch (error) {
        problems.push({ code: 'TARGET_PATH_INVALID', message: `the output directory cannot be read: ${safeMessage(error, [target, cwd])}` });
      }
    }
  }

  let assembly = { files: [], packageVersion: null, sourceFingerprint: null };
  try {
    assembly = collectAssemblyFiles(root);
  } catch (error) {
    problems.push({ code: 'SOURCE_INVALID', message: safeMessage(error, [root, cwd]) });
  }

  const described = assembly.files.map((file) => ({
    relativePath: file.relativePath,
    bytes: file.content.byteLength,
    contentHash: createHash('sha256').update(file.content).digest('hex'),
    ...(file.mode ? { mode: file.mode } : {}),
  }));
  const fingerprint = createHash('sha256')
    .update(canonicalJson(described.map((file) => [file.relativePath, file.contentHash, file.mode ?? null])))
    .digest('hex');

  const report = {
    packageAssemblyContract: PACKAGE_ASSEMBLY_CONTRACT,
    command: 'package:assemble-create-accordo',
    ok: problems.length === 0,
    mode: 'plan',
    modeReason: 'no --apply was given, so nothing was written',
    package: {
      name: 'create-accordo',
      version: assembly.packageVersion,
      outputDirectory: echoable(directory),
      files: described.length,
      bytes: described.reduce((sum, file) => sum + file.bytes, 0),
      fingerprint,
      frameworkFingerprint: assembly.sourceFingerprint,
    },
    files: described,
    problems,
    problemCodes: [...PROBLEM_CODES],
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
  };
  return { report, target, files: assembly.files };
}

/** @param {{directory:unknown,cwd?:string,root?:string}} input */
export function applyPackageAssembly(input) {
  const planned = planPackageAssembly(input);
  const { report, target, files } = planned;
  if (!report.ok || !target) {
    return { ...report, mode: 'refused', modeReason: 'the request was refused, so nothing was written' };
  }

  const parent = dirname(target);
  let staging = null;
  const cleanup = () => { if (staging) rmSync(staging, { recursive: true, force: true }); };
  const refuse = (code, message) => ({
    ...report,
    ok: false,
    mode: 'refused',
    modeReason: 'the assembly failed, so no publication directory was committed',
    problems: [...report.problems, { code, message }],
  });

  try {
    mkdirSync(parent, { recursive: true });
    staging = join(parent, `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`);
    mkdirSync(staging);
    for (const file of files) {
      const destination = join(staging, ...file.relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content, file.mode ? { mode: file.mode } : undefined);
    }
  } catch (error) {
    cleanup();
    return refuse('ASSEMBLY_NOT_WRITTEN', safeMessage(error, [parent, input.cwd ?? process.cwd()]));
  }

  const existing = statSafe(target);
  if (existing && (!existing.isDirectory() || readdirSync(target).length > 0)) {
    cleanup();
    return refuse('TARGET_CLAIMED', 'the output directory was claimed while the package was assembled');
  }
  try {
    if (existing) rmdirSync(target);
    renameSync(staging, target);
    staging = null;
  } catch (error) {
    cleanup();
    const claimed = ['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EPERM'].includes(/** @type {any} */ (error).code);
    return refuse(
      claimed ? 'TARGET_CLAIMED' : 'ASSEMBLY_NOT_WRITTEN',
      claimed ? 'the output directory was claimed while the package was assembled' : safeMessage(error, [parent]),
    );
  }

  return {
    ...report,
    mode: 'applied',
    modeReason: '--apply was given, and the publication directory was committed by one rename',
  };
}

export function parseArguments(argv) {
  let directory = null;
  let apply = false;
  let json = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (directory !== null) throw new Error('only one output directory may be given');
    directory = arg;
  }
  return { directory, apply, json, help };
}

function renderHelp() {
  return [
    'assemble-create-accordo — prepare the npm publication directory',
    '',
    '  node scripts/assemble-create-accordo.js <directory> [--apply] [--json]',
    '',
    'Dry-run is the default. The command reaches no registry and publishes nothing.',
  ].join('\n');
}

function renderText(report) {
  const lines = [
    `create-accordo ${report.package.version ?? 'unknown'} publication assembly`,
    `status: ${report.ok ? report.mode : 'refused'}`,
  ];
  for (const problem of report.problems) lines.push(`FAIL ${problem.code}: ${problem.message}`);
  if (report.ok) {
    lines.push(`files: ${report.package.files}`);
    lines.push(`fingerprint: ${report.package.fingerprint}`);
    lines.push(report.modeReason);
  }
  lines.push('not proven: registry publication, trusted-publisher configuration, provenance');
  return lines.join('\n');
}

/** @param {any} report */
function exitCodeFor(report) {
  if (report.ok) return 0;
  return report.problems.some((problem) => ['TARGET_MISSING', 'SOURCE_INVALID', 'ASSEMBLY_NOT_WRITTEN'].includes(problem.code)) ? 2 : 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
      console.log(renderHelp());
    } else {
      const report = args.apply
        ? applyPackageAssembly({ directory: args.directory })
        : planPackageAssembly({ directory: args.directory }).report;
      console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
      process.exitCode = exitCodeFor(report);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(renderHelp());
    process.exitCode = 2;
  }
}
