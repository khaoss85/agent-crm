// @ts-check

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'data']);
// `.mjs` too. The starter installer and the scenario journeys are checked-in
// executable source that CI runs, and nothing was syntax-checking them: a typo
// in one surfaced as a journey that "did not complete", minutes later, with the
// diagnostic buried in a child's last line.
const files = walk(root).filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file: relative(root, file), error: result.stderr.trim() });
}

if (failures.length) {
  for (const failure of failures) console.error(`\n${failure.file}\n${failure.error}`);
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}

function walk(directory) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) results.push(...walk(path));
    else results.push(path);
  }
  return results;
}
