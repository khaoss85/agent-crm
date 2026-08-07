// @ts-check

/**
 * Delivery Change & Acceptance Admin (Milestone 14b2, the delivery package).
 *
 * It renders only when `/api/schema` publishes `delivery.changeAcceptance`, so
 * it disappears with the package rather than degrading into a broken control.
 *
 * The screen's job is to keep three claims impossible to misread, because each
 * one is a claim a user would otherwise make on the framework's behalf:
 *
 *   a commercial change was handed off — **no Quote, Order or Contract has been
 *     amended**, and there is deliberately no commercial-approval control here;
 *   a deliverable was completed — **completed work is not customer acceptance**;
 *   acceptance was recorded — **by a user actor**, not by an authenticated
 *     customer, not as a legal signature, and not as authorization to bill.
 *
 * Admin rules as everywhere: text is text, the server owns every state, a
 * control appears only where the server would accept it, and a control disables
 * while its request is in flight.
 */

/**
 * Invoke a package action over the Admin's own request client.
 *
 * The Admin client is a thin `request(path, options)` wrapper, not the SDK — it
 * has no `module().action()`. Building the route here keeps this section using
 * the same single HTTP surface every other Admin section uses.
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
  return {
    next: () => ++current,
    fresh: (token) => token === current,
  };
}

/**
 * @param {{project: any, schema: any, mount: any, el: any, client: any,
 *   fetchRows: (module: string, filter?: (row: any) => boolean) => Promise<{rows: any[], truncated: boolean}>,
 *   money: (cents: number, currency: string) => string,
 *   withBusy: (fn: () => Promise<any>) => Promise<void>, busy: any[]}} deps
 */
export async function renderDeliveryChangeAcceptance({ project, schema, mount, el, client, fetchRows, money, withBusy, busy }) {
  const meta = schema.domains?.delivery?.changeAcceptance ?? null;
  if (!meta) return;

  const panel = el('div', 'delivery-change-acceptance');
  panel.setAttribute('data-project', project.id);
  panel.appendChild(el('h3', undefined, 'Delivery change & acceptance'));
  mount.appendChild(panel);

  const body = el('div', 'change-acceptance-body');
  panel.appendChild(body);
  const loading = el('p', 'loading', 'Loading change and acceptance evidence…');
  body.appendChild(loading);

  const token = tokened();

  const clear = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  /** Re-read everything this section shows, discarding a stale answer. */
  const refresh = async () => {
    const mine = token.next();
    let data;
    try {
      const mineOnly = (row) => row.deliveryProjectId === project.id;
      const [changes, revisions, candidates, deliverables, requests, evidence] = await Promise.all([
        fetchRows('delivery-change-request', mineOnly),
        fetchRows('delivery-plan-revision', mineOnly),
        fetchRows('delivery-commercial-change', mineOnly),
        fetchRows('delivery-deliverable', mineOnly),
        fetchRows('delivery-acceptance-request', mineOnly),
        fetchRows('delivery-acceptance-evidence', mineOnly),
      ]);
      data = { changes, revisions, candidates, deliverables, requests, evidence };
    } catch (error) {
      if (!token.fresh(mine)) return;
      clear(body);
      const failure = el('div', 'change-acceptance-error');
      failure.appendChild(el('p', 'field-error', `Could not load change and acceptance evidence: ${error?.message ?? 'request failed'}`));
      const retry = el('button', 'retry', 'Retry');
      retry.addEventListener('click', () => { void refresh(); });
      failure.appendChild(retry);
      body.appendChild(failure);
      return;
    }
    if (!token.fresh(mine)) return;
    clear(body);
    render({ data, meta, project, body, el, client, money, withBusy, busy, refresh });
  };

  await refresh();
}

function render({ data, meta, project, body, el, client, money, withBusy, busy, refresh }) {
  renderChangeRequests({ data, meta, project, body, el, client, money, withBusy, busy, refresh });
  renderRevisions({ data, body, el });
  renderCandidates({ data, meta, body, el, money, client, withBusy, busy, refresh });
  renderDeliverables({ data, meta, project, body, el, client, withBusy, busy, refresh });
  renderAcceptance({ data, meta, body, el, client, withBusy, busy, refresh });

  body.appendChild(el('p', 'muted change-acceptance-not-modeled',
    `Not modeled anywhere in this section: ${(meta.notModeled ?? []).join(', ')}.`));
}

/** A labelled fact row. Values are text, always — never markup. */
function fact(el, label, value) {
  const row = el('p', 'ca-fact');
  row.appendChild(el('strong', undefined, `${label}: `));
  row.appendChild(el('span', undefined, String(value ?? '—')));
  return row;
}

function renderChangeRequests({ data, meta, project, body, el, client, money, withBusy, busy, refresh }) {
  const section = el('div', 'change-requests');
  section.appendChild(el('h4', undefined, `Change requests (${data.changes.rows.length})`));
  section.appendChild(el('p', 'muted ca-approval-boundary',
    meta.humanApproval ?? 'Deciding is a human-actor boundary, not Delivery Manager or Finance role enforcement.'));

  if (data.changes.truncated) {
    section.appendChild(el('p', 'muted ca-truncated',
      'More change requests exist than this list shows. This list is a display bound; no decision here depends on it.'));
  }

  if (data.changes.rows.length === 0) {
    section.appendChild(el('p', 'empty', 'No change has been proposed for this project.'));
  }

  const revisionByChange = new Map(data.revisions.rows.map((row) => [row.deliveryChangeRequestId, row]));
  const candidateByChange = new Map(data.candidates.rows.map((row) => [row.deliveryChangeRequestId, row]));

  for (const change of [...data.changes.rows].sort((a, b) => (a.proposedAt < b.proposedAt ? -1 : 1))) {
    const card = el('div', 'change-request');
    card.setAttribute('data-change-request', change.id);
    card.setAttribute('data-status', change.status);
    card.setAttribute('data-change-type', change.changeType);
    card.appendChild(el('h5', undefined, change.title));
    card.appendChild(fact(el, 'Type', change.changeType === 'commercial_change_required'
      ? 'commercial change required' : 'non-commercial replan'));
    card.appendChild(fact(el, 'Status', change.status));
    card.appendChild(fact(el, 'Reason', change.reason));
    card.appendChild(fact(el, 'Requested scope', change.requestedScope));
    card.appendChild(fact(el, 'Requested dates', change.requestedStartDate || change.requestedEndDate
      ? `${change.requestedStartDate ?? '—'} → ${change.requestedEndDate ?? '—'}` : 'unchanged'));
    if (change.commercialDeltaCents !== null && change.commercialDeltaCents !== undefined) {
      const delta = el('p', 'ca-fact ca-commercial-delta');
      delta.appendChild(el('strong', undefined, 'Commercial delta: '));
      delta.appendChild(el('span', undefined, money(change.commercialDeltaCents, change.currency)));
      card.appendChild(delta);
      card.appendChild(el('p', 'muted ca-delta-caveat',
        'Planning evidence only. Nothing is priced, quoted, recognized or invoiced from this figure.'));
    }
    card.appendChild(fact(el, 'Proposed', `${change.proposedBy} · ${change.proposedAt}`));
    if (change.decidedAt) {
      card.appendChild(fact(el, 'Decided', `${change.decidedBy} · ${change.decidedAt}`));
      card.appendChild(fact(el, 'Decision reason', change.decisionReason));
    }

    const revision = revisionByChange.get(change.id);
    if (revision) {
      const link = el('p', 'ca-outcome ca-outcome-revision');
      link.setAttribute('data-plan-revision', revision.id);
      link.textContent = `Produced plan revision v${revision.version}.`;
      card.appendChild(link);
    }
    const candidate = candidateByChange.get(change.id);
    if (candidate) {
      const link = el('p', 'ca-outcome ca-outcome-candidate');
      link.setAttribute('data-commercial-change', candidate.id);
      link.textContent = 'Raised a commercial change candidate — commercial follow-up required.';
      card.appendChild(link);
    }

    // Decision controls exist only where the server would accept them.
    if (change.status === 'proposed') {
      card.appendChild(decisionControls({ change, el, client, withBusy, busy, refresh }));
    }
    section.appendChild(card);
  }

  section.appendChild(proposeControls({ project, el, client, withBusy, busy, refresh }));
  body.appendChild(section);
}

function decisionControls({ change, el, client, withBusy, busy, refresh }) {
  const controls = el('div', 'change-decision');
  const reason = el('textarea');
  reason.setAttribute('name', 'decisionReason');
  reason.setAttribute('aria-label', 'Why this change is approved or rejected');
  reason.setAttribute('placeholder', 'Why. An unexplained decision is not evidence.');
  const error = el('small', 'field-error', '');
  const approve = el('button', 'approve', 'Approve');
  const reject = el('button', 'reject', 'Reject');
  approve.setAttribute('type', 'button');
  reject.setAttribute('type', 'button');

  const decide = (decision) => async () => {
    error.textContent = '';
    approve.disabled = true;
    reject.disabled = true;
    try {
      await runAction(client, 'delivery-change-request', change.id, 'decide-change-request', {
        decision, reason: reason.value,
      });
      await refresh();
    } catch (failure) {
      // The typed reason survives a validation error: retyping it is how an
      // operator ends up writing a shorter, worse one.
      error.textContent = failure?.message ?? 'The decision was refused.';
      approve.disabled = false;
      reject.disabled = false;
    }
  };
  approve.addEventListener('click', () => { void withBusy(decide('approve')); });
  reject.addEventListener('click', () => { void withBusy(decide('reject')); });
  busy.push(approve, reject);

  controls.appendChild(reason);
  controls.appendChild(approve);
  controls.appendChild(reject);
  controls.appendChild(error);
  return controls;
}

function proposeControls({ project, el, client, withBusy, busy, refresh }) {
  const form = el('div', 'change-propose');
  form.appendChild(el('h5', undefined, 'Propose a change'));

  const key = el('input');
  key.setAttribute('name', 'changeKey');
  key.setAttribute('aria-label', 'Your identifier for this change');
  key.setAttribute('placeholder', 'Your key for this change');
  const type = el('select');
  type.setAttribute('name', 'changeType');
  type.setAttribute('aria-label', 'Change type');
  for (const [value, label] of [
    ['non_commercial_replan', 'Non-commercial replan'],
    ['commercial_change_required', 'Commercial change required'],
  ]) {
    const option = el('option', undefined, label);
    option.setAttribute('value', value);
    type.appendChild(option);
    if (!type.value) type.value = value;
  }
  const title = el('input');
  title.setAttribute('name', 'title');
  title.setAttribute('aria-label', 'Change title');
  const reason = el('textarea');
  reason.setAttribute('name', 'reason');
  reason.setAttribute('aria-label', 'Why this change is needed');
  const error = el('small', 'field-error', '');
  const submit = el('button', 'propose', 'Propose change');
  submit.setAttribute('type', 'button');

  submit.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      submit.disabled = true; // no double submit while the request is in flight
      try {
        await runAction(client, 'delivery-project', project.id, 'propose-change-request', {
          changeKey: key.value, changeType: type.value, title: title.value, reason: reason.value,
        });
        key.value = '';
        title.value = '';
        reason.value = '';
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'The change was refused.';
      } finally {
        submit.disabled = false;
      }
    });
  });
  busy.push(submit);

  form.appendChild(key);
  form.appendChild(type);
  form.appendChild(title);
  form.appendChild(reason);
  form.appendChild(submit);
  form.appendChild(error);
  form.appendChild(el('p', 'muted',
    'A proposal records nothing beyond itself: it does not replan, re-price or change any commercial record.'));
  return form;
}

function renderRevisions({ data, body, el }) {
  const section = el('div', 'plan-revisions');
  section.appendChild(el('h4', undefined, `Plan revisions (${data.revisions.rows.length})`));
  if (data.revisions.rows.length === 0) {
    section.appendChild(el('p', 'empty', 'No approved replan has produced a revision yet.'));
  }
  const ordered = [...data.revisions.rows].sort((a, b) => a.version - b.version);
  for (const [index, revision] of ordered.entries()) {
    const card = el('div', 'plan-revision');
    card.setAttribute('data-plan-revision', revision.id);
    card.setAttribute('data-version', String(revision.version));
    if (index === ordered.length - 1) card.setAttribute('data-latest', 'true');
    card.appendChild(el('h5', undefined, `Revision v${revision.version}${index === ordered.length - 1 ? ' (latest)' : ''}`));
    card.appendChild(fact(el, 'From change request', revision.deliveryChangeRequestId));
    card.appendChild(fact(el, 'Previous revision', index === 0 ? 'the original handover plan' : `v${ordered[index - 1].version}`));
    card.appendChild(fact(el, 'Revised scope', revision.revisedScope));
    card.appendChild(fact(el, 'Revised dates', `${revision.revisedStartDate ?? '—'} → ${revision.revisedEndDate ?? '—'}`));
    card.appendChild(fact(el, 'Reason', revision.reason));
    card.appendChild(fact(el, 'Recorded', `${revision.createdBy} · ${revision.revisedAt}`));
    section.appendChild(card);
  }
  section.appendChild(el('p', 'muted ca-revision-immutability',
    'A revision describes what is planned from here. The original M13 handover snapshot and all completed execution history are unchanged — revisions are added, never applied backwards.'));
  body.appendChild(section);
}

function renderCandidates({ data, meta, body, el, money, client, withBusy, busy, refresh }) {
  const section = el('div', 'commercial-changes');
  section.appendChild(el('h4', undefined, `Commercial change candidates (${data.candidates.rows.length})`));
  if (data.candidates.rows.length === 0) {
    section.appendChild(el('p', 'empty', 'No commercial follow-up is outstanding.'));
  }
  for (const candidate of data.candidates.rows) {
    const card = el('div', 'commercial-change');
    card.setAttribute('data-commercial-change', candidate.id);
    card.setAttribute('data-status', candidate.status);
    card.appendChild(el('h5', undefined, candidate.status === 'pending_commercial_followup'
      ? 'Commercial follow-up required'
      : 'Commercial follow-up recorded'));
    card.appendChild(fact(el, 'Summary', candidate.summary));
    if (candidate.estimatedDeltaCents !== null && candidate.estimatedDeltaCents !== undefined) {
      card.appendChild(fact(el, 'Estimated delta', money(candidate.estimatedDeltaCents, candidate.currency)));
    }
    card.appendChild(fact(el, 'From change request', candidate.deliveryChangeRequestId));
    card.appendChild(fact(el, 'Raised', `${candidate.raisedBy} · ${candidate.raisedAt}`));
    // The sentence this whole section exists to make unmissable.
    const warning = el('p', 'ca-commercial-warning');
    warning.textContent = 'No Quote, Order or Contract has been amended. This is a candidate for a commercial amendment that does not exist yet.';
    card.appendChild(warning);
    if (candidate.status === 'pending_commercial_followup') {
      card.appendChild(resolveControl({ candidate, el, client, withBusy, busy, refresh }));
    } else {
      card.appendChild(fact(el, 'Outcome', candidate.status === 'withdrawn'
        ? 'withdrawn — nobody is pursuing it'
        : 'settled outside this application'));
      card.appendChild(fact(el, 'Reason', candidate.resolutionReason));
      card.appendChild(fact(el, 'Reference', candidate.resolutionEvidenceRef));
      card.appendChild(fact(el, 'Recorded', `${candidate.resolvedBy} · ${candidate.resolvedAt}`));
      const settled = el('p', 'ca-commercial-resolved');
      settled.textContent = 'Recording this outcome amended nothing. It says a human closed the commercial question elsewhere, which is what lets acceptance be requested over this scope again.';
      card.appendChild(settled);
    }
    section.appendChild(card);
  }
  section.appendChild(el('p', 'muted ca-commercial-boundary',
    meta.commercialBoundary ?? 'A commercial change raises a candidate and stops. Nothing here alters a commercial record.'));
  // Still deliberately no *approval* control: Delivery does not own commercial
  // truth, and recording that somebody else settled the question is not the
  // same act as settling it here.
  body.appendChild(section);
}

/**
 * Record what the commercial follow-up concluded — outside this application.
 *
 * Without it a raised candidate is a dead end that blocks acceptance evidence
 * for the rest of the project's life. The copy has to carry the whole weight of
 * the distinction, because the control sits next to money: this records an
 * outcome, it does not produce one, and nothing commercial moves.
 */
function resolveControl({ candidate, el, client, withBusy, busy, refresh }) {
  const controls = el('div', 'commercial-change-resolve');
  controls.appendChild(el('p', 'muted ca-resolve-note',
    'Record what the commercial follow-up concluded elsewhere. This amends nothing here: no Quote, Order, Contract or Subscription is created or altered, and no amount is recognized.'));
  const resolution = el('select');
  resolution.setAttribute('name', 'resolution');
  resolution.setAttribute('aria-label', 'What the commercial follow-up concluded');
  for (const [value, label] of [
    ['resolved_externally', 'Settled outside this application'],
    ['withdrawn', 'Withdrawn — nobody is pursuing it'],
  ]) {
    const option = el('option', undefined, label);
    option.setAttribute('value', value);
    resolution.appendChild(option);
    if (!resolution.value) resolution.value = value;
  }
  const reason = el('input');
  reason.setAttribute('name', 'reason');
  reason.setAttribute('aria-label', 'What was settled, in your words');
  const evidence = el('input');
  evidence.setAttribute('name', 'evidenceRef');
  evidence.setAttribute('aria-label', 'Your reference to the amendment or decision, optional');
  const error = el('small', 'field-error', '');
  const button = el('button', 'resolve', 'Record follow-up outcome');
  button.setAttribute('type', 'button');
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await runAction(client, 'delivery-commercial-change', candidate.id, 'resolve-commercial-change', {
          resolution: resolution.value,
          reason: reason.value,
          ...(evidence.value === '' ? {} : { evidenceRef: evidence.value }),
        });
        await refresh();
      } catch (failure) {
        // The typed input survives a refusal: retyping a reason because the
        // server said no is the fastest way to lose the reason.
        error.textContent = failure?.message ?? 'Recording the outcome was refused.';
        button.disabled = false;
      }
    });
  });
  busy.push(button);
  for (const node of [resolution, reason, evidence, button, error]) controls.appendChild(node);
  return controls;
}

function renderDeliverables({ data, meta, project, body, el, client, withBusy, busy, refresh }) {
  const section = el('div', 'deliverables');
  section.appendChild(el('h4', undefined, `Deliverables (${data.deliverables.rows.length})`));
  if (data.deliverables.rows.length === 0) {
    section.appendChild(el('p', 'empty', 'Nothing has been planned as a deliverable on this project.'));
  }
  const frozenMilestones = new Set(
    data.requests.rows.filter((row) => row.status === 'pending').map((row) => row.deliveryMilestoneId),
  );

  for (const deliverable of [...data.deliverables.rows].sort((a, b) => (a.label < b.label ? -1 : 1))) {
    const card = el('div', 'deliverable');
    card.setAttribute('data-deliverable', deliverable.id);
    card.setAttribute('data-status', deliverable.status);
    card.appendChild(el('h5', undefined, deliverable.label));
    card.appendChild(fact(el, 'Work package', deliverable.deliveryWorkPackageId));
    card.appendChild(fact(el, 'Milestone', deliverable.deliveryMilestoneId ?? 'not tied to a milestone'));
    card.appendChild(fact(el, 'Scope', deliverable.scopeSnapshot));
    card.appendChild(fact(el, 'Status', deliverable.status));
    if (deliverable.status === 'completed') {
      card.appendChild(fact(el, 'Completion evidence', deliverable.completionEvidenceRef));
      card.appendChild(fact(el, 'Completed', `${deliverable.completedBy} · ${deliverable.completedAt}`));
      const caveat = el('p', 'ca-completion-caveat');
      caveat.textContent = 'Work completed is not customer acceptance. Those are two facts with two different authors.';
      card.appendChild(caveat);
    } else if (!frozenMilestones.has(deliverable.deliveryMilestoneId)) {
      card.appendChild(completeControl({ deliverable, el, client, withBusy, busy, refresh }));
    }
    section.appendChild(card);
  }
  section.appendChild(planDeliverableControls({ data, project, el, client, withBusy, busy, refresh }));
  body.appendChild(section);
  if (meta.deliverableStates) {
    section.appendChild(el('p', 'muted', `Deliverable states: ${meta.deliverableStates.join(' → ')}. No file, binary or document is stored.`));
  }
}

function completeControl({ deliverable, el, client, withBusy, busy, refresh }) {
  const controls = el('div', 'deliverable-complete');
  const evidence = el('input');
  evidence.setAttribute('name', 'completionEvidenceRef');
  evidence.setAttribute('aria-label', 'Your reference to the completion evidence');
  const error = el('small', 'field-error', '');
  const button = el('button', 'complete', 'Complete deliverable');
  button.setAttribute('type', 'button');
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await runAction(client, 'delivery-deliverable', deliverable.id, 'complete-deliverable',
          evidence.value === '' ? {} : { completionEvidenceRef: evidence.value });
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'Completion was refused.';
        button.disabled = false;
      }
    });
  });
  busy.push(button);
  controls.appendChild(evidence);
  controls.appendChild(button);
  controls.appendChild(error);
  return controls;
}

function planDeliverableControls({ data, project, el, client, withBusy, busy, refresh }) {
  const form = el('div', 'deliverable-plan');
  form.appendChild(el('h5', undefined, 'Plan a deliverable'));
  const key = el('input');
  key.setAttribute('name', 'deliverableKey');
  key.setAttribute('aria-label', 'Your identifier for this deliverable');
  const label = el('input');
  label.setAttribute('name', 'label');
  label.setAttribute('aria-label', 'Deliverable label');
  const workPackage = el('input');
  workPackage.setAttribute('name', 'workPackageId');
  workPackage.setAttribute('aria-label', 'Work package id this deliverable belongs to');
  const milestone = el('input');
  milestone.setAttribute('name', 'milestoneId');
  milestone.setAttribute('aria-label', 'Milestone id, optional');
  const error = el('small', 'field-error', '');
  const button = el('button', 'plan', 'Plan deliverable');
  button.setAttribute('type', 'button');
  button.addEventListener('click', () => {
    void withBusy(async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await runAction(client, 'delivery-work-package', workPackage.value, 'plan-deliverable', {
          deliverableKey: key.value,
          label: label.value,
          ...(milestone.value === '' ? {} : { milestoneId: milestone.value }),
        });
        key.value = '';
        label.value = '';
        await refresh();
      } catch (failure) {
        error.textContent = failure?.message ?? 'Planning was refused.';
      } finally {
        button.disabled = false;
      }
    });
  });
  busy.push(button);
  for (const node of [key, label, workPackage, milestone, button, error]) form.appendChild(node);
  if (project.id) form.setAttribute('data-project', project.id);
  if (data.requests.rows.some((row) => row.status === 'pending')) {
    form.appendChild(el('p', 'muted ca-scope-frozen',
      'A milestone with a pending acceptance request has a frozen scope: a deliverable cannot be added to it until that request is decided.'));
  }
  return form;
}

function renderAcceptance({ data, meta, body, el, client, withBusy, busy, refresh }) {
  const section = el('div', 'acceptance');
  section.appendChild(el('h4', undefined, `Acceptance (${data.requests.rows.length} request(s))`));

  // The disclaimer is not a footnote: it is the meaning of everything below it.
  const disclaimer = el('p', 'ca-acceptance-disclaimer');
  disclaimer.textContent = 'Recorded acceptance evidence only. Not authenticated customer self-service. Not a legal signature. Not authorization to bill.';
  section.appendChild(disclaimer);

  if (data.requests.rows.length === 0) {
    section.appendChild(el('p', 'empty', 'No acceptance has been requested on this project.'));
  }
  const evidenceByRequest = new Map(data.evidence.rows.map((row) => [row.deliveryAcceptanceRequestId, row]));

  for (const request of [...data.requests.rows].sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))) {
    const card = el('div', 'acceptance-request');
    card.setAttribute('data-acceptance-request', request.id);
    card.setAttribute('data-status', request.status);
    card.setAttribute('data-scope-fingerprint', request.scopeFingerprint ?? '');
    card.appendChild(el('h5', undefined, `Acceptance request · ${request.status}`));
    card.appendChild(fact(el, 'Milestone', request.deliveryMilestoneId));
    card.appendChild(fact(el, 'Customer', `${request.customerNameSnapshot ?? request.customerRef}${request.customerContactRef ? ` · ${request.customerContactRef}` : ''}`));
    card.appendChild(fact(el, 'Requested', `${request.requestedBy} · ${request.requestedAt}`));
    card.appendChild(fact(el, 'Scope fingerprint', request.scopeFingerprint));

    // The frozen scope, from the stored copy — never rebuilt from the current
    // deliverable set, which is the whole point of freezing it.
    const scope = el('div', 'acceptance-scope');
    scope.appendChild(el('strong', undefined, `Frozen scope (${request.deliverableCount ?? 0} deliverable(s)):`));
    let frozen = null;
    try {
      frozen = JSON.parse(request.frozenScope ?? 'null');
    } catch {
      scope.appendChild(el('p', 'field-error', 'The stored scope could not be read. It is not rebuilt from current data.'));
    }
    for (const item of frozen?.deliverables ?? []) {
      const row = el('p', 'acceptance-scope-item');
      row.setAttribute('data-deliverable', item.id);
      row.textContent = `${item.label} · ${item.status}${item.completionEvidenceRef ? ` · ${item.completionEvidenceRef}` : ''}`;
      scope.appendChild(row);
    }
    scope.appendChild(el('p', 'muted', 'Exactly what was submitted, as it read then. It is never rebuilt from the current deliverable set.'));
    card.appendChild(scope);

    const evidence = evidenceByRequest.get(request.id);
    if (evidence) {
      const recorded = el('div', 'acceptance-evidence');
      recorded.setAttribute('data-acceptance-evidence', evidence.id);
      recorded.setAttribute('data-outcome', evidence.outcome);
      recorded.appendChild(fact(el, 'Outcome', evidence.outcome));
      recorded.appendChild(fact(el, 'Asserted customer', evidence.assertedCustomerRef));
      recorded.appendChild(fact(el, 'Note', evidence.note));
      recorded.appendChild(fact(el, 'Recorded by', `${evidence.recordedBy} · ${evidence.recordedAt}`));
      recorded.appendChild(el('p', 'muted', 'Read-only evidence. A correction is a new record, never an edit.'));
      card.appendChild(recorded);
    } else if (request.status === 'pending') {
      card.appendChild(recordControls({ request, el, client, withBusy, busy, refresh }));
    }
    section.appendChild(card);
  }

  section.appendChild(el('p', 'muted ca-rejection-semantics',
    meta.rejectionSemantics ?? 'A rejected acceptance is recorded; completed work is never destructively reopened, and replanning requires a new change request.'));
  body.appendChild(section);
}

function recordControls({ request, el, client, withBusy, busy, refresh }) {
  const controls = el('div', 'acceptance-record');
  const customer = el('input');
  customer.setAttribute('name', 'assertedCustomerRef');
  customer.setAttribute('aria-label', 'Who the recorder says accepted or rejected');
  customer.value = request.customerRef ?? '';
  const note = el('textarea');
  note.setAttribute('name', 'note');
  note.setAttribute('aria-label', 'What the customer said');
  const error = el('small', 'field-error', '');
  const accept = el('button', 'accept', 'Record accepted');
  const reject = el('button', 'reject', 'Record rejected');
  accept.setAttribute('type', 'button');
  reject.setAttribute('type', 'button');

  const record = (outcome) => async () => {
    error.textContent = '';
    accept.disabled = true;
    reject.disabled = true;
    try {
      await runAction(client, 'delivery-acceptance-request', request.id, 'record-acceptance', {
        outcome, assertedCustomerRef: customer.value, ...(note.value === '' ? {} : { note: note.value }),
      });
      await refresh();
    } catch (failure) {
      error.textContent = failure?.message ?? 'Recording was refused.';
      accept.disabled = false;
      reject.disabled = false;
    }
  };
  accept.addEventListener('click', () => { void withBusy(record('accepted')); });
  reject.addEventListener('click', () => { void withBusy(record('rejected')); });
  busy.push(accept, reject);

  controls.appendChild(customer);
  controls.appendChild(note);
  controls.appendChild(accept);
  controls.appendChild(reject);
  controls.appendChild(error);
  controls.appendChild(el('p', 'muted',
    'You are recording what a customer told you. Nothing is sent, nobody is authenticated, and this authorizes no billing.'));
  return controls;
}
