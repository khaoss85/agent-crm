// @ts-check

import { AppError } from '../../core/index.js';
import { deciding, resolvedNames, trusted } from './store.js';

/**
 * `customer-channel-origins@1` — new customers per origin channel and week
 * (BO-F6-13, backlog:05225cf952a4, slice 2 of reporting.arch.md).
 *
 * The consumer is the reporting dashboard: the "Nuovi clienti per canale"
 * card needs counts of new contacts per channel of origin grouped by week,
 * and reading another package's tables directly is forbidden (§3 of
 * docs/PACKAGE_AUTHORING.md). This capability is that declared read.
 *
 * Source of truth: the `external-identity` rows this package already owns.
 * One active identity is one channel through which the outside world named
 * a record; its `firstObservedAt` is when the channel first named it. Only
 * `active` rows count — a superseded identity names nobody anymore.
 *
 * Read-only by construction: it hands back frozen aggregates, no storage
 * handle, no decision path, and nothing that could link, dismiss or erase.
 * Week bucketing is a pure function below, so the dashboard model and the
 * view share the exact same aggregates the tests pin.
 */

/**
 * The ISO week start (Monday, YYYY-MM-DD) of a stored timestamp, or null
 * when the row carries no usable date. Undated rows stay out of the weekly
 * bars but still count in the channel legend — the model says which.
 * @param {unknown} value
 * @returns {string | null}
 */
export function weekStartOf(value) {
  if (typeof value !== 'string' || value.length < 10) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  // Guard the calendar, not the clock: Date.parse normalises 2026-02-30 to
  // March, so a row carrying an impossible day must not silently move weeks.
  if (date.toISOString().slice(0, 10) !== day) return null;
  const monday = new Date(at - (((date.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000));
  return monday.toISOString().slice(0, 10);
}

/**
 * Aggregate identity rows into per-(system, week) counts. Pure: the same
 * input always yields the same frozen output, so the capability, the
 * application operation and the tests share one implementation.
 * @param {Array<Record<string, any>>} rows active external-identity rows
 * @returns {{ origins: Array<{ system: string, week: string | null, count: number }>, undated: number }}
 */
export function aggregateChannelOrigins(rows) {
  // Nested maps, never a joined string key: a system name carrying a
  // separator must not merge two channels into one aggregate.
  const counts = new Map();
  let undated = 0;
  for (const row of rows ?? []) {
    if (row === null || typeof row !== 'object') continue;
    const system = typeof row.system === 'string' && row.system !== '' ? row.system : 'unknown';
    const week = weekStartOf(row.firstObservedAt);
    if (week === null) undated += 1;
    let byWeek = counts.get(system);
    if (!byWeek) {
      byWeek = new Map();
      counts.set(system, byWeek);
    }
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
  }
  const origins = [];
  for (const [system, byWeek] of counts) {
    for (const [week, count] of byWeek) {
      origins.push(Object.freeze({ system, week, count }));
    }
  }
  origins.sort((a, b) => (a.system < b.system ? -1 : a.system > b.system ? 1 : (a.week ?? '') < (b.week ?? '') ? -1 : 1));
  return { origins: Object.freeze(origins), undated };
}

/**
 * @param {Record<string, string>} [config]
 */
export function createChannelOriginsCapability(config) {
  const names = resolvedNames(config);
  return {
    name: 'customer-channel-origins',
    version: 1,
    description:
      'Count new customers per origin channel and ISO week from the active external-identity rows: '
      + 'which outside system first named a record, and in which week. Read-only aggregates, no storage handle.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('customer-channel-origins@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      return Object.freeze({
        capabilityContract: 1,

        /**
         * Every (system, week) with its new-identity count, frozen.
         * `week` is null for identities without a usable first-observed
         * date: they count in the legend, never in a weekly bar.
         */
        async countOrigins() {
          // A correctness read, never a display page: an aggregate taken
          // from a 500-row page would silently lose channels once the
          // identity table outgrows the page.
          const rows = await deciding(trusted(modules, names.identity), { status: 'active' });
          return aggregateChannelOrigins(rows);
        },
      });
    },
  };
}
