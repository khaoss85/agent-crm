// @ts-check

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ConflictError, ValidationError } from '../../core/src/errors.js';
import { validateModuleManifest, generateModuleMigration } from '../../core/src/module-manifest.js';

/** @param {string} manifestPath */
export function readManifestFile(manifestPath) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new ValidationError('A manifest file path is required (example: examples/modules/partner.module.json)');
  }
  const path = resolve(manifestPath);
  if (!existsSync(path)) {
    throw new ValidationError(`Manifest file not found: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ValidationError(`Manifest file is not valid JSON: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return { path, manifest: parsed };
}

/** @param {{manifestPath: string}} input */
export function validateManifestCommand(input) {
  const { path, manifest } = readManifestFile(input.manifestPath);
  const normalized = validateModuleManifest(manifest);
  return { ok: true, source: path, manifest: normalized };
}

/**
 * Dry-run by default: prints the generated SQL without touching the repository.
 * Writing requires an explicit --out path, and overwriting requires --force.
 *
 * @param {{manifestPath: string, out?: string, force?: boolean}} input
 */
export function generateMigrationCommand(input) {
  const { path, manifest } = readManifestFile(input.manifestPath);
  const migration = generateModuleMigration(manifest);

  if (typeof input.out !== 'string' || !input.out.trim()) {
    return { ok: true, mode: 'dry-run', source: path, ...migration };
  }

  const outPath = resolve(input.out);
  if (existsSync(outPath) && input.force !== true) {
    throw new ConflictError(`Refusing to overwrite ${outPath}; pass --force to allow it`, { path: outPath });
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, migration.sql, 'utf8');
  return { ok: true, mode: 'written', source: path, out: outPath, ...migration };
}
