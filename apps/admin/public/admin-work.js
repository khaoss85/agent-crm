// @ts-check

import { bindAdminMutations } from './admin-submission.js';

/**
 * The Work Admin section (Work v1, ADR-030 — the `work` package).
 *
 * **Package-scoped, not package-owned.** The framework has no seam for a package
 * to contribute an Admin extension — AX1 publishes that as
 * `ADMIN_EXTENSIONS_UNSUPPORTED` — so this code lives in the Admin app and
 * renders only while `/api/schema` publishes `domains.work`. Remove the package
 * and the section disappears rather than degrading into a broken control.
 *
 * Its job is to keep four claims impossible to misread, because each is a claim
 * a user would otherwise make on the framework's behalf:
 *
 *   a task is *open* — **nothing will remind anybody**, and nothing fires when
 *     its due date passes;
 *   a task exists — **it is assigned to nobody**; there is no assignee, no
 *     ownership and no RBAC, so "who does this" is not a question this screen
 *     can answer;
 *   an activity was recorded — **it was not sent**: no email, no chat, no
 *     notification, no calendar entry;
 *   a subject is named — **the label is a snapshot** taken when the task was
 *     opened, and the database cannot enforce that the subject still exists.
 *
 * Admin rules as everywhere: every value renders as text (never HTML), the
 * server owns every state, a control appears only where the server would accept
 * it, controls disable while a request is in flight, and a stale response is
 * discarded rather than drawn over a newer one.
 *
 * It is **state-aware** — Complete and Cancel render only for an `open` task —
 * which is the package-scoped exception the "Generic Admin action availability"
 * roadmap item already allows. No generic Admin refactor is attempted here.
 */

/** A display bound, never a correctness bound, and it is disclosed on screen. */
const LIST_LIMIT = 100;

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createWorkView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  /** Guard against a stale async response overwriting a newer view. */
  let renderToken = 0;
  /** Every control currently disabled for an in-flight request. */
  const busy = [];

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text); // safe: text, never HTML
    return node;
  };
  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };

  /** A labelled fact row. The value is text, always. */
  const fact = (label, value) => {
    const row = el('p', 'work-fact');
    row.appendChild(el('strong', undefined, `${label}: `));
    row.appendChild(el('span', undefined, value === null || value === undefined || value === '' ? '—' : String(value)));
    return row;
  };

  /** Disable every control while a request is in flight: no double submit. */
  async function withBusy(controls, fn) {
    for (const control of controls) { control.disabled = true; busy.push(control); }
    try {
      return await fn();
    } finally {
      for (const control of controls) { control.disabled = false; }
      busy.length = 0;
    }
  }

  /**
   * Read a page of a collection, narrowed **on the server** where a narrowing is
   * asked for (ADR-008 addendum 2).
   *
   * The `where` argument is not a convenience. Filtering in the browser meant
   * asking for the newest `LIST_LIMIT` rows of the *whole* table and keeping the
   * ones that matched: once a project had more activity rows than that anywhere,
   * an older subject's timeline rendered as "Nothing recorded yet." with a page
   * bound printed beneath it claiming the bound belonged to the screen. Both
   * statements were false at once. `predicate` is kept as well, so a server that
   * ignored the filter could still never draw another subject's rows here.
   */
  async function fetchRows(module, predicate, where) {
    const query = new URLSearchParams({ limit: String(LIST_LIMIT) });
    for (const [field, value] of Object.entries(where ?? {})) {
      if (value !== undefined && value !== null) query.set(`filter.${field}`, String(value));
    }
    const result = await client.request(`/api/modules/${module}/records?${query.toString()}`);
    const items = result.items ?? [];
    const rows = items.filter(predicate ?? (() => true));
    return { rows, truncated: items.length >= LIST_LIMIT };
  }

  async function workMeta() {
    const schema = await client.request('/api/schema');
    return schema?.domains?.work ?? null;
  }

  /** The section's standing limitations, rendered from the package's own words. */
  function renderLimits(panel, meta) {
    const limits = el('div', 'work-limits');
    limits.appendChild(el('p', 'muted', meta.limitation ?? ''));
    limits.appendChild(el('p', 'muted work-not-modeled',
      `Not modeled anywhere in this section: ${(meta.notModeled ?? []).join(', ')}.`));
    limits.appendChild(el('p', 'muted work-actor-note',
      'Completing, cancelling and noting require a user actor. That is a human-actor boundary, '
      + 'not authentication, not RBAC and not secure assignment: this application has none of those.'));
    panel.appendChild(limits);
  }

  function renderMissing(message) {
    clear();
    const panel = el('section', 'panel');
    panel.appendChild(el('p', 'empty', message));
    mount.appendChild(panel);
  }

  function renderError(message, retry) {
    clear();
    const panel = el('section', 'panel work-error');
    panel.appendChild(el('p', 'field-error', message));
    const button = el('button', 'retry', 'Retry');
    // The handler returns the promise so a caller that can await it (a test)
    // does not have to guess when the retry finished. A browser ignores it.
    button.addEventListener('click', () => retry());
    panel.appendChild(button);
    mount.appendChild(panel);
  }

  // ---- Queue -------------------------------------------------------------

  async function renderQueue() {
    const token = ++renderToken;
    clear();
    mount.appendChild(el('p', 'loading', 'Loading work…'));
    let meta;
    let tasks;
    try {
      meta = await workMeta();
      if (token !== renderToken) return;
      if (!meta) { renderMissing('This application does not have the work package.'); return; }
      tasks = await fetchRows('work-task');
    } catch (error) {
      if (token !== renderToken) return;
      renderError(`Could not load work: ${error?.message ?? 'request failed'}`, renderQueue);
      return;
    }
    if (token !== renderToken) return;
    clear();

    const panel = el('section', 'panel panel-wide work-queue');
    const heading = el('div', 'panel-heading');
    const titleBox = el('div');
    titleBox.appendChild(el('p', 'kicker', 'Work package'));
    titleBox.appendChild(el('h2', undefined, 'Tasks'));
    titleBox.appendChild(el('p', 'lede',
      'Follow-up work a person must do, and the record of what happened to it. '
      + 'Nothing here is scheduled, reminded, assigned or sent.'));
    heading.appendChild(titleBox);
    panel.appendChild(heading);

    const open = tasks.rows.filter((row) => row.status === 'open');
    const closed = tasks.rows.filter((row) => row.status !== 'open');

    panel.appendChild(el('h3', undefined, `Open (${open.length})`));
    panel.appendChild(taskTable(open, 'No open work.'));
    panel.appendChild(el('h3', undefined, `Completed and cancelled (${closed.length})`));
    panel.appendChild(taskTable(closed, 'Nothing closed yet.'));

    if (tasks.truncated) {
      panel.appendChild(el('p', 'muted work-bound',
        `Showing at most ${LIST_LIMIT} tasks. That is a display bound of this screen, never a bound on what exists.`));
    }
    renderLimits(panel, meta);
    mount.appendChild(panel);
  }

  function taskTable(rows, emptyText) {
    if (rows.length === 0) return el('div', 'empty', emptyText);
    const wrap = el('div', 'table-wrap');
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['Task', 'Status', 'Subject', 'Opened by', 'Due (evidence only)', '']) {
      head.appendChild(el('th', undefined, label));
    }
    thead.appendChild(head);
    table.appendChild(thead);
    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      tr.setAttribute('data-task', row.id);
      tr.appendChild(el('td', undefined, row.title ?? '—'));
      const status = el('td');
      status.appendChild(el('span', `badge ${row.status}`, row.status ?? '—'));
      tr.appendChild(status);
      tr.appendChild(el('td', undefined, `${row.subjectResource ?? '—'} · ${row.subjectLabel ?? row.subjectId ?? '—'}`));
      tr.appendChild(el('td', undefined, row.openedById ?? '—'));
      tr.appendChild(el('td', undefined, row.dueAt ?? '—'));
      const openCell = el('td');
      const link = el('a', 'small secondary', 'Open');
      link.setAttribute('href', `#/work/${encodeURIComponent(row.id)}`);
      link.addEventListener('click', () => navigate(`#/work/${encodeURIComponent(row.id)}`));
      openCell.appendChild(link);
      tr.appendChild(openCell);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  // ---- Detail ------------------------------------------------------------

  async function renderTask(taskId) {
    const token = ++renderToken;
    clear();
    mount.appendChild(el('p', 'loading', 'Loading task…'));
    let meta;
    let task;
    let timeline;
    try {
      meta = await workMeta();
      if (token !== renderToken) return;
      if (!meta) { renderMissing('This application does not have the work package.'); return; }
      task = await client.request(`/api/modules/work-task/records/${encodeURIComponent(taskId)}`);
      const activities = await fetchRows(
        'work-activity',
        (row) => row.subjectResource === task.subjectResource && row.subjectId === task.subjectId,
        { subjectResource: task.subjectResource, subjectId: task.subjectId },
      );
      timeline = activities;
    } catch (error) {
      if (token !== renderToken) return;
      renderError(`Could not load this task: ${error?.message ?? 'request failed'}`, () => renderTask(taskId));
      return;
    }
    if (token !== renderToken) return;
    clear();

    const panel = el('section', 'panel panel-wide work-detail');
    panel.setAttribute('data-task', task.id);
    const heading = el('div', 'panel-heading');
    const titleBox = el('div');
    titleBox.appendChild(el('p', 'kicker', 'Work task'));
    titleBox.appendChild(el('h2', undefined, task.title ?? '—'));
    heading.appendChild(titleBox);
    panel.appendChild(heading);

    const back = el('a', 'small secondary work-back', 'Back to the queue');
    back.setAttribute('href', '#/work');
    back.addEventListener('click', () => navigate('#/work'));
    panel.appendChild(back);

    // ---- immutable source and subject evidence ----
    const evidence = el('div', 'work-evidence');
    evidence.appendChild(el('h3', undefined, 'Source and subject'));
    evidence.appendChild(fact('Status', task.status));
    evidence.appendChild(fact('Subject resource', task.subjectResource));
    evidence.appendChild(fact('Subject id', task.subjectId));
    evidence.appendChild(fact('Subject owner', task.subjectOwner === 'package'
      ? `package · ${task.subjectOwnerPackage}`
      : 'this project (host record)'));
    evidence.appendChild(fact('Subject label (snapshot)', task.subjectLabel));
    evidence.appendChild(fact('Created by', `${task.sourcePackage ?? '—'} · ${task.sourceAction ?? '—'}`));
    evidence.appendChild(fact('Source key', task.sourceKey));
    evidence.appendChild(fact('Opened', `${task.openedById ?? '—'} (${task.openedByType ?? '—'}) at ${task.openedAt ?? '—'}`));
    evidence.appendChild(fact('Due', task.dueAt));
    if (task.status === 'completed') {
      evidence.appendChild(fact('Completed', `${task.completedBy ?? '—'} at ${task.completedAt ?? '—'}`));
    }
    if (task.status === 'cancelled') {
      evidence.appendChild(fact('Cancelled', `${task.cancelledBy ?? '—'} at ${task.cancelledAt ?? '—'}`));
    }
    if (task.closingReason) evidence.appendChild(fact('Closing note', task.closingReason));
    evidence.appendChild(el('p', 'muted work-subject-note',
      'The subject label is a snapshot taken when this task was opened. It is never refreshed, and nothing '
      + 'in the database guarantees the subject still exists — the action that created this task is what proved it did.'));
    evidence.appendChild(el('p', 'muted work-due-note',
      'A due date is evidence of intent. Nothing is scheduled from it, no reminder exists, and a task past '
      + 'its due date stays exactly open until a person moves it.'));
    evidence.appendChild(el('p', 'muted work-assignment-note',
      'This task is assigned to nobody. There is no assignee, no owner and no routing in this package.'));
    panel.appendChild(evidence);

    // ---- state-aware controls ----
    const controls = el('div', 'work-controls');
    const controlError = el('small', 'field-error', '');
    if (task.status === 'open') {
      controls.appendChild(el('h3', undefined, 'Move this task'));
      const completeNote = el('input');
      completeNote.setAttribute('name', 'completeNote');
      completeNote.setAttribute('placeholder', 'What was done (optional)');
      completeNote.setAttribute('aria-label', 'Note recorded when completing this task (optional)');
      const complete = el('button', 'primary', 'Complete');
      complete.setAttribute('data-action', 'complete');
      const cancelReason = el('input');
      cancelReason.setAttribute('name', 'cancelReason');
      cancelReason.setAttribute('placeholder', 'Why this will not be done (required)');
      cancelReason.setAttribute('aria-label', 'Reason this task will not be done (required)');
      const cancel = el('button', 'secondary', 'Cancel task');
      cancel.setAttribute('data-action', 'cancel');
      const all = [complete, cancel, completeNote, cancelReason];

      complete.addEventListener('click', () => withBusy(all, async () => {
        controlError.textContent = '';
        try {
          await runAction(task.id, 'complete', completeNote.value ? { note: completeNote.value } : {});
          await renderTask(task.id);
        } catch (error) {
          controlError.textContent = error?.message ?? 'The server refused this move.';
        }
      }));
      cancel.addEventListener('click', () => withBusy(all, async () => {
        controlError.textContent = '';
        try {
          await runAction(task.id, 'cancel', { reason: cancelReason.value });
          await renderTask(task.id);
        } catch (error) {
          controlError.textContent = error?.message ?? 'The server refused this move.';
        }
      }));
      controls.appendChild(completeNote);
      controls.appendChild(complete);
      controls.appendChild(cancelReason);
      controls.appendChild(cancel);
      controls.appendChild(el('p', 'muted work-terminal-note',
        'Completed and cancelled are both final. There is no reopen: a new round of the same work is a new task.'));
    } else {
      controls.appendChild(el('p', 'muted work-closed-note',
        `This task is ${task.status}, which is final. There is no reopen in this version, so no control is offered — `
        + 'the server would refuse one.'));
    }
    controls.appendChild(controlError);
    panel.appendChild(controls);

    // ---- the subject's timeline ----
    const timelineBox = el('div', 'work-timeline');
    timelineBox.appendChild(el('h3', undefined, 'Activity on this subject'));
    timelineBox.appendChild(el('p', 'muted',
      'A curated, append-only timeline with a closed vocabulary. It is not the audit log, it does not mirror it, '
      + 'and nothing on it was sent anywhere.'));
    const ordered = sortTimelineRows(timeline.rows);
    if (ordered.length === 0) {
      timelineBox.appendChild(el('div', 'empty', 'Nothing recorded yet on this subject.'));
    } else {
      const list = el('ul', 'work-activity-list');
      for (const row of ordered) {
        const item = el('li', `work-activity ${row.kind}`);
        item.setAttribute('data-kind', String(row.kind));
        item.appendChild(el('strong', undefined, String(row.kind ?? '—')));
        item.appendChild(el('span', 'work-activity-when', ` ${row.occurredAt ?? '—'} `));
        item.appendChild(el('span', 'work-activity-actor', `${row.actorId ?? '—'} (${row.actorType ?? '—'})`));
        if (row.body) item.appendChild(el('p', 'work-activity-body', String(row.body)));
        list.appendChild(item);
      }
      timelineBox.appendChild(list);
    }
    if (timeline.truncated) {
      // Say which end is missing. The server answers newest-first and this list
      // is drawn oldest-first, so a truncated timeline starts in the middle
      // while looking exactly like one that starts at the beginning.
      timelineBox.appendChild(el('p', 'muted work-bound',
        `This subject has more than ${LIST_LIMIT} entries. These are its ${LIST_LIMIT} most recent ones, `
        + 'drawn oldest-first — so the timeline above starts in the middle, and earlier entries exist and are '
        + 'not shown. A display bound of this screen, never a bound on what exists.'));
    }

    // ---- manual note ----
    const noteBox = el('div', 'work-note-form');
    noteBox.appendChild(el('h3', undefined, 'Add a note'));
    const noteInput = el('input');
    noteInput.setAttribute('name', 'noteBody');
    // A placeholder is not an accessible name: it disappears the moment the
    // user types, and the field goes unnamed for a screen reader mid-entry.
    noteInput.setAttribute('aria-label', 'Note to add to this subject timeline');
    noteInput.setAttribute('placeholder', 'Plain text, at most 1000 characters');
    const noteButton = el('button', 'primary', 'Add note');
    noteButton.setAttribute('data-action', 'add-note');
    const noteError = el('small', 'field-error', '');
    noteButton.addEventListener('click', () => withBusy([noteButton, noteInput], async () => {
      noteError.textContent = '';
      try {
        await runAction(task.id, 'add-note', { body: noteInput.value });
        await renderTask(task.id);
      } catch (error) {
        noteError.textContent = error?.message ?? 'The server refused this note.';
      }
    }));
    noteBox.appendChild(noteInput);
    noteBox.appendChild(noteButton);
    noteBox.appendChild(noteError);
    noteBox.appendChild(el('p', 'muted work-note-note',
      'A note is recorded here and nowhere else. It emails nobody, notifies nobody and reaches no customer. '
      + 'Two identical notes are two notes: a note carries no idempotency key, because two statements are two statements.'));
    timelineBox.appendChild(noteBox);
    panel.appendChild(timelineBox);

    renderLimits(panel, meta);
    mount.appendChild(panel);
  }

  function runAction(id, action, input) {
    return client.request(
      `/api/modules/work-task/records/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  return { renderQueue, renderTask, busy };
}

/**
 * Oldest first, deterministically — the same rule the package publishes.
 * Ties are broken by created stamp then id so two readers see the same list;
 * that is determinism, not chronology.
 * @param {any[]} rows
 */
export function sortTimelineRows(rows) {
  return [...rows].sort((a, b) => {
    const byOccurred = String(a.occurredAt ?? '').localeCompare(String(b.occurredAt ?? ''));
    if (byOccurred !== 0) return byOccurred;
    const byCreated = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
    if (byCreated !== 0) return byCreated;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}
