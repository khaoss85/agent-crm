// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Deterministic write-id mill for PostgreSQL idempotent retries.
 *
 * Outside a mill (SQLite and any path that never opened an outcome envelope)
 * this is `randomUUID`, which is the historical identity source. Inside a mill
 * every slot is derived from the tenant-namespace + raw caller key, so a
 * pre-commit retry mints the same record, audit and run ids and cannot create a
 * second row.
 */

const NAMESPACE = 'accordo.write-id.v1';
const SCOPE = new AsyncLocalStorage();

/**
 * UUID-shaped id from a stable seed. Version nibble 5, RFC 4122 variant.
 * @param {string} seed
 */
export function deterministicUuid(seed) {
  const digest = createHash('sha256').update(`${NAMESPACE}\0${seed}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @param {string} seed
 * @param {() => any} fn
 */
export function withWriteIds(seed, fn) {
  const mill = {
    seed,
    used: /** @type {Array<{slot: string, n: number, id: string}>} */ ([]),
    counters: /** @type {Record<string, number>} */ (Object.create(null)),
  };
  return SCOPE.run(mill, fn);
}

/**
 * @param {string} [slot]
 */
export function nextWriteId(slot = 'id') {
  const mill = SCOPE.getStore();
  if (!mill) return randomUUID();
  const n = (mill.counters[slot] ?? 0) + 1;
  mill.counters[slot] = n;
  const id = deterministicUuid(`${mill.seed}\0${slot}\0${n}`);
  mill.used.push({ slot, n, id });
  return id;
}

export function snapshotWriteIds() {
  const mill = SCOPE.getStore();
  return mill ? mill.used.slice() : [];
}

export function currentWriteIdSeed() {
  return SCOPE.getStore()?.seed ?? null;
}
