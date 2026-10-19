// @ts-check

import { definePackage, selectPackageGraph, ValidationError } from '../../core/index.js';
import { LLM_AUDIT_MODULE, createLlmOperations } from './operations.js';

/**
 * The assistant language-model domain package (backlog:6e54d6a7988a).
 *
 * Owner decision Q-L1 (19/10): assistente, Advisor, "Scrivi/Suggerisci con
 * AI" and free questions all complete through one native LLM package with
 * one adapter contract — the same fake-adapter + shared-kit + real-adapter
 * shape as `packages/channels` and `packages/calendar-sync` — first real
 * adapter OpenAI, cheapest model by default. The real key does not exist
 * yet (the owner generates it later): until then spaces without a key get
 * an explicit dry-run receipt, never a dial-out.
 *
 * It reuses and never duplicates: provider-key custody (`resolveSecret`,
 * the deployment edge every secret-bearing package uses), managed
 * evidence rows (the module factory owns `llm-call`), and typed errors
 * with UTC reasons. It changes no kernel file (ADR-018).
 *
 * What is deliberately NOT here: per-feature prompts (assistant, Advisor
 * and write/suggest own theirs and call the `llm-complete@1` capability),
 * the HTTP route (the pilot owns it, like every provider route), secret
 * values, and any network primitive — the OpenAI adapter speaks through
 * the deployment-injected transport.
 */

export const LLM_PACKAGE = 'llm';

/**
 * Stand-in adapter while the package is composed without bindings (package
 * tooling builds every factory with `{}`): it refuses every completion
 * with a typed code instead of failing construction, so validation and
 * conformance compose empty and real calls refuse fail-closed.
 */
function unwiredAdapter() {
  return {
    name: 'unwired-llm',
    version: 1,
    label: 'Unwired LLM (refuses)',
    model: 'unwired',
    config: { kind: 'unwired' },
    async complete() {
      const error = new Error('llm adapter is not composed: no provider binding');
      error.code = 'LLM_ADAPTER_UNWIRED';
      error.status = 500;
      throw error;
    },
  };
}

/** The records this package owns. No other package holds LLM call audits. */
export const LLM_RESOURCES = Object.freeze([LLM_AUDIT_MODULE]);

/**
 * Build the package definition the application composes.
 *
 * The factory builds with no bindings at all — package tooling
 * (`crm package validate`, conformance) constructs every factory with
 * `{}` — and the runtime bindings are checked when the operations are
 * created for a runtime, not when the definition is read.
 *
 * @param {{
 *   adapter?: any, resolveSecret?: (reference: string, context: {spaceId: string, purpose: string}) => Promise<string>,
 *   spaces?: Record<string, { aiEnabled: boolean, dailyCap: number, secretRef?: string, model?: string }>,
 *   now?: () => string,
 * }} [options] `adapter` is the provider binding (fake-backed until the
 * owner key exists — MEM_ACC_DECISIONS); `resolveSecret` is the
 * deployment custody edge; `spaces` maps each space to its AI switch, its
 * daily cap and its key locator. Optional at composition so tooling
 * composes empty; a completion refuses until they are wired, fail-closed.
 */
export function createLlmPackage(options = {}) {
  const { adapter, resolveSecret, spaces, now } = options;
  if (adapter !== undefined && (typeof adapter !== 'object' || adapter === null)) {
    throw new ValidationError('llm adapter must be an object when provided', { field: 'adapter' });
  }
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('llm resolveSecret must be a function', { field: 'resolveSecret' });
  }

  const pkg = definePackage({
    packageContract: 1,
    name: LLM_PACKAGE,
    version: 1,
    label: 'Assistant language model',
    description: 'One guarded doorway from the team features to a model provider: a single adapter contract (fake plus OpenAI), per-space enablement, a daily per-space cap, explicit dry-run without a key, and one key-free audit row per call.',
    resources: [...LLM_RESOURCES],

    // No declared reach into another package: completions need no sibling
    // behaviour, and the audit record is owned here. A standalone
    // composition boots and dry-runs exactly as before — never a
    // missing-package refusal at boot, never a new requirement.

    // The one seam features complete through: assistant, Advisor and
    // write/suggest call this capability with their own prompts.
    capabilities: [
      {
        name: 'llm-complete',
        version: 1,
        capabilityContract: 1,
        description: 'Complete one bounded message list for one space: enablement, daily cap, key custody, dry-run and audit enforced.',
        create({ modules, actor, now: contextNow }) {
          const ops = createLlmOperations({ adapter: adapter ?? unwiredAdapter(), resolveSecret, spaces, modules, now: contextNow ?? now });
          return {
            complete: (request) => ops.complete({ ...request, actor }),
          };
        },
      },
    ],

    operations: [
      {
        operationContract: 1,
        name: 'request-llm-completion',
        label: 'Request an LLM completion',
        appMethod: 'requestLlmCompletion',
        description: 'Complete one bounded message list for one space through the configured adapter. Refuses past the daily cap or without AI enabled; dry-runs without a key; audits every decided call without the prompt text.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
          { name: 'purpose', type: 'string', required: true, hint: 'Which feature asks: assistant, advisor, write, suggest, free-question.' },
        ],
        create(runtime) {
          const ops = createLlmOperations({
            adapter: adapter ?? unwiredAdapter(), resolveSecret, spaces, modules: runtime.modules, now: runtime.now ?? now,
          });
          return (params) => ops.complete({ ...params, actor: runtime.actor });
        },
      },
    ],
  });
  return selectPackageGraph(pkg);
}
