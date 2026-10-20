// @ts-check

import { AppError, definePackage, selectPackageGraph } from '../../core/index.js';
import { IntelligenceRegistries } from './registry.js';
import { buildEnrichAction, buildRecordSignalAction, buildScoreAction, buildRouteAction } from './actions.js';
import { createIntelligenceCapability } from './capability.js';
import {
  CALL_INTELLIGENCE_MODULES,
  CALL_TRANSCRIPT_PURGE_HANDLER,
  CALL_TRANSCRIPT_PURGE_KIND,
  CALL_TRANSCRIPT_PURGE_MAX_ATTEMPTS,
  CALL_TRANSCRIPT_PURGE_VERSION,
  createCallIntelligence,
  registerCallTranscriptPurge,
  seedCallTranscriptPurge,
} from './call-intelligence.js';

/**
 * The Lead Intelligence domain package.
 *
 * This is the oldest domain in the repository and the first legacy one to move
 * out of `packages/core`. It owns enrichment, behavioural signals, explainable
 * versioned scoring, routing and assignment: its seven record modules, its four
 * actions, its declared definitions and the `intelligence@1` capability.
 *
 * **Nothing about what it decides changed in the move.** That is not a claim,
 * it is the acceptance criterion: LA0 (`npm run characterize:intelligence`)
 * froze every externally observable decision before the extraction, and an
 * asserted value that moves fails the build.
 *
 * What did change is that the domain is now *optional and declared*. It is
 * composed by a static import in `packages/domains/generated/index.js`, the
 * kernel never imports it, and a consumer reaches it by declaring
 * `intelligence@1` rather than by finding it on the application object.
 *
 * What this package does NOT do, deliberately: it does not own the Lead. Its
 * actions target the **project-owned** `lead` record, which is a host-record
 * dependency and not a package dependency — see `resources` below.
 */

export const INTELLIGENCE_DOMAIN = 'intelligence';

/**
 * The record modules this package owns. The Lead is deliberately absent.
 *
 * `resources` declares what the package *owns*, so a second package claiming
 * one is a startup collision. Lead is not listed because Lead is the project's
 * record: Intelligence acts **on** it, writes its managed fields through the
 * action runtime, and would be wrong to claim it. A project can have a Lead
 * without Intelligence, and removing the package leaves the Lead intact.
 */
export const INTELLIGENCE_RESOURCES = Object.freeze([
  'enrichment-snapshot', 'behavioral-signal', 'score-run', 'score-contribution',
  'routing-run', 'route-evaluation', 'assignment',
]);

/**
 * Build the domain definition the application composes.
 *
 * The four declared definition kinds arrive the same way they always did —
 * from checked-in project source — and are validated fail-closed by the
 * registries. ADR-022: providers keep the provider contract, scoring models and
 * routing policies keep the versioned fingerprinted policy contract, and
 * routing targets are declared configuration of the routing capability rather
 * than a definition kind or a managed resource, because nothing mutates them.
 *
 * Call intelligence (BO-F1-08, backlog:588db7766206) rides the same
 * definition: the start-of-call notice, the transcript, its AI summary and
 * its buying signals, with the workspace LLM handed over the same way
 * channels takes `llm-complete@1` — created once by the provider factory,
 * never re-instantiated here. Absent until a call asks for an AI summary:
 * notices, transcripts, retention and reads never touch it.
 * @param {{
 *   enrichmentProviders?: any[], scoringModels?: any[],
 *   routingPolicies?: any[], routingTargets?: any[],
 *   llm?: { capabilities?: Array<any> },
 *   callRetention?: { defaultMonths?: number, bySpace?: Record<string, number> },
 *   config?: {module?: string, timeoutMs?: number} & Record<string, string|number>,
 * }} [options] `config` is the same builder configuration the starter passed
 *   before the move — record-module renames and the enrichment timeout.
 *   `callRetention` carries the per-space transcript lifetime in months
 *   (Q-G2, default 12).
 */
/**
 * Open the handed-over `llm-complete@1` capability for one runtime
 * (BO-F1-08 summaries). Absent until a call asks for an AI summary —
 * notices, transcripts, retention and reads never touch it, so
 * compositions without the llm package keep booting exactly as before.
 */
function openCallLlm(llmCapability, runtime) {
  if (llmCapability === undefined || llmCapability === null) return null;
  if (typeof llmCapability.create !== 'function') {
    throw new AppError(
      'The intelligence package needs the llm package capability llm-complete@1: '
      + 'compose it with the provider definition, e.g. createIntelligenceDomain({ llm }) '
      + 'beside createLlmPackage()',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
  const opened = llmCapability.create({ modules: runtime.modules });
  if (!opened || typeof opened.complete !== 'function') {
    throw new AppError(
      'The intelligence package needs the llm package capability llm-complete@1: '
      + 'the created capability opens no complete',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
  return opened;
}

export function createIntelligenceDomain(options = {}) {
  const registries = new IntelligenceRegistries({
    enrichmentProviders: options.enrichmentProviders ?? [],
    scoringModels: options.scoringModels ?? [],
    routingPolicies: options.routingPolicies ?? [],
    routingTargets: options.routingTargets ?? [],
  });
  const llmOffered = Array.isArray(options.llm?.capabilities)
    ? options.llm.capabilities.find((entry) => entry?.name === 'llm-complete' && entry?.version === 1) ?? null
    : null;
  const callRetention = options.callRetention ?? {};

  // One composed instance PER APPLICATION runtime: the operations close
  // over the runtime's own database and modules — the same per-runtime
  // pattern channels and signature use, so one composition module may
  // serve several instances in one process. The runtime database hands the
  // summarize commit its transaction (signals and summary land together);
  // a runtime without one keeps the sequential writes.
  const callsByRuntime = new WeakMap();
  const callOperations = (runtime) => {
    let composed = callsByRuntime.get(runtime);
    if (!composed) {
      composed = createCallIntelligence({
        modules: runtime.modules,
        llm: openCallLlm(llmOffered, runtime),
        retention: callRetention,
        database: runtime.database,
      });
      callsByRuntime.set(runtime, composed);
    }
    return composed;
  };

  const pkg = definePackage({
    packageContract: 1,
    name: INTELLIGENCE_DOMAIN,
    version: 1,
    label: 'Lead Intelligence',
    description:
      'Enriches leads from declared providers, records behavioural signals, scores them with explainable versioned models and routes them to declared targets — every decision carrying the fingerprint of the definition that made it. Also holds call intelligence (BO-F1-08): start-of-call notices, transcripts with per-space retention, AI summaries and buying signals that cite their transcript.',
    resources: [...INTELLIGENCE_RESOURCES, ...CALL_INTELLIGENCE_MODULES],
    capabilities: [createIntelligenceCapability(registries)],
    actions: [
      buildEnrichAction(options.config, registries),
      buildRecordSignalAction(options.config, registries),
      buildScoreAction(options.config, registries),
      buildRouteAction(options.config, registries),
    ],
    operations: [
      {
        operationContract: 1,
        name: 'record-call-notice',
        label: 'Record call notice',
        appMethod: 'recordCallNotice',
        description: 'Record the start-of-call notice (Q-G2 avviso): without it the call audio or text cannot be saved. A repeated notice resolves identically; a conflicting one is refused.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
          { name: 'callRef', type: 'string', required: true, hint: 'The interaction-call source key this notice covers.' },
        ],
        create(runtime) {
          const ops = callOperations(runtime);
          return (params) => ops.recordCallNotice(params);
        },
      },
      {
        operationContract: 1,
        name: 'save-call-transcript',
        label: 'Save call transcript',
        appMethod: 'saveCallTranscript',
        description: 'Save the call transcript. Refused when no start-of-call notice is on file — nothing is stored before the notice.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
          { name: 'callRef', type: 'string', required: true, hint: 'The interaction-call source key this transcript belongs to.' },
        ],
        create(runtime) {
          const ops = callOperations(runtime);
          return (params) => ops.saveCallTranscript(params);
        },
      },
      {
        operationContract: 1,
        name: 'summarize-call',
        label: 'Summarize call',
        appMethod: 'summarizeCall',
        description: 'Summarize a call with the workspace LLM adapter and store the buying signals (budget, timing, interest, doubt), each citing the transcript it was read from.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
          { name: 'callRef', type: 'string', required: true, hint: 'The interaction-call source key to summarize.' },
        ],
        create(runtime) {
          const ops = callOperations(runtime);
          return (params) => ops.summarizeCall(params);
        },
      },
      {
        operationContract: 1,
        name: 'purge-expired-transcripts',
        label: 'Purge expired transcripts',
        appMethod: 'purgeExpiredTranscripts',
        description: 'Erase every transcript whose per-space retention expired: text and summary are wiped, purgedAt is stamped, the row remains as the erasure proof.',
        input: [
          { name: 'spaceId', type: 'string', required: false, hint: 'Scope the purge to one space; omit to purge every space.' },
        ],
        create(runtime) {
          const ops = callOperations(runtime);
          return (params) => ops.purgeExpiredTranscripts(params);
        },
      },
      {
        operationContract: 1,
        name: 'read-customer-calls',
        label: 'Read customer calls',
        appMethod: 'readCustomerCalls',
        description: 'The calls of one customer, latest first, for the scheda cliente: the AI summary, the signals with their transcript source, and the transcript while retention keeps it.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
        ],
        create(runtime) {
          const ops = callOperations(runtime);
          return (params) => ops.readCustomerCalls(params);
        },
      },
    ],
    // Deliberately empty; see `persistFingerprints` below. The definitions ARE
    // versioned fingerprinted policies in every sense ADR-022 means, but the
    // rows that record them already exist in shipped databases under their own
    // type strings, and those rows are the immutability evidence.
    policies: [],
    /** Function-free, additive schema metadata — the same block as before the move. */
    metadata() {
      return registries.metadata();
    },
  });

  /**
   * **Fingerprint persistence stays exactly where it was, and this is the one
   * place the extraction deliberately departs from ADR-022's literal wording.**
   *
   * ADR-022 says scoring models and routing policies use the `policies`
   * contract. That is right about the *contract* — versioned, fingerprinted,
   * declared config — and silent about the *persisted identity*. The package
   * registry writes `definition_versions` rows typed
   * `domain-policy:intelligence:<kind>`; Intelligence has been writing
   * `scoring-model`, `routing-policy` and `enrichment-provider` since M9.
   *
   * Handing them to the registry would write a second set of rows in every
   * shipped database, leave the original rows unmatched, and silently retire
   * the drift check that makes a registered version immutable. An existing
   * database would boot and lose a guarantee, which is the worst available
   * outcome.
   *
   * So the package keeps its own persistence with the original type strings.
   * Persisted identity outranks a mapping decided before anyone looked at the
   * rows, and the deviation is recorded here rather than discovered later.
   *
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => registries.persistFingerprints(database);
  /** The registries, for the composition that owns this package instance. */
  pkg.registries = registries;
  return selectPackageGraph(pkg, options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createIntelligenceDomain()` callers keep v1. */
export function createIntelligenceDomainV2(options = {}) {
  return createIntelligenceDomain({ ...options, packageContract: 2 });
}

export { IntelligenceRegistries } from './registry.js';
export { buildEnrichAction, buildRecordSignalAction, buildScoreAction, buildRouteAction } from './actions.js';
export {
  CALL_INTELLIGENCE_MODULES,
  CALL_SIGNAL_TYPES,
  CALL_TRANSCRIPT_DEFAULT_RETENTION_MONTHS,
  CALL_TRANSCRIPT_PURGE_HANDLER,
  CALL_TRANSCRIPT_PURGE_KIND,
  CALL_TRANSCRIPT_PURGE_MAX_ATTEMPTS,
  CALL_TRANSCRIPT_PURGE_VERSION,
  addMonthsUtc,
  createCallIntelligence,
  isExpired,
  registerCallTranscriptPurge,
  seedCallTranscriptPurge,
} from './call-intelligence.js';
export { ENRICHMENT_CAPABILITIES, ROUTING_TARGET_KINDS } from './registry.js';
