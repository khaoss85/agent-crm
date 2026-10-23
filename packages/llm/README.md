# LLM package

The framework-native language-model path (backlog:6e54d6a7988a, owner
decision 19/10 on Q-L1 in `docs/backoffice/OPEN-QUESTIONS.md`): the
assistant, the Advisor, "write/suggest with AI" and free questions run on
one adapter contract, first real provider OpenAI on its cheapest model.
The key arrives later from the owner; until then every call without a key
is an explicit dry-run on the fixture adapter — announced, audited, with
no network behind it.

Same schema as `packages/channels` and `packages/calendar-sync`: a fake
adapter, a shared contract-test kit, and the real adapter proving the
same kit.

## Files

- `src/adapter.js` — the contract: `validateLlmAdapter`,
  `assertGenerateInput`, `assertCompletion`, `LlmRegistries`
  (fingerprinted, ADR-015).
- `src/fixture.js` — `createFixtureLlmAdapter`: canned answers, `setMode`
  (`ok`/`transient`/`auth`/`limited`), call counting with metadata only.
- `src/kit.js` — `runLlmAdapterKit`: generate, model echo, error mapping,
  no key material in results or errors.
- `src/openai.js` — `createOpenAiLlmAdapter` with an injectable transport.
  The model name lives in exactly one place (`OPENAI_DEFAULT_MODEL`,
  today `gpt-6-luna`).
- `src/operations.js` — `createLlmOperations`: the guarded `complete`
  plus `readUsage`/`readAudit`, and `openLlmComplete` for the
  `llm-complete@1` capability consumers declare.
- `src/index.js` — `createLlmPackage` (`definePackage`, name `llm`).
- `modules/` — `llm-usage-day` (daily totals per space) and
  `llm-call-audit` (one row per attempt, never the prompt text).

## Guards

- A space without AI enabled refuses with `LLM_SPACE_DISABLED` before any
  adapter is touched — the fixture's call count stays zero.
- Past the daily token or cost ceiling the call refuses with
  `LLM_DAILY_CAP_EXCEEDED`, with its reason, before any adapter is touched.
- With no `secretRef` configured anywhere the call is a dry-run
  (`dryRun: true`, `dryRunReason: 'missing-key'`): the fixture answers,
  the audit says so, no network happens. With a key expected but custody
  failing or unwired the call refuses with `LLM_SECRET_UNAVAILABLE`
  instead of serving canned text.
- Every spend lands through one conditional storage claim on fresh
  totals (same-process calls also serialize on a per-space chain): the
  loser of a filled cap refuses with `LLM_DAILY_CAP_EXCEEDED`, and no
  spend update is lost — cross-process racers retry on the winner's
  totals. The claim, its framework audit row and the re-read land in one
  atomic unit: an audit failure rolls the spend back instead of landing
  it silently. A spend that lands after racers filled the ceiling is still
  recorded and annotated (`capExceeded: true` in the result), never
  hidden; the next call refuses.
- Dry-run and live results expose the same shape, including `usage`
  with the day totals (`dayTokens`, `dayCostCents`).
- Absent audit text (unknown adapter/model, no refusal, no error, no
  sources) persists as null and reads back as `''` on every backend.
  The result carries `sources` as an array of record ids; `readAudit`
  returns the same ids as one comma-joined string (`''` when none).
- The model surface is closed: the default model plus the space's explicit
  `models` allowlist. Every allowed model needs a valid price, or the call
  refuses with `LLM_PRICING_UNAVAILABLE` before the provider is touched.
- The key arrives only through the deployment's `resolveSecret` edge from
  a `secret://<space>/<name>` locator. It is held for one request, never
  stored, never logged; provider errors map to typed codes whose text
  carries neither the key nor the prompt.
- The audit row keeps every cited source id, so the result and the audit
  always agree on which records an answer cited.

## Costs

Spending is estimated from `LLM_ESTIMATED_PRICING_CENTS_PER_1K`, keyed by
model. Those are estimates: replace the table through the `pricing`
option when OpenAI bills the first invoice. Estimates drive caps and the
audit only, never a charge.

## Compose

```js
import { createLlmPackage } from './packages/llm/src/index.js';

const llm = createLlmPackage({
  adapters: [createOpenAiLlmAdapter({}).definition],
  resolveSecret: async (ref) => vault.read(ref),
  secretRef: 'secret://example/openai',
  spaces: { example: { enabled: true, dailyTokenCap: 200000 } },
});
```

A consumer package declares
`requires: [{ package: 'llm', capability: 'llm-complete', version: 1 }]`
and opens it with the caller's modules. Answers that cite customer data
pass `sources: [<record ids>]`: the ids travel in the result and the
audit, the records stay where they are.
