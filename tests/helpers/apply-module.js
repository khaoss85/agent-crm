// @ts-check
import { existsSync } from 'node:fs';
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
