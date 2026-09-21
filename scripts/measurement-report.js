// @ts-check

import { isAbsolute, relative, resolve } from 'node:path';

export class MeasurementError extends Error {
  exitCode = 1;
}

const COUNTERS = ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];

/** Parse only the dedicated reporter channel, and prove exact coverage. */
export function parseMeasurementReport(text, root, expectedPaths) {
  const expected = new Set(expectedPaths);
  if (!expected.size || expected.size !== expectedPaths.length) throw new MeasurementError('invalid expected test-file inventory');
  const summaries = new Map();
  let total = null;
  for (const line of text.trim().split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { throw new MeasurementError('incomplete or invalid measurement summary'); }
    if (row.measurementSummary !== 1 || row.success !== true
      || !COUNTERS.every((key) => Number.isSafeInteger(row.counts?.[key]) && row.counts[key] >= 0)
      || row.counts.failed !== 0 || row.counts.cancelled !== 0) {
      throw new MeasurementError('unsuccessful or invalid measurement summary');
    }
    if (total) throw new MeasurementError('measurement summary after root completion');
    if (row.file === undefined) {
      total = row;
    } else {
      if (typeof row.file !== 'string' || !isAbsolute(row.file)) throw new MeasurementError('summary file is not absolute');
      const path = relative(resolve(root), row.file).split('\\').join('/');
      if (!expected.has(path) || summaries.has(path)) throw new MeasurementError(`unexpected or duplicate summary: ${path}`);
      summaries.set(path, row);
    }
  }
  if (!total || summaries.size !== expected.size) throw new MeasurementError('measurement report does not cover the exact test-file set');
  for (const counter of COUNTERS) {
    const sum = [...summaries.values()].reduce((n, row) => n + row.counts[counter], 0);
    if (!Number.isSafeInteger(sum) || sum !== total.counts[counter]) throw new MeasurementError(`per-file ${counter} does not reconcile with the full run`);
  }
  return {
    pass: total.counts.passed,
    fail: total.counts.failed,
    files: Object.fromEntries([...summaries].sort(([a], [b]) => a.localeCompare(b))
      .map(([path, row]) => [path, { tests: row.counts.passed }])),
  };
}

/** Verify the same committed, clean input still exists before publishing. */
export function assertMeasurementUnchanged(git, sha) {
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  if (head.status !== 0 || head.stdout !== sha || status.status !== 0 || status.stdout) {
    throw new MeasurementError('HEAD moved or the working tree became dirty during measurement; nothing recorded');
  }
}
