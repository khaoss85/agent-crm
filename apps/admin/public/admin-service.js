// @ts-check

/**
 * Service Operations Admin (Milestone 15, the service domain package).
 *
 * **Package-scoped, not package-owned.** The framework has no seam for a package
 * to contribute an Admin extension — AX1 publishes that as
 * `ADMIN_EXTENSIONS_UNSUPPORTED`. This file lives in the Admin app and renders
 * only while `/api/schema` publishes `domains.service`, so it disappears with
 * the package instead of degrading into a broken control.
 *
 * The screen's job is to keep four claims impossible to misread, because each is
 * a claim a user would otherwise make on the framework's behalf:
 *
 *   coverage was activated — **it is operational evidence, not a signed
 *     contract, and it does not amend the Commercial Contract**;
 *   a case names a category and a source — **a listed channel does not mean a
 *     provider is connected**, and nothing was emailed, called or messaged;
 *   an escalation was recorded — **no notification was sent automatically**;
 *   an SLA says `breached` — **that is elapsed wall-clock time against a target
 *     somebody typed**, never a contractual or legal determination.
 *
 * Admin rules as everywhere: values render as text and never as markup, the
 * server owns every state, a control appears only where the server would accept
 * it, controls disable while a request is in flight, a stale response is
 * discarded, and a refusal is visible with the operator's typing intact.
 */

/** The sentence every coverage view has to carry, verbatim. */
const COVERAGE_LIMITATION =
  'ServiceCoverage is operational evidence. It is not a signed contract and does not amend the Commercial Contract.';
/** …and the two the case and escalation views have to carry. */
const CHANNEL_LIMITATION = 'A listed channel does not mean a provider is connected.';
const NOTIFICATION_LIMITATION = 'No notification was sent automatically.';

/**
 * Invoke a package action over the Admin's own request client.
 *
 * The Admin client is a thin `request(path, options)` wrapper, not the SDK — it
 * has no `module().action()`. Building the route here keeps this section on the
 * same single HTTP surface every other Admin section uses.
 */
function runAction(client, module, id, action, input) {
  return client.request(
    `/api/modules/${encodeURIComponent(module)}/records/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** Discard a response that arrived after a newer one was asked for. */
function tokened() {
  let current = 0;
  return { next: () => ++current, fresh: (token) => token === current };
}

/**
 * Which case the operator is looking at, per contract.
 *
 * It has to live outside the render closure. The Admin's `withBusy` re-renders
 * the **whole quote detail** whenever a write succeeds, which builds a brand new
 * section — so selection kept in a local would be destroyed by every successful
 * action. A real browser found exactly that: recording a case, or a note on the
 * case being read, threw the operator back to a queue with nothing open.
 *
 * Keyed by contract id, so two contracts never bleed into each other, and read
 * back through the case list, so a selection that no longer exists is simply
 * nothing selected rather than a broken detail.
 */
const SELECTED_CASE = new Map();

/**
 * Forget every selection. A browser gets this for free by reloading; a test
 * process does not, and one test's selection leaking into the next is how a
 * suite starts asserting against state no user could have produced.
 */
export function resetServiceSelection() {
  SELECTED_CASE.clear();
}

/** A labelled fact row. Values are text, always — never markup. */
function fact(el, label, value) {
  const row = el('p', 'svc-fact');
  row.appendChild(el('strong', undefined, `${label}: `));
  row.appendChild(el('span', undefined, String(value ?? '—')));
  return row;
}

/** An input with an accessible name, because a placeholder is not a label. */
function field(el, { tag = 'input', name, label, placeholder, type, value }) {
  const node = el(tag);
  node.setAttribute('name', name);
  node.setAttribute('aria-label', label);
  if (placeholder) node.setAttribute('placeholder', placeholder);
  if (type) node.setAttribute('type', type);
  if (value !== undefined) node.value = String(value);
  return node;
}

/** A select with an accessible name and a bounded, server-declared vocabulary. */
function choice(el, { name, label, options }) {
  const node = el('select');
  node.setAttribute('name', name);
  node.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const option = el('option', undefined, text);
    option.setAttribute('value', value);
    node.appendChild(option);
    if (node.value === undefined || node.value === '') node.value = value;
  }
  return node;
}

/** Server-written JSON evidence; unreadable data degrades to none, never throws. */
function parseList(text) {
  try {
    const value = JSON.parse(String(text ?? '[]'));
    return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

/** A comma-separated operator entry → a clean list. */
function splitList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Minutes typed by an operator → an integer, or null when left blank. */
function minutes(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  return /^\d+$/.test(text) ? Number(text) : text; // a non-number travels and is refused server-side
}

/**
 * @param {{contract: any, schema: any, mount: any, el: any, client: any,
 *   fetchRows: (module: string, filter?: (row: any) => boolean) => Promise<{rows: any[], truncated: boolean}>,
 *   money: (cents: number, currency: string) => string,
 *   withBusy: (fn: () => Promise<any>) => Promise<void>, busy: any[]}} deps
 */
export async function renderServiceOperations({ contract, schema, mount, el, client, fetchRows, withBusy, busy }) {
  const meta = schema.domains?.service ?? null;
  // No package, no section: the Admin never implies a capability the server
  // does not have, and never reads a module that may not exist.
  if (!meta) return;

  const panel = el('div', 'service-operations');
  panel.setAttribute('data-contract', contract.id);
  panel.appendChild(el('h3', undefined, 'Service operations'));
  panel.appendChild(el('p', 'muted svc-coverage-limitation', COVERAGE_LIMITATION));
  mount.appendChild(panel);

  const body = el('div', 'service-body');
  panel.appendChild(body);
  body.appendChild(el('p', 'loading', 'Loading service coverage…'));

  const token = tokened();
  const clear = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  // Selection survives a re-render because it is not stored in this closure.
  const state = {
    get caseId() { return SELECTED_CASE.get(contract.id) ?? null; },
    set caseId(value) {
      if (value === null) SELECTED_CASE.delete(contract.id);
      else SELECTED_CASE.set(contract.id, value);
    },
  };

  const refresh = async () => {
    const mine = token.next();
    let data;
    try {
      const coverages = await fetchRows('service-coverage', (row) => row.contractId === contract.id);
      const coverage = coverages.rows[0] ?? null;
      if (!coverage) {
        data = { coverage: null, coverages };
      } else {
        const mineOnly = (row) => row.serviceCoverageId === coverage.id;
        const [entitlements, cases, activities, evaluations, escalations, runs] = await Promise.all([
          fetchRows('service-entitlement', mineOnly),
          fetchRows('support-case', mineOnly),
          fetchRows('support-case-activity', mineOnly),
          fetchRows('service-sla-evaluation', mineOnly),
          fetchRows('service-escalation', mineOnly),
          fetchRows('service-activation-run', mineOnly),
        ]);
        data = { coverage, coverages, entitlements, cases, activities, evaluations, escalations, runs };
      }
    } catch (error) {
      if (!token.fresh(mine)) return;
      clear(body);
      const failure = el('div', 'service-error');
      failure.appendChild(el('p', 'field-error', `Could not load service operations: ${error?.message ?? 'request failed'}`));
      const retry = el('button', 'retry', 'Retry');
      retry.setAttribute('type', 'button');
      retry.addEventListener('click', () => { void refresh(); });
      failure.appendChild(retry);
      body.appendChild(failure);
      return;
    }
    if (!token.fresh(mine)) return;
    clear(body);
    render({ data, meta, contract, body, el, client, withBusy, busy, refresh, state });
  };

  await refresh();
}

function render({ data, meta, contract, body, el, client, withBusy, busy, refresh, state }) {
  if (!data.coverage) {
    renderActivation({ meta, contract, body, el, client, withBusy, busy, refresh });
  } else {
    renderCoverage({ data, meta, body, el, client, withBusy, busy, refresh });
    renderEntitlements({ data, meta, body, el });
    renderCaseQueue({ data, meta, body, el, client, withBusy, busy, refresh, state });
  }
  body.appendChild(el('p', 'muted svc-not-modeled',
    `Not modeled anywhere in this section: ${(meta.notModeled ?? []).join(', ')}.`));
}

// ---------------------------------------------------------------------------
// 1 · Activation — read-only plan first, then one human control.
// ---------------------------------------------------------------------------

function renderActivation({ meta, contract, body, el, client, withBusy, busy, refresh }) {
  const section = el('div', 'service-activation');
  section.appendChild(el('h4', undefined, 'Service activation'));
  section.appendChild(el('p', 'muted svc-approval-boundary',
    meta.humanApproval ?? 'Activating requires a user actor; an agent is refused. This is a human-actor boundary, not Service Manager role enforcement.'));

  const policies = meta.policyFingerprints ?? [];
  if (policies.length === 0) {
    section.appendChild(el('p', 'empty',
      'No service activation policy is registered in this project, so nothing can be planned. The policy is what decides an entitlement; without one the framework refuses rather than defaults a support tier.'));
    body.appendChild(section);
    return;
  }

  const policySelect = choice(el, {
    name: 'policy', label: 'Service activation policy',
    options: policies.map((policy) => [`${policy.name}@${policy.version}`, `${policy.name} (v${policy.version})`]),
  });
  const planButton = el('button', 'plan', 'Plan service activation');
  planButton.setAttribute('type', 'button');
  const planError = el('small', 'field-error', '');
  section.appendChild(el('p', 'muted svc-plan-readonly',
    'Planning is read-only: it records nothing — no coverage, no entitlement, no audit row and no event. An agent may run it.'));
  section.appendChild(policySelect);
  section.appendChild(planButton);
  section.appendChild(planError);

  const result = el('div', 'service-plan-result');
  section.appendChild(result);
  const clearResult = () => {
    while (result.firstChild) result.removeChild(result.firstChild);
  };

  /** @param {any[]} overrides */
  const plan = async (overrides = []) => {
    planButton.disabled = true; // no double submit while the plan is in flight
    planError.textContent = '';
    const [name, version] = String(policySelect.value).split('@');
    try {
      const response = await runAction(client, 'commercial-contract', contract.id, 'plan-service-activation', {
        policy: name, policyVersion: Number(version),
        ...(overrides.length > 0 ? { overrides } : {}),
      });
      clearResult();
      renderPlan({
        contract, plan: response.result.plan, policy: { name, version: Number(version) },
        appliedOverrides: overrides, meta, result, el, client, withBusy, busy, refresh, replan: plan,
      });
    } catch (error) {
      clearResult();
      planError.textContent = error?.message ?? 'Planning failed';
    } finally {
      planButton.disabled = false;
    }
  };
  planButton.addEventListener('click', () => { void plan(); });
  section.__plan = plan;
  section.__policy = policySelect;
  body.appendChild(section);
}

function renderPlan({ contract, plan, policy, appliedOverrides, meta, result, el, client, withBusy, busy, refresh, replan }) {
  const summary = el('div', 'svc-plan-summary');
  summary.setAttribute('data-decidable', String(plan.decidable));
  summary.setAttribute('data-ambiguous', String(plan.ambiguous.length));
  summary.appendChild(el('p', 'svc-plan-counts',
    `${plan.entitlements.length} entitlement(s) decided · ${plan.ambiguous.length} undecided · policy ${plan.policy}@${plan.policyVersion}`));
  summary.appendChild(fact(el, 'Policy fingerprint', plan.policyFingerprint));
  result.appendChild(summary);

  for (const entry of plan.entitlements) {
    const row = el('div', 'svc-plan-entitlement');
    row.setAttribute('data-obligation', entry.obligationId);
    row.setAttribute('data-decided-by', entry.decidedBy);
    row.appendChild(el('p', 'svc-plan-entitlement-head',
      `${entry.label} · ${entry.supportTier} · ${entry.categories.join(', ')} · priorities ${entry.priorities.join(', ')} · first response ${entry.firstResponseTargetMinutes ?? '—'} min · resolution ${entry.resolutionTargetMinutes ?? '—'} min · ${entry.maxOpenCases === null || entry.maxOpenCases === undefined ? 'no open-case limit' : `${entry.maxOpenCases} open case(s) max`}${entry.decidedBy === 'human-override' ? ' (human decision)' : ''}`));
    row.appendChild(el('p', 'svc-plan-reason', entry.reason ?? 'no reason recorded'));
    result.appendChild(row);
  }

  /** @type {Map<string, any>} */
  const overrideControls = new Map();
  for (const entry of plan.ambiguous) {
    const row = el('div', 'svc-plan-ambiguous');
    row.setAttribute('data-obligation', entry.obligationId);
    row.appendChild(el('p', 'svc-plan-entitlement-head', entry.label));
    row.appendChild(el('p', 'svc-plan-blocked',
      `This obligation blocks activation: "${plan.policy}@${plan.policyVersion}" could not decide what it entitles the customer to, and will not guess. A defaulted support tier is a promise nobody in the business made. Decide it, and say why.`));
    row.appendChild(el('p', 'svc-plan-reason', entry.reason ?? 'no reason recorded'));
    const controls = {
      supportTier: field(el, { name: `supportTier:${entry.obligationId}`, label: 'Support tier', placeholder: 'Support tier' }),
      categories: field(el, { name: `categories:${entry.obligationId}`, label: 'Covered categories, comma separated', placeholder: 'incident, question' }),
      priorities: field(el, { name: `priorities:${entry.obligationId}`, label: 'Covered priorities, comma separated', placeholder: `${(meta.casePriorities ?? []).join(', ')}` }),
      firstResponse: field(el, { name: `firstResponse:${entry.obligationId}`, label: 'First response target in minutes', placeholder: 'Minutes' }),
      resolution: field(el, { name: `resolution:${entry.obligationId}`, label: 'Resolution target in minutes', placeholder: 'Minutes' }),
      maxOpenCases: field(el, { name: `maxOpenCases:${entry.obligationId}`, label: 'Maximum open cases, blank for none', placeholder: 'Blank for no limit' }),
      reason: field(el, { tag: 'textarea', name: `reason:${entry.obligationId}`, label: 'Why this decision', placeholder: 'Why. An unexplained decision is not evidence.' }),
    };
    for (const control of Object.values(controls)) row.appendChild(control);
    overrideControls.set(entry.obligationId, controls);
    row.__controls = controls;
    result.appendChild(row);
  }

  const collectOverrides = () => {
    const merged = new Map(appliedOverrides.map((override) => [override.serviceObligationId, override]));
    for (const [obligationId, controls] of overrideControls) {
      merged.set(obligationId, {
        serviceObligationId: obligationId,
        supportTier: String(controls.supportTier.value ?? '').trim(),
        categories: splitList(controls.categories.value),
        priorities: splitList(controls.priorities.value),
        firstResponseTargetMinutes: minutes(controls.firstResponse.value),
        resolutionTargetMinutes: minutes(controls.resolution.value),
        maxOpenCases: minutes(controls.maxOpenCases.value),
        reason: String(controls.reason.value ?? '').trim(),
      });
    }
    return [...merged.values()];
  };

  const errorLine = el('small', 'field-error', '');

  if (!plan.decidable) {
    const applyButton = el('button', 'apply-decisions', 'Apply decisions and re-plan');
    applyButton.setAttribute('type', 'button');
    busy.push(applyButton);
    const apply = async () => {
      const overrides = collectOverrides();
      if (overrides.some((override) => override.reason === '')) {
        errorLine.textContent = 'Every decision needs a reason.';
        return;
      }
      if (overrides.some((override) => override.categories.length === 0)) {
        errorLine.textContent = 'Every decision needs at least one covered category.';
        return;
      }
      applyButton.disabled = true;
      try {
        await replan(overrides);
      } finally {
        applyButton.disabled = false;
      }
    };
    applyButton.addEventListener('click', () => { void apply(); });
    result.appendChild(applyButton);
    result.appendChild(errorLine);
    // No coverage form and no activation control exist while anything is
    // undecided: the screen never offers a control the server would refuse.
    result.__apply = apply;
    result.__overrides = collectOverrides;
    return;
  }

  // ---- the coverage a human is about to activate ----
  const form = el('div', 'service-activate');
  form.appendChild(el('h5', undefined, 'Activate service coverage'));
  form.appendChild(el('p', 'muted svc-activate-limitation', COVERAGE_LIMITATION));
  const coverageKey = field(el, { name: 'coverageKey', label: 'Your key for this coverage', placeholder: 'Your key — the same key activates once' });
  const customerRef = field(el, { name: 'customerRef', label: 'Customer reference', placeholder: 'Customer reference — it authenticates nobody' });
  const startDate = field(el, { name: 'startDate', label: 'Coverage start date', type: 'date' });
  const endDate = field(el, { name: 'endDate', label: 'Coverage end date, optional', type: 'date' });
  for (const control of [coverageKey, customerRef, startDate, endDate]) form.appendChild(control);
  form.appendChild(el('small', 'muted',
    'Dates are calendar dates (YYYY-MM-DD) with no time and no timezone. They are operational, never a signed commitment, and nothing schedules, bills or renews them.'));

  const activateButton = el('button', 'activate', 'Activate service coverage');
  activateButton.setAttribute('type', 'button');
  busy.push(activateButton);
  activateButton.addEventListener('click', () => {
    void withBusy(async () => {
      errorLine.textContent = '';
      activateButton.disabled = true; // no double submit while the request is in flight
      try {
        await runAction(client, 'commercial-contract', contract.id, 'activate-service', {
          policy: policy.name, policyVersion: policy.version,
          coverageKey: coverageKey.value,
          customerRef: customerRef.value,
          startDate: String(startDate.value ?? ''),
          ...(String(endDate.value ?? '') ? { endDate: String(endDate.value) } : {}),
          ...(collectOverrides().length > 0 ? { overrides: collectOverrides() } : {}),
        });
        await refresh();
      } catch (failure) {
        // The refusal has to survive: the parent re-renders on success, so a
        // swallowed failure would wipe both this message and the typed input.
        errorLine.textContent = failure?.message ?? 'The activation was refused.';
        activateButton.disabled = false;
        throw failure;
      }
    });
  });
  form.appendChild(activateButton);
  form.appendChild(errorLine);
  result.appendChild(form);
  result.__activate = activateButton;
  result.__coverageKey = coverageKey;
  result.__customerRef = customerRef;
  result.__startDate = startDate;
  result.__endDate = endDate;
}

// ---------------------------------------------------------------------------
// 2 · ServiceCoverage detail.
// ---------------------------------------------------------------------------

function renderCoverage({ data, meta, body, el, client, withBusy, busy, refresh }) {
  const coverage = data.coverage;
  const section = el('div', 'service-coverage');
  section.setAttribute('data-coverage', coverage.id);
  section.setAttribute('data-status', coverage.status);
  section.appendChild(el('h4', undefined, `Service coverage (${coverage.status})`));
  section.appendChild(el('p', 'muted svc-coverage-meaning',
    meta.coverageMeaning ?? COVERAGE_LIMITATION));

  const run = (data.runs?.rows ?? [])[0] ?? null;
  for (const [label, value] of [
    ['Customer', `${coverage.customerNameSnapshot ?? '—'} (${coverage.customerRef})`],
    ['Window', `${coverage.startDate} → ${coverage.endDate ?? 'open-ended'}`],
    ['Entitlements', coverage.entitlementCount],
    ['Activation policy', `${coverage.policyName}@${coverage.policyVersion}`],
    ['Policy fingerprint', coverage.policyFingerprint],
    ['Activated', `${coverage.activatedBy} · ${coverage.activatedAt}`],
    ['Obligations consumed', parseList(coverage.obligationRefs).length],
    ['Human decisions at activation', run ? run.overrideCount : '—'],
    ...(coverage.status === 'ended'
      ? [['Ended', `${coverage.endedBy} · ${coverage.endedAt} — ${coverage.endedReason}`]]
      : []),
  ]) {
    section.appendChild(fact(el, label, value));
  }

  if (coverage.status === 'active') {
    section.appendChild(endControls({ coverage, el, client, withBusy, busy, refresh }));
  } else {
    section.appendChild(el('p', 'muted svc-coverage-ended',
      'This coverage has ended. Its open cases were left intact on purpose: destroying support history to make a lifecycle look tidy is not an improvement. Nothing was cancelled, credited or billed.'));
  }
  body.appendChild(section);
}

function endControls({ coverage, el, client, withBusy, busy, refresh }) {
  const controls = el('div', 'svc-coverage-end');
  controls.appendChild(el('p', 'muted',
    'Ending a coverage records that it stopped. It closes no case, cancels no subscription, reverses no obligation and bills nothing.'));
  const reason = field(el, { tag: 'textarea', name: 'reason', label: 'Why this coverage ended', placeholder: 'Why. An unexplained end is not evidence.' });
  const endDate = field(el, { name: 'endDate', label: 'End date, optional', type: 'date' });
  const error = el('small', 'field-error', '');
  const button = el('button', 'end-coverage', 'End service coverage');
  button.setAttribute('type', 'button');
  busy.push(button);
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await runAction(client, 'service-coverage', coverage.id, 'end-service-coverage', {
          reason: reason.value,
          ...(String(endDate.value ?? '') ? { endDate: String(endDate.value) } : {}),
        });
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'Ending the coverage was refused.';
        button.disabled = false;
        throw failure;
      }
    });
  });
  controls.appendChild(reason);
  controls.appendChild(endDate);
  controls.appendChild(button);
  controls.appendChild(error);
  return controls;
}

// ---------------------------------------------------------------------------
// 3 · Entitlements — immutable evidence, and never a control.
// ---------------------------------------------------------------------------

function renderEntitlements({ data, meta, body, el }) {
  const section = el('div', 'service-entitlements');
  section.appendChild(el('h4', undefined, `Entitlements (${data.entitlements.rows.length})`));
  section.appendChild(el('p', 'muted svc-entitlement-meaning',
    meta.entitlementMeaning ?? 'An entitlement is immutable evidence derived from one service obligation under a versioned, fingerprinted policy.'));
  // The Admin owns this sentence rather than deferring to package metadata: it
  // is the claim a reader would otherwise make on the framework's behalf, and
  // it must not disappear because a package shortened its own description.
  section.appendChild(el('p', 'muted svc-entitlement-not-billing',
    'An entitlement is not a billing unit, not a consumption meter and not a permission. Nothing here is charged, metered or granted by it.'));
  if (data.entitlements.truncated) {
    section.appendChild(el('p', 'muted svc-truncated',
      'More entitlements exist than this list shows. This is a display bound; every server-side check counts the real total.'));
  }
  if (data.entitlements.rows.length === 0) {
    section.appendChild(el('p', 'empty', 'This coverage carries no entitlement.'));
  }
  for (const entitlement of [...data.entitlements.rows].sort((a, b) => (a.label < b.label ? -1 : 1))) {
    const card = el('div', 'svc-entitlement');
    card.setAttribute('data-entitlement', entitlement.id);
    card.setAttribute('data-tier', entitlement.supportTier);
    card.appendChild(el('h5', undefined, entitlement.label));
    card.appendChild(fact(el, 'Support tier', entitlement.supportTier));
    card.appendChild(fact(el, 'Covered categories', parseList(entitlement.categories).join(', ') || '—'));
    card.appendChild(fact(el, 'Covered priorities', parseList(entitlement.priorities).join(', ') || '—'));
    card.appendChild(fact(el, 'First response target', entitlement.firstResponseTargetMinutes === null || entitlement.firstResponseTargetMinutes === undefined
      ? 'none' : `${entitlement.firstResponseTargetMinutes} minute(s) of elapsed wall-clock time`));
    card.appendChild(fact(el, 'Resolution target', entitlement.resolutionTargetMinutes === null || entitlement.resolutionTargetMinutes === undefined
      ? 'none' : `${entitlement.resolutionTargetMinutes} minute(s) of elapsed wall-clock time`));
    card.appendChild(fact(el, 'Open case limit', entitlement.maxOpenCases === null || entitlement.maxOpenCases === undefined
      ? 'none' : `${entitlement.maxOpenCases} open case(s)`));
    card.appendChild(fact(el, 'Effective', `${entitlement.startDate} → ${entitlement.endDate ?? 'open-ended'}`));
    card.appendChild(fact(el, 'Decided by', `${entitlement.policyName}@${entitlement.policyVersion} · ${entitlement.policyFingerprint}`));
    card.appendChild(fact(el, 'Decision reason', entitlement.decisionReason ?? 'the policy decided it directly'));
    section.appendChild(card);
  }
  body.appendChild(section);
}

// ---------------------------------------------------------------------------
// 4 · Case queue and case detail.
// ---------------------------------------------------------------------------

function renderCaseQueue({ data, meta, body, el, client, withBusy, busy, refresh, state }) {
  const section = el('div', 'service-cases');
  const cases = [...data.cases.rows].sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1));
  section.appendChild(el('h4', undefined, `Support cases (${cases.length})`));
  section.appendChild(el('p', 'muted svc-case-meaning',
    meta.caseMeaning ?? 'A support case is what a user actor recorded. No customer is authenticated and no channel is integrated.'));
  section.appendChild(el('p', 'muted svc-channel-limitation', CHANNEL_LIMITATION));
  if (data.cases.truncated) {
    section.appendChild(el('p', 'muted svc-truncated',
      'More cases exist than this queue shows. This is a display bound; the open-case limit is counted server-side over every case, not over this list.'));
  }
  if (cases.length === 0) {
    section.appendChild(el('p', 'empty', 'No support case has been recorded against this coverage.'));
  }

  for (const supportCase of cases) {
    const row = el('div', 'svc-case-row');
    row.setAttribute('data-case', supportCase.id);
    row.setAttribute('data-status', supportCase.status);
    row.setAttribute('data-priority', supportCase.priority);
    row.appendChild(el('p', 'svc-case-head',
      `${supportCase.caseNumber} · ${supportCase.title} · ${supportCase.status} · ${supportCase.priority} · ${supportCase.category} · opened ${supportCase.openedAt}`));
    const open = el('button', 'open-case', state.caseId === supportCase.id ? 'Selected' : 'Open case');
    open.setAttribute('type', 'button');
    open.setAttribute('aria-label', `Open case ${supportCase.caseNumber}`);
    open.addEventListener('click', () => {
      state.caseId = supportCase.id;
      void refresh();
    });
    row.appendChild(open);
    section.appendChild(row);
  }

  // A queue with nothing selected still has to offer the way in: recording a
  // case is done against an entitlement, because that is what bounds it.
  section.appendChild(recordCaseControls({ data, meta, el, client, withBusy, busy, refresh, state }));

  const selected = cases.find((row) => row.id === state.caseId) ?? null;
  if (selected) {
    renderCaseDetail({ data, meta, supportCase: selected, section, el, client, withBusy, busy, refresh });
  } else if (cases.length > 0) {
    section.appendChild(el('p', 'muted svc-no-selection', 'Open a case to see its activity, SLA evidence and escalations.'));
  }
  body.appendChild(section);
}

function recordCaseControls({ data, meta, el, client, withBusy, busy, refresh, state }) {
  const form = el('div', 'svc-case-record');
  form.appendChild(el('h5', undefined, 'Record a support case'));
  const open = data.entitlements.rows;
  if (data.coverage.status !== 'active' || open.length === 0) {
    form.appendChild(el('p', 'muted svc-case-record-unavailable',
      data.coverage.status !== 'active'
        ? 'This coverage is not active, so no case can be recorded against it. The server would refuse, so no control is offered.'
        : 'This coverage carries no entitlement, so there is nothing to record a case against.'));
    return form;
  }
  form.appendChild(el('p', 'muted',
    'Recording a case is a human decision: it requires a signed-in user actor and an agent is refused. Category, priority, coverage state, effective dates and the open-case limit are all enforced server-side — none of it depends on this form having filtered anything.'));
  form.appendChild(el('p', 'muted svc-case-send-limitation',
    `Nothing is emailed, called or messaged by recording a case. ${CHANNEL_LIMITATION}`));

  const entitlement = choice(el, {
    name: 'entitlement', label: 'Entitlement this case falls under',
    options: open.map((row) => [row.id, `${row.label} · ${row.supportTier}`]),
  });
  const caseKey = field(el, { name: 'caseKey', label: 'Your key for this case', placeholder: 'Your key — the same key records once' });
  const title = field(el, { name: 'title', label: 'Case title', placeholder: 'Title' });
  const description = field(el, { tag: 'textarea', name: 'description', label: 'Case description', placeholder: 'What the customer reported' });
  const category = field(el, { name: 'category', label: 'Category, which must be one the entitlement covers', placeholder: 'Category' });
  const priority = choice(el, {
    name: 'priority', label: 'Priority',
    options: (meta.casePriorities ?? []).map((value) => [value, value]),
  });
  const covered = el('small', 'muted svc-case-covered', '');
  // The selected entitlement decides what it covers, so the form follows it —
  // and the server still checks every one of these itself, because a form that
  // filtered correctly is not the same thing as a rule that is enforced.
  const followEntitlement = () => {
    const chosen = open.find((row) => row.id === String(entitlement.value)) ?? open[0];
    const priorities = parseList(chosen?.priorities);
    while (priority.firstChild) priority.removeChild(priority.firstChild);
    priority.value = '';
    for (const value of priorities.length > 0 ? priorities : (meta.casePriorities ?? [])) {
      const option = el('option', undefined, value);
      option.setAttribute('value', value);
      priority.appendChild(option);
      if (priority.value === undefined || priority.value === '') priority.value = value;
    }
    covered.textContent = `"${chosen?.label ?? '—'}" covers the categories ${parseList(chosen?.categories).join(', ') || '—'}. A category it does not cover is refused by the server, not hidden by this form.`;
  };
  followEntitlement();
  entitlement.addEventListener('change', followEntitlement);
  const source = choice(el, {
    name: 'source', label: 'Where the report came from — a label, never a verified channel',
    options: [['manual', 'manual'], ['api', 'api']],
  });
  const contactRef = field(el, { name: 'customerContactRef', label: 'Customer contact reference, optional', placeholder: 'Contact reference' });
  const ownerRef = field(el, { name: 'ownerRef', label: 'Who is looking at it — a label, not a permission', placeholder: 'Owner reference' });
  const error = el('small', 'field-error', '');
  const button = el('button', 'record-case', 'Record support case');
  button.setAttribute('type', 'button');
  busy.push(button);
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        const response = await runAction(client, 'service-entitlement', String(entitlement.value), 'record-service-case', {
          caseKey: caseKey.value,
          title: title.value,
          description: description.value,
          category: category.value,
          priority: String(priority.value),
          source: String(source.value),
          customerContactRef: contactRef.value,
          ownerRef: ownerRef.value,
        });
        // Land on what was just recorded rather than at the top of the queue.
        const recorded = response?.result?.supportCase?.id;
        if (recorded) state.caseId = recorded;
        caseKey.value = '';
        title.value = '';
        description.value = '';
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'The case was refused.';
        button.disabled = false;
        throw failure;
      }
    });
  });
  for (const control of [entitlement, covered, caseKey, title, description, category, priority, source, contactRef, ownerRef, button, error]) {
    form.appendChild(control);
  }
  form.__entitlement = entitlement;
  form.__caseKey = caseKey;
  form.__title = title;
  form.__category = category;
  form.__priority = priority;
  form.__record = button;
  return form;
}

function renderCaseDetail({ data, meta, supportCase, section, el, client, withBusy, busy, refresh }) {
  const detail = el('div', 'svc-case-detail');
  detail.setAttribute('data-case', supportCase.id);
  detail.setAttribute('data-status', supportCase.status);
  detail.appendChild(el('h5', undefined, `${supportCase.caseNumber} · ${supportCase.title}`));
  for (const [label, value] of [
    ['Status', supportCase.status],
    ['Priority', supportCase.priority],
    ['Category', supportCase.category],
    ['Source', `${supportCase.source} — a label for where the report came from, never a verified channel`],
    ['Description', supportCase.description ?? '—'],
    ['Customer', `${supportCase.customerRef}${supportCase.customerContactRef ? ` · ${supportCase.customerContactRef}` : ''}`],
    ['Owner', supportCase.ownerRef ?? 'unassigned'],
    ['Opened', `${supportCase.openedBy} · ${supportCase.openedAt}`],
    ['First response due', supportCase.firstResponseDueAt ?? 'no target'],
    ['First response recorded', supportCase.firstRespondedAt ?? 'not yet'],
    ['Resolution due', supportCase.resolutionDueAt ?? 'no target'],
    ['Resolved', supportCase.resolvedAt ?? 'not yet'],
    ['Resolution summary', supportCase.resolutionSummary ?? '—'],
    ['Closed', supportCase.closedAt ?? 'not yet'],
  ]) {
    detail.appendChild(fact(el, label, value));
  }
  detail.appendChild(el('p', 'muted svc-case-authentication',
    'No customer was authenticated to open, answer or close this case, and the visibility label on any activity is an assertion by whoever recorded it — never an access grant.'));

  renderCaseControls({ supportCase, meta, detail, el, client, withBusy, busy, refresh });
  renderActivities({ data, supportCase, detail, el });
  renderSla({ data, meta, supportCase, detail, el, client, withBusy, busy, refresh });
  renderEscalations({ data, supportCase, detail, el, client, withBusy, busy, refresh });
  section.appendChild(detail);
}

function renderCaseControls({ supportCase, meta, detail, el, client, withBusy, busy, refresh }) {
  const controls = el('div', 'svc-case-controls');
  const transitions = (meta.caseTransitions ?? {})[supportCase.status] ?? [];

  // First response: offered only while the server would accept it.
  if (!supportCase.firstRespondedAt && transitions.length > 0) {
    const block = el('div', 'svc-first-response');
    block.appendChild(el('p', 'muted', 'A first response has one moment: it is stamped once, and recording it does not send anything.'));
    const note = field(el, { tag: 'textarea', name: 'note', label: 'What the first response was', placeholder: 'What was said' });
    const visibility = choice(el, {
      name: 'visibility', label: 'Visibility — an assertion by the recorder, never an access grant',
      options: (meta.visibility ?? ['internal', 'customer_visible']).map((value) => [value, value]),
    });
    const error = el('small', 'field-error', '');
    const button = el('button', 'first-response', 'Record first response');
    button.setAttribute('type', 'button');
    busy.push(button);
    button.addEventListener('click', () => {
      void withBusy(async () => {
        error.textContent = '';
        button.disabled = true;
        try {
          await runAction(client, 'support-case', supportCase.id, 'record-first-response', {
            note: note.value, visibility: String(visibility.value),
          });
          await refresh();
        } catch (failure) {
          error.textContent = failure?.message ?? 'The first response was refused.';
          button.disabled = false;
          throw failure;
        }
      });
    });
    for (const node of [note, visibility, button, error]) block.appendChild(node);
    controls.appendChild(block);
  }

  // Transitions: exactly the moves the server's declared table allows.
  const move = el('div', 'svc-case-transition');
  if (transitions.length === 0) {
    move.appendChild(el('p', 'muted svc-case-terminal',
      'This case is closed. No transition is offered, because the server would refuse every one of them.'));
  } else {
    move.appendChild(el('p', 'muted',
      'Nothing moves on a clock. Every move is a human recording one, and only the moves the server declares are offered.'));
    const toStatus = choice(el, {
      name: 'toStatus', label: 'Move this case to', options: transitions.map((value) => [value, value]),
    });
    const note = field(el, { tag: 'textarea', name: 'transitionNote', label: 'Note for this move', placeholder: 'Optional note' });
    const summary = field(el, {
      tag: 'textarea', name: 'resolutionSummary', label: 'Resolution summary, required when resolving',
      placeholder: 'Required when resolving — a resolution nobody described is not evidence',
    });
    const error = el('small', 'field-error', '');
    const button = el('button', 'transition', 'Move case');
    button.setAttribute('type', 'button');
    busy.push(button);
    button.addEventListener('click', () => {
      void withBusy(async () => {
        error.textContent = '';
        button.disabled = true;
        try {
          await runAction(client, 'support-case', supportCase.id, 'transition-case', {
            toStatus: String(toStatus.value), note: note.value, resolutionSummary: summary.value,
          });
          await refresh();
        } catch (failure) {
          error.textContent = failure?.message ?? 'The move was refused.';
          button.disabled = false;
          throw failure;
        }
      });
    });
    for (const node of [toStatus, note, summary, button, error]) move.appendChild(node);
    move.appendChild(el('p', 'muted svc-transition-limitation',
      'Moving a case to resolved or closed accepts nothing on the customer\'s behalf and bills nothing.'));
    move.__toStatus = toStatus;
    move.__summary = summary;
  }
  controls.appendChild(move);

  // Append-only activity.
  const activity = el('div', 'svc-case-activity-record');
  activity.appendChild(el('p', 'muted',
    'Activity is append-only. A recorded customer reply is what somebody reported, not a message received through an integration, and no attachment bytes are stored.'));
  const activityKey = field(el, { name: 'activityKey', label: 'Your key for this activity', placeholder: 'Your key — the same key records once' });
  const type = choice(el, {
    name: 'activityType', label: 'Activity type',
    options: [['note', 'note'], ['internal_note', 'internal note'], ['customer_reply', 'customer reply (as reported)']],
  });
  const bodyText = field(el, { tag: 'textarea', name: 'body', label: 'What happened', placeholder: 'What happened' });
  const visibility = choice(el, {
    name: 'activityVisibility', label: 'Visibility — an assertion by the recorder, never an access grant',
    options: (meta.visibility ?? ['internal', 'customer_visible']).map((value) => [value, value]),
  });
  const evidenceRef = field(el, { name: 'evidenceRef', label: 'Your own evidence reference, optional', placeholder: 'Nothing is stored or fetched from this' });
  const activityError = el('small', 'field-error', '');
  const activityButton = el('button', 'record-activity', 'Record activity');
  activityButton.setAttribute('type', 'button');
  busy.push(activityButton);
  activityButton.addEventListener('click', () => {
    void withBusy(async () => {
      activityError.textContent = '';
      activityButton.disabled = true;
      try {
        await runAction(client, 'support-case', supportCase.id, 'record-case-activity', {
          activityKey: activityKey.value, type: String(type.value), body: bodyText.value,
          visibility: String(visibility.value), evidenceRef: evidenceRef.value,
        });
        activityKey.value = '';
        bodyText.value = '';
        await refresh();
      } catch (failure) {
        activityError.textContent = failure?.message ?? 'The activity was refused.';
        activityButton.disabled = false;
        throw failure;
      }
    });
  });
  for (const node of [activityKey, type, bodyText, visibility, evidenceRef, activityButton, activityError]) {
    activity.appendChild(node);
  }
  activity.__key = activityKey;
  activity.__body = bodyText;
  activity.__record = activityButton;
  controls.appendChild(activity);
  detail.appendChild(controls);
}

function renderActivities({ data, supportCase, detail, el }) {
  const section = el('div', 'svc-case-activities');
  const rows = data.activities.rows.filter((row) => row.supportCaseId === supportCase.id);
  section.appendChild(el('h5', undefined, `Activity (${rows.length})`));
  if (data.activities.truncated) {
    section.appendChild(el('p', 'muted svc-truncated',
      'More activity exists than this list shows. This is a display bound only.'));
  }
  if (rows.length === 0) section.appendChild(el('p', 'empty', 'Nothing has been recorded against this case yet.'));
  for (const row of [...rows].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))) {
    const entry = el('p', 'svc-activity');
    entry.setAttribute('data-activity', row.id);
    entry.setAttribute('data-type', row.type);
    entry.textContent = `${row.occurredAt} · ${row.type} · ${row.visibility} · ${row.recordedBy}${row.fromStatus ? ` · ${row.fromStatus} → ${row.toStatus}` : ''} — ${row.body ?? 'no body recorded'}`;
    section.appendChild(entry);
  }
  detail.appendChild(section);
}

function renderSla({ data, meta, supportCase, detail, el, client, withBusy, busy, refresh }) {
  const section = el('div', 'svc-case-sla');
  section.appendChild(el('h5', undefined, 'SLA'));
  section.appendChild(el('p', 'muted svc-sla-basis',
    meta.slaBasis ?? 'Elapsed wall-clock minutes from openedAt. No business hours, no holidays, no paused clock.'));
  section.appendChild(el('p', 'muted svc-sla-not-legal',
    'A "breached" state here means an elapsed-time target somebody typed was passed. It is not a contractual or legal determination, nothing is credited or refunded by it, and nobody was notified.'));

  // ---- current: computed on demand, never stored, and never confused with
  // the recorded evidence below.
  const current = el('div', 'svc-sla-current');
  current.appendChild(el('h6', undefined, 'Current, not recorded'));
  const currentValue = el('p', 'svc-sla-current-value', 'Not previewed yet.');
  const currentError = el('small', 'field-error', '');
  const previewButton = el('button', 'preview-sla', 'Preview SLA now');
  previewButton.setAttribute('type', 'button');
  previewButton.addEventListener('click', async () => {
    // Read-only and open to an agent: it is deliberately NOT wrapped in the
    // parent's re-render, because previewing must not disturb the page.
    currentError.textContent = '';
    previewButton.disabled = true;
    try {
      const response = await runAction(client, 'support-case', supportCase.id, 'preview-sla', {});
      const preview = response.result.slaPreview;
      currentValue.textContent =
        `At ${preview.evaluatedAt}: first response ${preview.firstResponseState}, resolution ${preview.resolutionState}. This preview records nothing.`;
      currentValue.setAttribute('data-first-response', preview.firstResponseState);
      currentValue.setAttribute('data-resolution', preview.resolutionState);
    } catch (failure) {
      currentError.textContent = failure?.message ?? 'The preview failed.';
    } finally {
      previewButton.disabled = false;
    }
  });
  current.appendChild(el('p', 'muted', 'A preview is what the clock says at the instant you ask. It writes nothing — no record, no audit row and no event — and an agent may run it.'));
  current.appendChild(previewButton);
  current.appendChild(currentValue);
  current.appendChild(currentError);
  current.__preview = previewButton;
  current.__value = currentValue;
  section.appendChild(current);

  // ---- persisted: evidence about a stated instant, never current truth.
  const persisted = el('div', 'svc-sla-persisted');
  const rows = data.evaluations.rows.filter((row) => row.supportCaseId === supportCase.id);
  persisted.appendChild(el('h6', undefined, `Recorded evaluations (${rows.length})`));
  persisted.appendChild(el('p', 'muted svc-sla-persisted-meaning',
    'A recorded evaluation is what the clock said at the instant it was taken, stored with every input it used. It is evidence about a moment and is never updated to match the present.'));
  if (rows.length === 0) persisted.appendChild(el('p', 'empty', 'No SLA evaluation has been recorded for this case.'));
  for (const row of [...rows].sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? -1 : 1))) {
    const entry = el('p', 'svc-sla-evaluation');
    entry.setAttribute('data-evaluation', row.id);
    entry.setAttribute('data-first-response', row.firstResponseState);
    entry.setAttribute('data-resolution', row.resolutionState);
    entry.textContent =
      `${row.evaluatedAt} · first response ${row.firstResponseState} (due ${row.firstResponseDueAt ?? 'no target'}, answered ${row.firstRespondedAt ?? 'not yet'}) · resolution ${row.resolutionState} (due ${row.resolutionDueAt ?? 'no target'}, resolved ${row.resolvedAt ?? 'not yet'}) · recorded by ${row.recordedBy}`;
    persisted.appendChild(entry);
  }

  const key = field(el, { name: 'evaluationKey', label: 'Your key for this evaluation', placeholder: 'Your key — the same key records once' });
  const error = el('small', 'field-error', '');
  const button = el('button', 'record-sla', 'Record SLA evaluation');
  button.setAttribute('type', 'button');
  busy.push(button);
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await runAction(client, 'support-case', supportCase.id, 'record-sla-evaluation', { evaluationKey: key.value });
        key.value = '';
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'The evaluation was refused.';
        button.disabled = false;
        throw failure;
      }
    });
  });
  persisted.appendChild(key);
  persisted.appendChild(button);
  persisted.appendChild(error);
  persisted.__key = key;
  persisted.__record = button;
  section.appendChild(persisted);
  detail.appendChild(section);
}

function renderEscalations({ data, supportCase, detail, el, client, withBusy, busy, refresh }) {
  const section = el('div', 'svc-case-escalations');
  const rows = data.escalations.rows.filter((row) => row.supportCaseId === supportCase.id);
  const evaluations = data.evaluations.rows.filter((row) => row.supportCaseId === supportCase.id);
  section.appendChild(el('h5', undefined, `Escalations (${rows.length})`));
  section.appendChild(el('p', 'muted svc-escalation-meaning',
    'An escalation is recorded evidence that a human escalated. Nothing is routed, assigned or scheduled by it, and a target is a label rather than a permission.'));
  section.appendChild(el('p', 'muted svc-escalation-notification', NOTIFICATION_LIMITATION));
  if (rows.length === 0) section.appendChild(el('p', 'empty', 'Nobody has escalated this case.'));
  for (const row of [...rows].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1))) {
    const entry = el('p', 'svc-escalation');
    entry.setAttribute('data-escalation', row.id);
    entry.setAttribute('data-level', row.level);
    entry.textContent = `${row.recordedAt} · ${row.level} · ${row.targetRef ?? 'no target named'} · ${row.recordedBy} — ${row.reason}${row.slaEvaluationId ? ` · rests on evaluation ${row.slaEvaluationId}` : ''}`;
    section.appendChild(entry);
  }

  const key = field(el, { name: 'escalationKey', label: 'Your key for this escalation', placeholder: 'Your key — the same key records once' });
  const level = choice(el, {
    name: 'level', label: 'Escalation level',
    options: [['internal', 'internal'], ['management', 'management'], ['vendor', 'vendor']],
  });
  const reason = field(el, { tag: 'textarea', name: 'escalationReason', label: 'Why this case is escalated', placeholder: 'Why. An unexplained escalation is not evidence.' });
  const targetRef = field(el, { name: 'targetRef', label: 'Who it was escalated to — a label, not a permission', placeholder: 'Target reference' });
  const evaluation = choice(el, {
    name: 'slaEvaluationId', label: 'The recorded SLA evaluation this rests on, if any',
    options: [['', 'no recorded evaluation'], ...evaluations.map((row) => [row.id, `${row.evaluatedAt} · ${row.firstResponseState}/${row.resolutionState}`])],
  });
  const evidenceRef = field(el, { name: 'escalationEvidenceRef', label: 'Your own evidence reference, optional', placeholder: 'Nothing is stored or fetched from this' });
  const error = el('small', 'field-error', '');
  const button = el('button', 'record-escalation', 'Record escalation');
  button.setAttribute('type', 'button');
  busy.push(button);
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await runAction(client, 'support-case', supportCase.id, 'record-escalation', {
          escalationKey: key.value, level: String(level.value), reason: reason.value,
          targetRef: targetRef.value, evidenceRef: evidenceRef.value,
          ...(String(evaluation.value ?? '') ? { slaEvaluationId: String(evaluation.value) } : {}),
        });
        key.value = '';
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'The escalation was refused.';
        button.disabled = false;
        throw failure;
      }
    });
  });
  for (const node of [key, level, reason, targetRef, evaluation, evidenceRef, button, error]) section.appendChild(node);
  section.__key = key;
  section.__reason = reason;
  section.__record = button;
  detail.appendChild(section);
}
