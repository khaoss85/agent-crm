# LLM — the assistant language-model package

One guarded doorway from the team features to a model provider
(backlog:6e54d6a7988a; owner decision Q-L1, 19/10).

## What it does

Assistente, Advisor, "Scrivi/Suggerisci con AI" and free questions all
complete through this package's `llm-complete@1` capability with their own
prompts. The package enforces, in this order:

1. **Enablement** — a space without AI enabled is refused with
   `LLM_SPACE_DISABLED` before the adapter is touched: no call, no bytes.
2. **Daily cap** — past the per-space cap the call is refused with
   `LLM_DAILY_CAP_EXCEEDED`, naming the cap and the UTC reset.
3. **Dry-run** — a space without a key gets an explicit
   `{ dryRun: true, reason: 'LLM_KEY_MISSING' }` receipt with no transport
   call. The owner generates the real key later; until then features
   render their honest "AI non configurata" state.
4. **Audit** — every decided call writes one `llm-call` row with counts,
   outcome and a SHA-256 prompt hash. Never the prompt text, never the key.

## Layout (same shape as channels / calendar-sync)

| File | Role |
|---|---|
| `src/adapter.js` | the adapter contract: validation, bounds, result shape |
| `src/fake.js` | deterministic fake adapter (no network, ever) |
| `src/kit.js` | the shared contract-test kit every adapter passes |
| `src/openai.js` | the first real adapter (Responses API, injected transport) |
| `src/operations.js` | enablement, cap, dry-run, audit, key scrubbing |
| `src/index.js` | the composed package: `llm-complete@1` + `requestLlmCompletion` |
| `modules/llm-call.module.json` | the managed audit record |

## Composing it

```js
import { createFakeLlmAdapter } from './packages/llm/src/fake.js';
import { createLlmPackage } from './packages/llm/src/index.js';

const llm = createLlmPackage({
  adapter: createFakeLlmAdapter(),
  resolveSecret: async (ref) => vault.resolve(ref),
  spaces: {
    presti: { aiEnabled: true, dailyCap: 500, secretRef: 'vault://presti/openai' },
  },
});
```

Production swaps the adapter for `createOpenAIAdapter({ transport })`,
where `transport` is the deployment's HTTPS POST — the package holds no
network primitive. The default model is `gpt-6-luna` (the documented
cheapest Luna id; see the DECISION note in `src/openai.js`); override it
per space with `spaces.<id>.model`.

## What it deliberately does not do

Per-feature prompts (each caller owns its prompt), the HTTP route (the
pilot owns it), secret values, embeddings, fine-tuning, or any second
provider behind the same call — a new provider is a new adapter version
passing `kit.js`, never a branch in the operations.
