// @ts-check

/**
 * Renewal & amendment execution Admin (M16b, ADR-035).
 *
 * **Package-scoped, not package-owned.** The framework still has no seam for a
 * package to contribute an Admin extension — AX1 publishes that as
 * `ADMIN_EXTENSIONS_UNSUPPORTED` — so this file lives in the Admin app and
 * renders only while `/api/schema` publishes `domains.lifecycle.amendment`. It
 * disappears with the package instead of degrading into a broken control.
 *
 * The screen's job is to make four things impossible to misread, because each
 * is a claim a user would otherwise make on the framework's behalf:
 *
 *   the plan looks green — **a plan is an observation, not an authorisation**;
 *     execution recomputes everything and can still refuse;
 *   the term says "signed" — **only when the signed document carried it**; the
 *     source and the successor each keep their own provenance sentence, and the
 *     three provenances (signed / post-signature operational / absent) are
 *     never collapsed into one badge;
 *   a classification is shown — **it was derived from the line delta by the
 *     server**, never chosen here and never typed by anybody;
 *   a successor exists — **nothing was billed, renewed automatically or sent to
 *     the customer**, and the source agreement was not modified.
 *
 * Admin rules as everywhere: values render as text and never as markup, the
 * server owns every state, a control appears only where the server would accept
 * it, controls disable while a request is in flight, and a refusal is visible
 * with the operator's typing intact — which means **every handler re-throws**,
 * because the parent's `withBusy` treats a swallowed failure as a success and
 * re-renders over the message.
 */

/** The four sentences this section carries verbatim, always, in every state. */
export const AMENDMENT_DISCLAIMERS = Object.freeze([
  'No invoice, payment or billing of any kind follows from executing a successor agreement. None of it is modeled.',
  'Nothing renews automatically. There is no scheduler: auto-renew and notice days are recorded only, and no date moves anything here.',
  'No customer, signer or colleague is notified. Executing a successor sends nothing to anybody.',
  'Executing requires a signed-in user actor. That is a human-actor boundary for audit — not Sales, Legal or Finance role enforcement.',
]);

/** The sentence a source agreement's own term must carry when it was signed. */
const SIGNED_LABEL = 'signed commercial term';
const OPERATIONAL_LABEL = 'post-signature operational metadata';
const ABSENT_LABEL = 'absent — unknown provenance';

const LIST_LIMIT = 100;

/**
 * **This section holds no client-side selection, deliberately.**
 *
 * The Service section had to keep one outside its render closure, because the
 * parent's `withBusy` re-renders the whole quote detail on every successful
 * write and a selection kept in a local was destroyed by every successful
 * action. Here there is nothing to select: at most one round is open on a
 * contract at a time and a contract is succeeded exactly once, so *which* round
 * to show is derived from the server's rows on every render. A selection this
 * screen does not need is a selection that cannot go stale.
 */

/** Invoke a package action over the Admin's own thin request client. */
function runAction(client, module, id, action, input) {
  return client.request(
    `/api/modules/${encodeURIComponent(module)}/records/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** A labelled fact row. Values are text, always — never markup. */
function fact(el, label, value) {
  const row = el('div', 'fact');
  row.appendChild(el('span', 'fact-label', label));
  row.appendChild(el('span', 'fact-value', value === null || value === undefined || value === '' ? '—' : String(value)));
  return row;
}

/**
 * The provenance block for one term, rendered so the three cases can never be
 * mistaken for one another.
 *
 * `signed: true`, `signed: false` and `signed: null` are three different
 * answers, and the third one — "this row names a provenance nobody classified"
 * — is the one a badge would quietly turn into "not signed".
 */
function renderProvenance(el, panel, title, term, provenance) {
  const box = el('div', 'amendment-provenance');
  box.setAttribute('data-provenance', title);
  box.appendChild(el('h5', undefined, title));
  if (!term) {
    box.setAttribute('data-signed', 'absent');
    box.appendChild(el('p', 'amendment-provenance-label', ABSENT_LABEL));
    box.appendChild(el('p', 'muted', provenance?.note
      ?? 'No commercial term is recorded here, and none is invented. Absence is a fact, never a default.'));
    panel.appendChild(box);
    return box;
  }
  const state = term.signed === true ? 'signed' : term.signed === false ? 'operational' : 'unclassified';
  box.setAttribute('data-signed', state);
  box.appendChild(el('p', 'amendment-provenance-label',
    state === 'signed' ? SIGNED_LABEL : state === 'operational' ? OPERATIONAL_LABEL : ABSENT_LABEL));
  box.appendChild(fact(el, 'Source', term.source));
  box.appendChild(fact(el, 'Basis', term.signedBasis));
  box.appendChild(fact(el, 'Term', `${term.startDate ?? '—'} → ${term.endDate ?? '—'} (end date inclusive)`));
  box.appendChild(fact(el, 'Days', term.days));
  box.appendChild(fact(el, 'Auto-renew', term.autoRenew === true ? 'yes — recorded only, nothing fires on it' : 'no'));
  box.appendChild(fact(el, 'Notice days', term.renewalNoticeDays));
  if (term.termsFingerprint) box.appendChild(fact(el, 'Term fingerprint', term.termsFingerprint));
  // The package's own sentence, verbatim. Never summarized here: a summary is
  // where a provenance quietly becomes a badge.
  box.appendChild(el('p', 'muted amendment-provenance-note', term.provenanceNote ?? ''));
  panel.appendChild(box);
  return box;
}

/** The exact line delta, as text. No total is derived and none is shown. */
function renderDelta(el, panel, delta, money, currency) {
  const box = el('div', 'amendment-delta');
  box.appendChild(el('h5', undefined, 'Line delta'));
  box.appendChild(fact(el, 'Added / removed / changed / unchanged',
    `${delta.counts.added} / ${delta.counts.removed} / ${delta.counts.changed} / ${delta.counts.unchanged}`));
  for (const line of delta.lines) {
    const row = el('div', `amendment-delta-line ${line.status}`);
    row.setAttribute('data-delta-line', line.key);
    row.setAttribute('data-delta-status', line.status);
    row.appendChild(el('span', 'amendment-delta-label', `${line.label ?? line.key} · ${line.status}`));
    const before = line.before
      ? `qty ${line.before.quantity} · ${money(line.before.netAmountCents, line.before.currency ?? currency)}`
      : 'not on the source agreement';
    const after = line.after
      ? `qty ${line.after.quantity} · ${money(line.after.netAmountCents, line.after.currency ?? currency)}`
      : 'not on the successor order';
    row.appendChild(el('span', 'amendment-delta-before', `before: ${before}`));
    row.appendChild(el('span', 'amendment-delta-after', `after: ${after}`));
    if (line.changedFields.length > 0) {
      row.appendChild(el('span', 'amendment-delta-fields', `changed: ${line.changedFields.join(', ')}`));
    }
    box.appendChild(row);
  }
  const groups = el('div', 'amendment-baseline');
  groups.appendChild(el('h5', undefined, 'Baseline movement, by currency and recurrence'));
  for (const group of delta.baselineDelta) {
    const recurrence = group.chargeType === 'recurring'
      ? `every ${group.intervalCount} ${group.interval}(s)` : 'one-time';
    groups.appendChild(fact(el, `${group.currency} · ${recurrence}`,
      `${money(group.beforeNetAmountCents, group.currency)} → ${money(group.afterNetAmountCents, group.currency)}`));
  }
  groups.appendChild(el('p', 'muted amendment-baseline-note', delta.baselineNote));
  box.appendChild(groups);
  panel.appendChild(box);
}

/** The standing limitations, rendered from the package's own words. */
function renderLimits(el, panel, meta) {
  const limits = el('div', 'amendment-limits');
  for (const sentence of AMENDMENT_DISCLAIMERS) {
    limits.appendChild(el('p', 'muted amendment-disclaimer', sentence));
  }
  for (const limitation of meta.amendment?.limitations ?? []) {
    limits.appendChild(el('p', 'muted amendment-limitation', limitation));
  }
  limits.appendChild(el('p', 'muted amendment-not-modeled',
    `Not modeled anywhere in this section: ${(meta.notModeled ?? []).join(', ')}.`));
  panel.appendChild(limits);
}

/**
 * The whole section.
 *
 * @param {{contract: any, schema: any, mount: any, el: any, client: any,
 *   fetchRows?: any, money: (cents: number, currency: string) => string,
 *   withBusy: (fn: () => Promise<any>) => Promise<void>, busy: any[]}} deps
 */
export async function renderAmendment({ contract, schema, mount, el, client, money, withBusy, busy }) {
  const meta = schema.domains?.lifecycle ?? null;
  // No package, no section. The Admin never implies a capability the server
  // does not have.
  if (!meta || meta.amendment?.amendmentContract !== 1) return;

  const panel = el('div', 'amendment-section');
  panel.setAttribute('data-contract', contract.id);
  panel.appendChild(el('h3', undefined, 'Renewal & amendment execution'));
  mount.appendChild(panel);

  const error = el('small', 'field-error amendment-error', '');
  panel.appendChild(error);

  /** Read this contract's runs, narrowed ON THE SERVER (ADR-008 addendum 2). */
  let runs = [];
  let lineage = null;
  try {
    const query = new URLSearchParams({ limit: String(LIST_LIMIT) });
    query.set('filter.sourceContractId', contract.id);
    const response = await client.request(`/api/modules/amendment-run/records?${query.toString()}`);
    // The client-side predicate is defence in depth: a server that ignored the
    // filter still could not draw another agreement's rounds here.
    runs = (response.items ?? []).filter((row) => row.sourceContractId === contract.id)
      .sort((a, b) => a.round - b.round);
    const successions = new URLSearchParams({ limit: String(LIST_LIMIT) });
    successions.set('filter.sourceContractId', contract.id);
    const found = await client.request(`/api/modules/contract-succession/records?${successions.toString()}`);
    lineage = (found.items ?? []).find((row) => row.sourceContractId === contract.id) ?? null;
  } catch (loadError) {
    error.textContent = loadError?.message ?? 'Could not load amendment runs';
    renderLimits(el, panel, meta);
    return;
  }

  // Which round to show is derived from the server's rows, never remembered.
  const open = runs.find((row) => row.state !== 'executed' && row.state !== 'abandoned') ?? null;

  panel.appendChild(fact(el, 'Rounds recorded', runs.length));
  panel.appendChild(el('p', 'muted amendment-round-rule', meta.amendment.rounds));

  // ── executed: evidence only, and no control at all ──────────────────────
  if (lineage) {
    const done = el('div', 'amendment-executed');
    done.setAttribute('data-state', 'executed');
    done.appendChild(el('h4', undefined, 'Successor agreement'));
    done.appendChild(fact(el, 'Successor contract', lineage.successorContractId));
    done.appendChild(fact(el, 'Successor order', lineage.successorOrderId));
    done.appendChild(fact(el, 'Successor subscription', lineage.successorSubscriptionId));
    done.appendChild(fact(el, 'Classification (derived)', lineage.classification));
    done.appendChild(fact(el, 'Why', lineage.classificationBasis));
    done.appendChild(fact(el, 'Term continuity', `${lineage.termContinuity} (${lineage.termGapDays ?? '—'} day(s))`));
    done.appendChild(fact(el, 'Source term', `${lineage.sourceTermStartDate ?? '—'} → ${lineage.sourceTermEndDate ?? '—'} · ${lineage.sourceTermsSource ?? '—'}`));
    done.appendChild(fact(el, 'Successor term', `${lineage.successorTermStartDate ?? '—'} → ${lineage.successorTermEndDate ?? '—'} · ${lineage.successorTermsSource ?? '—'}`));
    done.appendChild(fact(el, 'Signed document', lineage.documentHash));
    done.appendChild(fact(el, 'Deciding policy', `${lineage.policy} v${lineage.policyVersion} · ${lineage.policyFingerprint}`));
    done.appendChild(fact(el, 'Executed by', `${lineage.executedBy} at ${lineage.executedAt}`));
    done.appendChild(el('p', 'muted amendment-immutable',
      'This agreement was not modified. Its term, its lines and its subscription are exactly what they were before the '
      + 'successor existed — a successor replaces an agreement going forward, and rewrites nothing behind it.'));
    panel.appendChild(done);
    renderLimits(el, panel, meta);
    return;
  }

  // ── no run: one control, and a read that records nothing ────────────────
  if (!open) {
    const start = el('div', 'amendment-open');
    start.setAttribute('data-state', 'none');
    start.appendChild(el('p', 'muted', 'No renewal or amendment round is open on this agreement. Opening one records the ask and its reason; it creates no quote, order, contract or successor.'));
    const reason = el('input');
    reason.setAttribute('name', 'reason');
    reason.setAttribute('aria-label', 'Why this round is being opened');
    const button = el('button', undefined, 'Open amendment run');
    button.setAttribute('data-action', 'open-amendment-run');
    busy.push(button);
    button.addEventListener('click', () => withBusy(async () => {
      if (String(reason.value ?? '').trim() === '') {
        // Refused before any request leaves the browser, and the message is
        // thrown so the parent does not treat it as a success.
        throw new Error('A reason is required to open an amendment run.');
      }
      await runAction(client, 'commercial-contract', contract.id, 'open-amendment-run', { reason: String(reason.value) });
    }));
    start.appendChild(reason);
    start.appendChild(button);
    panel.appendChild(start);
    renderLimits(el, panel, meta);
    return;
  }

  // ── an open run ─────────────────────────────────────────────────────────
  const runBox = el('div', 'amendment-run');
  runBox.setAttribute('data-state', open.state);
  runBox.setAttribute('data-run', open.id);
  runBox.appendChild(el('h4', undefined, `Round ${open.round} · ${open.state}`));
  runBox.appendChild(fact(el, 'Reason', open.reason));
  runBox.appendChild(fact(el, 'Opened by', `${open.openedBy} at ${open.openedAt}`));
  runBox.appendChild(fact(el, 'Candidate signed order', open.successorOrderId));
  if (open.readinessObservedAt) {
    runBox.appendChild(fact(el, 'Evidence observed at', open.readinessObservedAt));
    runBox.appendChild(el('p', 'muted amendment-observation-note', meta.amendment.authority));
  }
  panel.appendChild(runBox);

  // Attach (or replace) the candidate order while the run is non-terminal.
  const attach = el('div', 'amendment-attach');
  const orderInput = el('input');
  orderInput.setAttribute('name', 'successorOrderId');
  orderInput.setAttribute('aria-label', 'Signed successor order id');
  if (open.successorOrderId) orderInput.value = open.successorOrderId;
  const policySelect = el('select');
  policySelect.setAttribute('name', 'policy');
  policySelect.setAttribute('aria-label', 'Order activation policy');
  for (const policy of (schema.domains?.contracts?.policies ?? []).filter((entry) => entry.kind === 'order-activation-policy')) {
    const option = el('option', undefined, `${policy.label ?? policy.name} (v${policy.version})`);
    option.setAttribute('value', `${policy.name}@${policy.version}`);
    policySelect.appendChild(option);
    if (policySelect.value === undefined || policySelect.value === '') policySelect.value = `${policy.name}@${policy.version}`;
  }
  const attachButton = el('button', undefined, 'Attach successor order');
  attachButton.setAttribute('data-action', 'attach-successor-order');
  busy.push(attachButton);
  attachButton.addEventListener('click', () => withBusy(async () => {
    if (String(orderInput.value ?? '').trim() === '') throw new Error('A signed successor order id is required.');
    const [name, version] = String(policySelect.value).split('@');
    await runAction(client, 'amendment-run', open.id, 'attach-successor-order', {
      successorOrderId: String(orderInput.value).trim(), policy: name, policyVersion: Number(version),
    });
  }));
  attach.appendChild(el('p', 'muted', 'Attaching records what the evidence says right now. It authorises nothing: executing re-proves every one of these facts inside its own transaction.'));
  attach.appendChild(orderInput);
  attach.appendChild(policySelect);
  attach.appendChild(attachButton);
  panel.appendChild(attach);

  // The plan — read-only, and it says so.
  let plan = null;
  if (open.successorOrderId) {
    const [name, version] = String(policySelect.value).split('@');
    try {
      const response = await runAction(client, 'commercial-contract', contract.id, 'plan-amendment', {
        successorOrderId: open.successorOrderId, policy: name, policyVersion: Number(version),
      });
      plan = response.result?.succession ?? null;
    } catch (planError) {
      error.textContent = planError?.message ?? 'Planning failed';
    }
  }

  if (plan) {
    const planBox = el('div', 'amendment-plan');
    planBox.setAttribute('data-coherent', String(plan.coherent));
    planBox.appendChild(el('h4', undefined, 'Plan'));
    planBox.appendChild(el('p', 'muted', 'Planning is read-only: it records nothing and changes nothing.'));
    planBox.appendChild(fact(el, 'Classification (derived by the server)', plan.classification ?? '—'));
    planBox.appendChild(fact(el, 'Why', plan.classificationBasis ?? '—'));
    planBox.appendChild(el('p', 'muted amendment-classification-note',
      'This label was derived from the line delta below. It is never chosen here, never typed by anybody, and a change '
      + 'whose narrower name cannot be derived is recorded as commercial_change with the same exact delta attached.'));
    if (plan.termContinuity) {
      planBox.appendChild(fact(el, 'Term continuity', `${plan.termContinuity.relation} (${plan.termContinuity.gapDays ?? '—'} day(s))`));
      planBox.appendChild(el('p', 'muted amendment-continuity-note', plan.termContinuity.note));
    }
    panel.appendChild(planBox);

    // Both provenances, side by side, never collapsed.
    const provenance = el('div', 'amendment-provenances');
    provenance.appendChild(el('h4', undefined, 'Signed-terms provenance'));
    panel.appendChild(provenance);
    renderProvenance(el, provenance, 'Source agreement term', plan.source?.term ?? null, null);
    renderProvenance(el, provenance, 'Successor order term', plan.successor?.term ?? null, plan.successor?.termsProvenance ?? null);

    if (plan.delta) renderDelta(el, panel, plan.delta, money, contract.currency);

    if (!plan.coherent) {
      const gaps = el('div', 'amendment-gaps');
      gaps.setAttribute('data-blocking', 'true');
      gaps.appendChild(el('h5', undefined, 'Execution is refused'));
      for (const refusal of plan.refusals) {
        const row = el('div', 'amendment-gap');
        row.setAttribute('data-gap', refusal.code);
        row.appendChild(el('span', 'amendment-gap-code', refusal.code));
        row.appendChild(el('span', 'amendment-gap-message', refusal.message));
        row.appendChild(el('span', 'amendment-gap-kind',
          refusal.resolvableByMaturity
            ? 'this can still resolve as the order matures'
            : 'waiting will not resolve this — the pairing itself is wrong'));
        gaps.appendChild(row);
      }
      panel.appendChild(gaps);
    }
  }

  // The one execution control, and it exists only in `ready`.
  if (open.state === 'ready' && plan?.coherent) {
    const execute = el('div', 'amendment-execute');
    const executeButton = el('button', undefined, 'Execute renewal or amendment');
    executeButton.setAttribute('data-action', 'execute-amendment');
    busy.push(executeButton);
    executeButton.addEventListener('click', () => withBusy(async () => {
      const [name, version] = String(policySelect.value).split('@');
      await runAction(client, 'amendment-run', open.id, 'execute-amendment', {
        policy: name, policyVersion: Number(version),
      });
    }));
    execute.appendChild(el('p', 'muted', 'Executing creates the successor agreement, its subscription and its lineage in one transaction. It modifies nothing on the agreement it succeeds.'));
    execute.appendChild(executeButton);
    panel.appendChild(execute);
  } else if (open.state !== 'ready') {
    panel.appendChild(el('p', 'muted amendment-no-execute',
      'No execution control appears while this round is not ready. The server would refuse it, and a control that only '
      + 'produces a refusal is a control that lies about what is possible.'));
  }

  // The exit. A round always has one.
  const abandon = el('div', 'amendment-abandon');
  const abandonReason = el('input');
  abandonReason.setAttribute('name', 'abandonReason');
  abandonReason.setAttribute('aria-label', 'Why this round is being abandoned');
  const abandonButton = el('button', 'danger', 'Abandon this round');
  abandonButton.setAttribute('data-action', 'abandon-amendment-run');
  busy.push(abandonButton);
  abandonButton.addEventListener('click', () => withBusy(async () => {
    if (String(abandonReason.value ?? '').trim() === '') throw new Error('A reason is required to abandon a round.');
    await runAction(client, 'amendment-run', open.id, 'abandon-amendment-run', { reason: String(abandonReason.value) });
  }));
  abandon.appendChild(el('p', 'muted', 'Abandoning closes this round with a reason. It cancels nothing, ends nothing and changes no commercial record; a new round may be opened afterwards.'));
  abandon.appendChild(abandonReason);
  abandon.appendChild(abandonButton);
  panel.appendChild(abandon);

  renderLimits(el, panel, meta);
}
