// @ts-check

/**
 * The three read-only tools.
 *
 * Every tool here is annotated `readOnlyHint: true`, and that annotation is not
 * a promise made in a comment: this package imports no database adapter, no
 * application factory and no module service. There is no code path from a tool
 * call to a write, because no write exists to reach.
 *
 * Every response passes through `assertLimitationsPresent` on the way out. A
 * capability or a job that lost its limitation fails the call rather than
 * shipping the overclaim.
 */

import { ValidationError } from '../../core/src/errors.js';
import { normalizeQuery } from './corpus.js';
import { assertLimitationsPresent } from './ledger.js';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_MATCH_LIMIT = 10;
const MAX_MATCH_LIMIT = 50;

/**
 * @param {{corpus: any, ledger: any, jobs: any}} dependencies
 */
export function createToolRegistry({ corpus, ledger, jobs }) {
  const definitions = [
    {
      name: 'search_docs',
      title: 'Search the Framework Documentation',
      description:
        'Keyword search across this framework\'s documentation set (README, AGENTS, ARCHITECTURE, PRODUCT, '
        + 'DECISIONS and everything under docs/). Returns the file path, the nearest heading and an excerpt for '
        + 'each hit. Read-only; it serves documentation, never customer records.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words that must all appear on the same line. Case-insensitive.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (/** @type {any} */ args) => {
        const query = normalizeQuery(args.query, 'query');
        const limit = boundedInteger(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, 'limit');
        const found = corpus.search(query, limit);
        return {
          query,
          terms: found.terms,
          documentsSearched: corpus.documents().length,
          totalMatches: found.totalMatches,
          truncated: found.truncated,
          results: found.results,
          note:
            'Documentation states what this repository intends and what it has. For whether a job actually '
            + 'works, call check_job; for a capability with the limitation that bounds it, call get_capability.',
        };
      },
    },
    {
      name: 'get_capability',
      title: 'Get a Capability and Its Limitation',
      description:
        'Resolve a capability from the claims ledger by id (C-nn), by standing-limitation id (L-nn), or by topic. '
        + 'Every capability is returned together with the evidence that proves it and the limitation that bounds '
        + 'it — this tool cannot return one without the other.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A claim id such as C-01, or a standing limitation id such as L-01.' },
          topic: { type: 'string', description: 'Free text, when the id is unknown. Matches claims and limitations.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_MATCH_LIMIT, default: DEFAULT_MATCH_LIMIT },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (/** @type {any} */ args) => {
        const hasId = typeof args.id === 'string' && args.id.trim() !== '';
        const hasTopic = typeof args.topic === 'string' && args.topic.trim() !== '';
        if (!hasId && !hasTopic) {
          throw new ValidationError('get_capability needs an id or a topic', { field: 'id|topic' });
        }
        const limit = boundedInteger(args.limit, DEFAULT_MATCH_LIMIT, MAX_MATCH_LIMIT, 'limit');

        if (hasId) {
          const match = ledger.byId(args.id);
          return assertLimitationsPresent({
            ...ledger.provenance(),
            query: { id: normalizeQuery(args.id, 'id'), topic: null },
            totalMatches: 1,
            truncated: false,
            matches: [match],
            frameworkLimitations: ledger.frameworkLimitations(),
            note: NOTE_PAIRING,
          }, 'get_capability');
        }

        const found = ledger.byTopic(args.topic, limit);
        return assertLimitationsPresent({
          ...ledger.provenance(),
          query: { id: null, topic: normalizeQuery(args.topic, 'topic') },
          terms: found.terms,
          totalMatches: found.totalMatches,
          truncated: found.truncated,
          matches: found.matches,
          frameworkLimitations: ledger.frameworkLimitations(),
          note: NOTE_PAIRING,
        }, 'get_capability');
      },
    },
    {
      name: 'check_job',
      title: 'Check Whether the Framework Does a Job',
      description:
        'Answer "can this framework do X?" against the CRM jobs-to-be-done index. Returns the matching jobs with '
        + 'their status (not supported / partially supported / technically supported / validated end to end), the '
        + 'tests that prove them, and an explicit answer when the truth is that the job is not supported.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The job in plain words, or a JTBD id such as JTBD-CO-01.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_MATCH_LIMIT, default: DEFAULT_MATCH_LIMIT },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (/** @type {any} */ args) => {
        const limit = boundedInteger(args.limit, DEFAULT_MATCH_LIMIT, MAX_MATCH_LIMIT, 'limit');
        const answer = jobs.check(args.query, limit);
        return assertLimitationsPresent({
          ...answer,
          frameworkLimitations: ledger.frameworkLimitations(),
          note:
            'A status is a claim, so every job above carries the limitation that bounds it. '
            + 'Absence from the index means the job was never assessed, not that it works.',
        }, 'check_job');
      },
    },
  ];

  const byName = new Map(definitions.map((tool) => [tool.name, tool]));
  return {
    list: () => definitions.map(({ handler: _handler, ...definition }) => definition),
    /** @param {string} name @param {any} args */
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) throw new ValidationError(`Unknown MCP tool: ${name}`, { name });
      return tool.handler(args ?? {});
    },
  };
}

const NOTE_PAIRING =
  'Every capability above is returned with the limitation that bounds it; the two are one statement and may not '
  + 'be quoted apart. frameworkLimitations applies to all of them.';

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @param {string} field
 */
function boundedInteger(value, fallback, max, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ValidationError(`${field} must be an integer of at least 1`, { field });
  }
  return Math.min(Number(value), max);
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}
