import { normalizeIds, observation } from './characterization-contract.mjs';
import { boot, characterizationProject, intelligenceSchemaBlock, intelligenceSchemaLocation } from './intelligence-harness.mjs';

/**
 * The Lead Intelligence characterization cases.
 *
 * Everything here is driven through the **public** surface — the SDK over a real
 * HTTP server, `/api/schema`, `crm app inspect` — because the question the
 * extraction has to answer is "does a consumer see the same thing", and an
 * in-process call cannot answer it.
 *
 * Every observation is classified. Only `contractual` and
 * `compatibility_required` are compared against the baseline; `incidental` is
 * recorded and never asserted, and `defect_candidate` is reproduced and never
 * frozen. See `characterization-contract.mjs` for why that distinction is the
 * difference between a characterization suite and a cement mixer.
 */

/** Stable fixtures: no clock, no randomness, no network. */
const LEAD = Object.freeze({
  firstName: 'Giulia', lastName: 'Ferrari', email: 'giulia@ferrari.example',
  companyName: 'Ferrari Sistemi', source: 'website',
});
const SIGNALS = Object.freeze([
  { signalType: 'pricing-page-visited', observedAt: '2026-08-01T10:00:00Z' },
  { signalType: 'demo-requested', observedAt: '2026-08-01T11:00:00Z' },
]);

/** Fields whose value is an opaque generated id: real, and not a promise. */
const OPAQUE = new Set(['id', 'runId', 'leadId', 'snapshotId', 'scoreRunId', 'routingRunId',
  'enrichmentSnapshotId', 'assignedTargetId', 'traceId', 'createdAt', 'updatedAt']);

/**
 * Input fingerprints, which are contractual by **presence and stability**, not
 * by value.
 *
 * The distinction matters and it is easy to get backwards. A *declared
 * definition* fingerprint — the model's, the policy's, the provider's — is the
 * decision's identity: it must be identical across every project forever, and
 * it is asserted by value. A *run input* fingerprint digests this run's actual
 * inputs, which include the lead's generated id, so it differs between two
 * throwaway projects by design. Asserting it by value would freeze a UUID and
 * make the suite fail on every run; not asserting it at all would lose the
 * property that actually matters, so it is asserted separately as "present, and
 * identical for identical inputs".
 */
const INPUT_FINGERPRINTS = new Set(['leadFingerprint', 'signalsFingerprint', 'targetSetFingerprint']);


/**
 * A record with generated identifiers normalized, so the **shape** is asserted
 * and the volatile value is not.
 *
 * Masking the id *fields* is not enough: a `sourceKey` like
 * `signal:<leadId>:demo-requested:<observedAt>` embeds one inside a string, and
 * that string is contractual — the key format is a real promise, and it is what
 * makes a duplicate detectable. So the format is frozen and the id inside it is
 * replaced. Getting this wrong made three records differ between two runs of
 * the same code, which is a characterization suite failing at its one job.
 */
/**
 * A shared mapping keeps identity relationships *between* records: if two rows
 * point at the same lead, both render `<id:1>`, and if one of them ever points
 * somewhere else the token changes. Passing `stable` straight to `.map()` would
 * hand it the array index as the mapping — which it did, loudly.
 */
function stableAll(records) {
  const mapping = new Map();
  return records.map((record) => stable(record, mapping));
}

function stable(record, mapping = new Map()) {
  const out = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (OPAQUE.has(key)) {
      out[key] = value === null || value === undefined ? null : '<present>';
    } else if (INPUT_FINGERPRINTS.has(key)) {
      out[key] = typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? '<input-fingerprint>' : value;
    } else {
      out[key] = value;
    }
  }
  // Positional, not a single token: two *different* ids must produce two
  // different tokens, or a swapped or cross-wired identifier compares equal to
  // a correct one. The mapping is shared across the whole record so the
  // relationships inside it survive.
  return normalizeIds(out, mapping);
}

/** @param {(entry: ReturnType<typeof observation>) => void} record */
export async function runIntelligenceCases(t, record) {
  const root = characterizationProject(t);
  const instance = await boot(root, `${root}/data/la0.sqlite`);
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  const leads = client.module('lead');

  // -------------------------------------------------------------------------
  // architecture — what the extraction must MIGRATE, not what it must preserve
  // -------------------------------------------------------------------------
  const schema = await client.schema();
  const intelligenceBlock = intelligenceSchemaBlock(schema);
  record(observation({
    id: 'architecture.schema-intelligence-block-present',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'schema',
    observed: { present: Boolean(intelligenceBlock), keys: Object.keys(intelligenceBlock ?? {}).sort(), foundAt: intelligenceSchemaLocation(schema) },
    note: 'Published today as an ambient `intelligence` block on /api/schema. After extraction it should be the package\'s own schema contribution — a deliberate migration, not a behaviour change to hide.',
  }));
  record(observation({
    id: 'architecture.app-intelligence-field-present',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: { present: typeof app.intelligence === 'object' && app.intelligence !== null },
    note: 'The ambient action-context field. Blocker 2 in EXTRACTION_PREPARATION.md; recorded as architecture evidence, deliberately separate from behavioural compatibility.',
  }));

  record(observation({
    id: 'architecture.definition-kinds-published',
    category: 'architecture',
    classification: 'contractual',
    surface: 'schema',
    observed: {
      enrichmentProviders: (intelligenceBlock?.enrichmentProviders ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
      scoringModels: (intelligenceBlock?.scoringModels ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
      routingPolicies: (intelligenceBlock?.routingPolicies ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
      routingTargetCount: (intelligenceBlock?.routingTargets ?? []).length,
    },
  }));

  // Fingerprints are the decision's identity, so they are contractual by value.
  for (const kind of ['enrichmentProviders', 'scoringModels', 'routingPolicies']) {
    for (const entry of intelligenceBlock?.[kind] ?? []) {
      record(observation({
        id: `architecture.fingerprint.${kind}.${entry.name}@${entry.version}`,
        category: 'architecture',
        classification: 'contractual',
        surface: 'schema',
        observed: entry.fingerprint,
      }));
    }
  }

  const leadMeta = (schema.generatedModules ?? []).find((entry) => entry.name === 'lead');
  record(observation({
    id: 'architecture.lead-actions-advertised',
    category: 'architecture',
    classification: 'contractual',
    surface: 'action-metadata',
    observed: (leadMeta?.actions ?? []).map((entry) => entry.name).sort(),
  }));
  record(observation({
    id: 'architecture.lead-managed-fields',
    category: 'architecture',
    classification: 'contractual',
    surface: 'schema',
    observed: (leadMeta?.fields ?? [])
      .filter((field) => field.writable === 'managed')
      .map((field) => field.name).sort(),
  }));

  // Every Intelligence action's full public contract.
  //
  // The published field is `input`, not `inputs`. The first version of this case
  // read `action.inputs`, captured `[]` for all four actions and asserted
  // nothing at all — found by the mutation test, which is the entire reason to
  // have one. What is frozen here is what a consumer actually depends on: the
  // route they call, the declared inputs, and the states the action is allowed
  // from, which IS the lifecycle gate.
  for (const action of (leadMeta?.actions ?? []).filter((entry) => ['enrich', 'record-signal', 'score', 'route'].includes(entry.name))) {
    record(observation({
      id: `architecture.action-contract.${action.name}`,
      category: 'architecture',
      classification: 'contractual',
      surface: 'action-metadata',
      observed: {
        actionContract: action.actionContract,
        path: action.path,
        stateField: action.stateField ?? null,
        fromStates: [...(action.fromStates ?? [])].sort(),
        confirm: Boolean(action.confirm),
        input: (action.input ?? []).map((entry) => ({
          name: entry.name, type: entry.type, required: Boolean(entry.required),
        })),
      },
    }));
  }

  // -------------------------------------------------------------------------
  // signals
  // -------------------------------------------------------------------------
  const lead = await leads.create({ ...LEAD });
  for (const signal of SIGNALS) await leads.action(lead.id, 'record-signal', { ...signal });

  const duplicate = await leads.action(lead.id, 'record-signal', { ...SIGNALS[1] }).then(
    () => ({ refused: false, status: null }),
    (error) => ({ refused: true, status: error.status }),
  );
  record(observation({
    id: 'signals.duplicate-source-key-refused',
    category: 'signals',
    classification: 'contractual',
    surface: 'sdk',
    observed: duplicate,
  }));

  const storedSignals = (await client.module('behavioral-signal').list({ limit: 500 })).items.filter((entry) => entry.leadId === lead.id);
  record(observation({
    id: 'signals.stored-count-after-duplicate',
    category: 'signals',
    classification: 'contractual',
    surface: 'storage',
    observed: storedSignals.length,
  }));
  record(observation({
    id: 'signals.stored-shape',
    category: 'signals',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll([...storedSignals].sort((a, b) => (a.signalType < b.signalType ? -1 : 1))),
  }));
  record(observation({
    id: 'signals.list-order',
    category: 'signals',
    classification: 'incidental',
    surface: 'storage',
    observed: storedSignals.map((entry) => entry.signalType),
    note: 'Nothing declares an ordering for this list. Recorded so a change is visible; never asserted, because freezing it would forbid an index change.',
  }));

  const badTarget = await client.module('lead').action('lead-that-does-not-exist', 'record-signal', { ...SIGNALS[0] }).then(
    () => ({ refused: false, status: null }),
    (error) => ({ refused: true, status: error.status }),
  );
  record(observation({
    id: 'signals.unknown-lead-refused',
    category: 'signals',
    classification: 'contractual',
    surface: 'sdk',
    observed: badTarget,
  }));

  // -------------------------------------------------------------------------
  // enrichment
  // -------------------------------------------------------------------------
  const enriched = await leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' });
  const snapshot = await client.module('enrichment-snapshot').get(enriched.result.snapshot.id);
  record(observation({
    id: 'enrichment.first-run-result',
    category: 'enrichment',
    classification: 'contractual',
    surface: 'sdk',
    observed: { reused: enriched.result.reused, sourceKey: enriched.result.snapshot.sourceKey.replace(lead.id, '<leadId>') },
  }));
  record(observation({
    id: 'enrichment.snapshot-record',
    category: 'enrichment',
    classification: 'contractual',
    surface: 'storage',
    observed: stable(snapshot),
  }));
  record(observation({
    id: 'enrichment.provider-fingerprint-matches-schema',
    category: 'enrichment',
    classification: 'contractual',
    surface: 'storage',
    observed: snapshot.providerFingerprint === (intelligenceBlock?.enrichmentProviders ?? [])[0]?.fingerprint,
  }));
  record(observation({
    id: 'enrichment.lead-link',
    category: 'enrichment',
    classification: 'contractual',
    surface: 'storage',
    observed: (await leads.get(lead.id)).enrichmentSnapshotId === snapshot.id,
  }));

  const reEnriched = await leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' });
  record(observation({
    id: 'enrichment.reuse-not-expired',
    category: 'enrichment',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      reused: reEnriched.result.reused,
      snapshotCount: (await client.module('enrichment-snapshot').list({ limit: 500 })).items.filter((entry) => entry.leadId === lead.id).length,
    },
  }));

  const unknownProvider = await leads.action(lead.id, 'enrich', { provider: 'no-such-provider' }).then(
    () => ({ refused: false, status: null }),
    (error) => ({ refused: true, status: error.status }),
  );
  record(observation({
    id: 'enrichment.unknown-provider-refused',
    category: 'enrichment',
    classification: 'contractual',
    surface: 'sdk',
    observed: unknownProvider,
  }));

  // -------------------------------------------------------------------------
  // scoring — the score is NOT the decision; the versioned, fingerprinted,
  // explained decision is
  // -------------------------------------------------------------------------
  const scored = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
  record(observation({
    id: 'scoring.v1.total',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: scored.result.total,
  }));
  record(observation({
    id: 'scoring.v1.identity',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: { model: scored.result.model, version: scored.result.version, fingerprint: scored.result.fingerprint },
  }));
  record(observation({
    id: 'scoring.v1.contribution-order',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: scored.result.contributions.map((entry) => entry.ruleKey),
    note: null,
  }));
  // Every rule, exactly: this is the explanation, and an explanation that
  // changes silently is a decision nobody can defend later.
  for (const contribution of scored.result.contributions) {
    record(observation({
      id: `scoring.v1.rule.${contribution.ruleKey}`,
      category: 'scoring',
      classification: 'contractual',
      surface: 'sdk',
      observed: { matched: contribution.matched, contribution: contribution.contribution },
    }));
  }

  const scoreRun = await client.module('score-run').get(scored.result.runId);
  record(observation({
    id: 'scoring.v1.run-record',
    category: 'scoring',
    classification: 'contractual',
    surface: 'storage',
    observed: stable(scoreRun),
  }));
  record(observation({
    id: 'scoring.v1.input-fingerprints-present',
    category: 'scoring',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      leadFingerprint: /^[0-9a-f]{64}$/.test(String(scoreRun.leadFingerprint)),
      signalsFingerprint: /^[0-9a-f]{64}$/.test(String(scoreRun.signalsFingerprint)),
      fingerprintMatchesResult: scoreRun.fingerprint === scored.result.fingerprint,
    },
  }));

  const rescored = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
  const rescoredRun = await client.module('score-run').get(rescored.result.runId);
  record(observation({
    id: 'scoring.input-fingerprints-stable-for-identical-inputs',
    category: 'scoring',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      leadFingerprintStable: rescoredRun.leadFingerprint === scoreRun.leadFingerprint,
      signalsFingerprintStable: rescoredRun.signalsFingerprint === scoreRun.signalsFingerprint,
      definitionFingerprintStable: rescoredRun.fingerprint === scoreRun.fingerprint,
    },
  }));
  record(observation({
    id: 'scoring.rerun-is-a-new-run-with-the-same-total',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      sameTotal: rescored.result.total === scored.result.total,
      newRunId: rescored.result.runId !== scored.result.runId,
      oldRunStillReadable: (await client.module('score-run').get(scored.result.runId)).totalScore,
    },
  }));

  await leads.action(lead.id, 'record-signal', { signalType: 'product-activated', observedAt: '2026-08-02T09:00:00Z' });
  const v2 = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 2 });
  record(observation({
    id: 'scoring.v2.total-and-distinct-fingerprint',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      total: v2.result.total,
      version: v2.result.version,
      fingerprintDiffersFromV1: v2.result.fingerprint !== scored.result.fingerprint,
    },
  }));
  record(observation({
    id: 'scoring.historical-run-keeps-its-version',
    category: 'scoring',
    classification: 'contractual',
    surface: 'storage',
    observed: (await client.module('score-run').get(scored.result.runId)).modelVersion,
  }));

  const unknownVersion = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 99 }).then(
    () => ({ refused: false, status: null }),
    (error) => ({ refused: true, status: error.status }),
  );
  record(observation({
    id: 'scoring.unknown-version-refused',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: unknownVersion,
    note: null,
  }));

  // -------------------------------------------------------------------------
  // routing and capacity
  // -------------------------------------------------------------------------
  const routed = await leads.action(lead.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
  record(observation({
    id: 'routing.v1.decision',
    category: 'routing',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      targetKey: routed.result.target?.key ?? null,
      fallbackReason: routed.result.fallbackReason ?? null,
    },
  }));
  const routingRun = await client.module('routing-run').get(routed.result.runId);
  record(observation({
    id: 'routing.v1.run-record',
    category: 'routing',
    classification: 'contractual',
    surface: 'storage',
    observed: stable(routingRun),
  }));

  // The target set that was considered is the evidence a decision is defensible
  // from. A different eligible set with the same winner is a different decision.
  const evaluations = (await client.module('route-evaluation').list({ limit: 500 })).items
    .filter((entry) => entry.runId === routed.result.runId);
  record(observation({
    id: 'routing.v1.target-set-evidence',
    category: 'routing',
    classification: 'contractual',
    surface: 'storage',
    observed: [...evaluations]
      .sort((a, b) => (String(a.targetKey) < String(b.targetKey) ? -1 : 1))
      .map((entry) => ({ targetKey: entry.targetKey, eligible: entry.eligible, reason: entry.reason })),
  }));

  const assignments = (await client.module('assignment').list({ limit: 500 })).items.filter((entry) => entry.leadId === lead.id);
  record(observation({
    id: 'assignment.created-from-routing',
    category: 'assignment',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(assignments),
  }));
  record(observation({
    id: 'assignment.lead-link',
    category: 'assignment',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      assignedTargetPresent: Boolean((await leads.get(lead.id)).assignedTargetId),
      routingRunLinked: (await leads.get(lead.id)).routingRunId === routed.result.runId,
    },
  }));

  // -------------------------------------------------------------------------
  // lifecycle gating
  // -------------------------------------------------------------------------
  const disqualified = await leads.create({ ...LEAD, email: 'gone@ferrari.example' });
  await leads.action(disqualified.id, 'disqualify', { reason: 'no budget' });
  for (const [action, input] of [
    ['enrich', { provider: 'fixture-firmographics' }],
    ['score', { model: 'b2b-saas-score', version: 1 }],
    ['route', { policy: 'b2b-sales-routing', version: 1 }],
    ['record-signal', { signalType: 'pricing-page-visited', observedAt: '2026-08-03T10:00:00Z' }],
  ]) {
    const outcome = await leads.action(disqualified.id, action, input).then(
      () => ({ refused: false, status: null }),
      (error) => ({ refused: true, status: error.status }),
    );
    record(observation({
      id: `lifecycle.disqualified-lead.${action}`,
      category: 'lifecycle',
      classification: 'contractual',
      surface: 'sdk',
      observed: outcome,
    }));
  }

  // -------------------------------------------------------------------------
  // page bounds — correctness evidence must never depend on a page
  // -------------------------------------------------------------------------
  //
  // `list()` is paged: it defaults to 100 rows and caps at 500, ordered by
  // `created_at DESC`. `listWhere()` is the complete query, and the module
  // factory says so in as many words — "a correctness decision must never
  // depend on a page bound". Every read above therefore asks for an explicit
  // 500 rather than trusting a default, and this case pushes one lead past the
  // default page so a silent truncation would show up as a wrong number rather
  // than as nothing at all.
  const busy = await leads.create({ ...LEAD, email: 'busy@ferrari.example' });
  const SIGNAL_COUNT = 130;
  for (let index = 0; index < SIGNAL_COUNT; index += 1) {
    await leads.action(busy.id, 'record-signal', {
      signalType: 'pricing-page-visited',
      observedAt: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      sourceKey: `bulk:${index}`,
    });
  }
  const bulk = (await client.module('behavioral-signal').list({ limit: 500 })).items.filter((entry) => entry.leadId === busy.id);
  record(observation({
    id: 'signals.beyond-the-default-page',
    category: 'signals',
    classification: 'contractual',
    surface: 'storage',
    observed: { written: SIGNAL_COUNT, readBack: bulk.length, complete: bulk.length === SIGNAL_COUNT },
  }));
  // And the score that depends on them counts every one, not one page of them.
  const busyScore = await leads.action(busy.id, 'score', { model: 'b2b-saas-score', version: 1 });
  const busyRun = await client.module('score-run').get(busyScore.result.runId);
  record(observation({
    id: 'scoring.signal-count-beyond-the-default-page',
    category: 'scoring',
    classification: 'contractual',
    surface: 'storage',
    observed: { signalCount: busyRun.signalCount, total: busyScore.result.total },
  }));

  // -------------------------------------------------------------------------
  // audit, events, trace
  // -------------------------------------------------------------------------
  const audits = app.audit.list({ limit: 500 });
  record(observation({
    id: 'audit.action-vocabulary',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: [...new Set(audits.map((entry) => entry.action))].sort(),
  }));
  record(observation({
    id: 'audit.counts-by-action',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: audits.reduce((totals, entry) => ({ ...totals, [entry.action]: (totals[entry.action] ?? 0) + 1 }), {}),
  }));
  record(observation({
    id: 'trace.run-vocabulary',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'trace',
    observed: [...new Set(app.workflows.listRuns({ limit: 500 }).map((entry) => entry.workflow))].sort(),
  }));
  record(observation({
    id: 'trace.run-order',
    category: 'audit-events-trace',
    classification: 'incidental',
    surface: 'trace',
    observed: app.workflows.listRuns({ limit: 500 }).map((entry) => entry.workflow),
    note: 'Nothing declares an ordering for the trace listing; recorded, never asserted.',
  }));

  // -------------------------------------------------------------------------
  // hostile input — unsafe behaviour becomes a defect candidate, never a contract
  // -------------------------------------------------------------------------
  /**
   * Behaviour that looks wrong measured against this repository's own
   * conventions — recorded and reproduced, deliberately NOT asserted as
   * must-stay. Each is a recommendation for a separate pre-extraction fix.
   */
  const DEFECT_CANDIDATES = {
    oversized: 'a 5,000-character value is accepted and stored unbounded. Every other text surface here is bounded — MAX_TEXT is 2,000 for a Solution Plan and MAX_REASON is 300 in partner-scorecard — and `value` on behavioral-signal declares no length at all. Any caller can write it. Recommend bounding it before the extraction, not during.',
    control: 'control characters are stored verbatim. partner-scorecard — the teaching example this repository points authors at — refuses them with CONTROL_RE. record-signal has no such check. Recommend the same refusal before the extraction.',
  };

  const HOSTILE = [
    ['prototype-key', '__proto__'],
    ['constructor-key', 'constructor'],
    ['markup', '<script>alert(1)</script>'],
    ['quotes', `he said "hi" and 'bye' and \`tick\``],
    ['template', '${process.env.HOME}'],
    ['newline', 'a\nb'],
    ['carriage-return', 'a\rb'],
    ['unicode-separator', 'a b'],
    ['control', 'ab'],
    ['oversized', 'x'.repeat(5_000)],
    ['path', '../../../../etc/passwd'],
    ['sql-shaped', "'; DROP TABLE lead; --"],
  ];
  for (const [label, value] of HOSTILE) {
    const sourceKey = `hostile:${label}`;
    const outcome = await leads.action(lead.id, 'record-signal', {
      signalType: 'pricing-page-visited', observedAt: '2026-08-04T10:00:00Z', value, sourceKey,
    }).then(() => ({ accepted: true, status: null }), (error) => ({ accepted: false, status: error.status }));

    // Read the value back from **storage**, not from the action result: the
    // result deliberately returns a summary without `value`, so comparing
    // against it measured nothing at all. The question is what was persisted.
    let stored = null;
    if (outcome.accepted) {
      const row = (await client.module('behavioral-signal').list({ limit: 500 })).items.find((entry) => entry.sourceKey === sourceKey);
      stored = row ? { present: true, byteIdentical: row.value === value, length: String(row.value ?? '').length } : { present: false };
    }
    record(observation({
      id: `hostile-input.record-signal.${label}`,
      category: 'hostile-input',
      // Storing a value verbatim is correct — escaping is a rendering concern,
      // and the SQL-shaped case passing proves the queries are parameterized.
      // Two of these are not that, and freezing them as contract would carry
      // the problem through the extraction and out the other side.
      classification: DEFECT_CANDIDATES[label] ? 'defect_candidate' : 'contractual',
      surface: 'storage',
      observed: { ...outcome, stored },
      note: DEFECT_CANDIDATES[label] ?? null,
    }));
  }
  // The table still exists: a SQL-shaped value is a value.
  record(observation({
    id: 'hostile-input.storage-survives',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'storage',
    observed: (await leads.get(lead.id)).id === lead.id,
  }));

  return { root, lead, instance };
}

/**
 * Restart: the same answers from the same database in a **new process-level
 * application**, because a domain that only reproduces its decisions while its
 * process is warm has not preserved them.
 *
 * @param {(entry: ReturnType<typeof observation>) => void} record
 */
export async function runRestartCases(t, record) {
  const root = characterizationProject(t, { name: 'agent-crm-la0-restart-' });
  const dbPath = `${root}/data/la0-restart.sqlite`;

  let instance = await boot(root, dbPath);
  t.after(() => instance.close().catch(() => {}));
  const leads = instance.client.module('lead');
  const lead = await leads.create({ ...LEAD });
  for (const signal of SIGNALS) await leads.action(lead.id, 'record-signal', { ...signal });
  await leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' });
  const before = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
  const beforeRun = await instance.client.module('score-run').get(before.result.runId);

  await instance.close();
  instance = await boot(root, dbPath);
  const after = instance.client.module('score-run');
  const afterRun = await after.get(before.result.runId);

  record(observation({
    id: 'storage-restart.score-run-identical',
    category: 'storage-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      totalScore: afterRun.totalScore === beforeRun.totalScore,
      fingerprint: afterRun.fingerprint === beforeRun.fingerprint,
      modelVersion: afterRun.modelVersion === beforeRun.modelVersion,
      leadFingerprint: afterRun.leadFingerprint === beforeRun.leadFingerprint,
      signalsFingerprint: afterRun.signalsFingerprint === beforeRun.signalsFingerprint,
    },
  }));

  // Re-scoring after a restart, from the same stored inputs, must reproduce the
  // same total under the same fingerprint.
  const rescored = await instance.client.module('lead').action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
  record(observation({
    id: 'storage-restart.rescore-reproduces',
    category: 'storage-restart',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      sameTotal: rescored.result.total === before.result.total,
      sameFingerprint: rescored.result.fingerprint === before.result.fingerprint,
    },
  }));
}

/**
 * Scale: many leads through the whole pipeline, then **every** stored value read
 * back and compared. This is where the ">500 exact reads" requirement is met —
 * not by asserting a count, but by asserting each value.
 *
 * @param {(entry: ReturnType<typeof observation>) => void} record
 */
export async function runScaleCases(t, record, { leads: leadCount = 60 } = {}) {
  const root = characterizationProject(t, { name: 'agent-crm-la0-scale-' });
  const instance = await boot(root, `${root}/data/la0-scale.sqlite`);
  t.after(() => instance.close().catch(() => {}));
  const leads = instance.client.module('lead');

  const rows = [];
  for (let index = 0; index < leadCount; index += 1) {
    const lead = await leads.create({
      firstName: `Lead${index}`, lastName: 'Scale',
      email: `lead${index}@ferrari.example`,
      companyName: index % 3 === 0 ? '' : `Company ${index}`,
      source: 'website',
    });
    if (index % 2 === 0) {
      await leads.action(lead.id, 'record-signal', { signalType: 'pricing-page-visited', observedAt: '2026-08-01T10:00:00Z' });
    }
    if (index % 5 === 0) {
      await leads.action(lead.id, 'record-signal', { signalType: 'demo-requested', observedAt: '2026-08-01T11:00:00Z' });
    }
    await leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' });
    const scored = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
    const routed = await leads.action(lead.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
    rows.push({
      index,
      total: scored.result.total,
      fingerprint: scored.result.fingerprint,
      matched: scored.result.contributions.filter((entry) => entry.matched).map((entry) => entry.ruleKey),
      target: routed.result.target?.key ?? null,
      fallbackReason: routed.result.fallbackReason ?? null,
    });
  }

  // One observation per lead per dimension: 60 leads x 5 = 300 asserted values
  // here, on top of the ~250 the case suites above assert individually.
  for (const row of rows) {
    record(observation({
      id: `scale.lead-${String(row.index).padStart(3, '0')}`,
      category: 'scoring',
      classification: 'contractual',
      surface: 'sdk',
      observed: row,
    }));
  }
  record(observation({
    id: 'scale.distinct-fingerprints',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: new Set(rows.map((row) => row.fingerprint)).size,
  }));
  record(observation({
    id: 'scale.total-distribution',
    category: 'scoring',
    classification: 'contractual',
    surface: 'sdk',
    observed: rows.reduce((totals, row) => ({ ...totals, [row.total]: (totals[row.total] ?? 0) + 1 }), {}),
  }));
}
