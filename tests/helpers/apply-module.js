// @ts-check
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * True when the project copy already contains the generated module for this
 * manifest. Generated record modules are checked into the repo, so a fixture
 * that copies the repo (packages/, apps/, examples/) may already hold the
 * module a manifest would create — re-applying it trips module:create's
 * refuse-to-overwrite guard. Skipping the re-apply keeps the same end state
 * (module present with identical content) without weakening the fixture.
 *
 * @param {string} root project root (the temp copy, not the repo)
 * @param {string} manifestFile manifest file name, e.g. 'work-task.module.json'
 */
export function moduleAlreadyPresent(root, manifestFile) {
  return existsSync(join(root, 'packages/modules', basename(manifestFile, '.module.json')));
}

/**
 * Remove generated record modules from a throwaway project copy's registry,
 * so an absence fixture genuinely lacks the records — the way every fixture
 * did before generated modules were checked into the repo. Only the copy's
 * `packages/modules/generated/index.js` is rewritten; manifests on disk stay.
 *
 * @param {string} root project copy root
 * @param {string[]} moduleNames kebab-case module names, e.g. ['work-task']
 */
export function stripGeneratedModules(root, moduleNames) {
  const indexPath = join(root, 'packages/modules/generated/index.js');
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  const kept = lines.filter((line) =>
    !moduleNames.some((name) =>
      line.includes(`'../${name}/`) || line.startsWith(`  { name: '${name}'`),
    ),
  );
  writeFileSync(indexPath, `${kept.join('\n')}`);
}
