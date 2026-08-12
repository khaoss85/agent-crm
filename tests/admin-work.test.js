import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkView, sortTimelineRows } from '../apps/admin/public/admin-work.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createWorkPackage } from '../packages/work/src/index.js';

/**
 * The Work Admin section (Work v1, ADR-030).
 *
 * **Package-scoped, not package-owned**: the framework has no seam for a package
 * to ship Admin code (AX1 publishes `ADMIN_EXTENSIONS_UNSUPPORTED`), so the
 * section lives in the Admin app and renders only while `/api/schema` publishes
 * the package.
 *
 * Every test here is a claim the screen makes, a control it must not offer, or a
 * failure mode a real browser finds in a section like this: a stale response
 * drawn over a newer one, a double submit, an error with no way back, or a value
 * that stops being text.
 *
 * The HTTP path itself is covered by `tests/work-operations-e2e.test.js`.
 */

const WORK = createWorkPackage().metadata();
const SCHEMA = { domains: { work: WORK } };

const OPEN_TASK = {
  id: 'task-1', sourceKey: 'lead-qualified:lead-1', title: 'Follow up with Dana Rossi',
  status: 'open', dueAt: '2026-08-12T09:00:00.000Z',
  subjectResource: 'lead', subjectId: 'lead-1', subjectOwner: 'host', subjectOwnerPackage: null,
  subjectLabel: 'Dana Rossi', sourcePackage: 'host', sourceAction: 'qualify',
  openedByType: 'user', openedById: 'admin', openedAt: '2026-08-01T00:00:00.000Z',
  completedBy: null, completedAt: null, cancelledBy: null, cancelledAt: null, closingReason: null,
};
const DONE_TASK = {
  ...OPEN_TASK, id: 'task-2', sourceKey: 'lifecycle-commercial-followup:cf-1',
  title: 'Commercial follow-up: renewal', status: 'completed', dueAt: null,
  subjectResource: 'commercial-followup', subjectId: 'cf-1',
  subjectOwner: 'package', subjectOwnerPackage: 'lifecycle', subjectLabel: 'renewal on contract cc-1',
  sourcePackage: 'lifecycle', sourceAction: 'request-commercial-followup',
  completedBy: 'admin', completedAt: '2026-08-05T00:00:00.000Z', closingReason: 'Quote sent.',
};
const CREATED = {
  id: 'act-1', sourceKey: 'work-activity:task-created:task-1', kind: 'task_created',
  subjectResource: 'lead', subjectId: 'lead-1', taskId: 'task-1', body: null,
  occurredAt: '2026-08-01T00:00:00.000Z', actorType: 'user', actorId: 'admin',
  sourcePackage: 'host', sourceAction: 'qualify', createdAt: '2026-08-01T00:00:00.000Z',
};
const NOTE = {
  ...CREATED, id: 'act-2', sourceKey: null, kind: 'note', body: 'Left a voicemail.',
  occurredAt: '2026-08-02T00:00:00.000Z', sourceAction: 'add-note', createdAt: '2026-08-02T00:00:00.000Z',
};

/** A request client over a canned dataset, recording every call it received. */
function stubClient(data, overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
      if (overrides[path]) return overrides[path]();
      if (path === '/api/schema') return data.schema ?? SCHEMA;
      if (path.startsWith('/api/modules/work-task/records/') && !path.includes('/actions/')) {
        const id = decodeURIComponent(path.split('/').pop());
        const found = (data['work-task'] ?? []).find((row) => row.id === id);
        if (!found) throw Object.assign(new Error('Not found'), { status: 404 });
        return found;
      }
      if (path.includes('/actions/')) return { ok: true, result: {} };
      const module = path.split('/')[3];
      return { items: data[module] ?? [] };
    },
  };
}

function view(data, overrides) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(data, overrides);
  const navigated = [];
  return {
    doc, mount, client, navigated,
    work: createWorkView({ doc, mount, client, navigate: (hash) => navigated.push(hash) }),
  };
}

const text = (mount) => mount.textContent;

// ---------------------------------------------------------------------------

test('the routes are canonical, and a hostile hash is invalid rather than a lookup', () => {
  assert.deepEqual(parseModuleRoute('#/work'), { view: 'work' });
  assert.deepEqual(parseModuleRoute('#/work/'), { view: 'work' });
  assert.deepEqual(parseModuleRoute('#/work/task-1'), { view: 'work-task', taskId: 'task-1' });
  // Refresh-safe and direct-link safe: the same hash parses the same way with
  // no application state in front of it.
  assert.deepEqual(parseModuleRoute('#/work/task-1?x=1'), { view: 'work-task', taskId: 'task-1' });
  for (const hostile of ['#/work//', '#/work/a/b', '#/work/%2e%2e%2fetc', '#/work/%zz']) {
    assert.equal(parseModuleRoute(hostile).view, 'invalid', hostile);
  }
});

test('the section renders nothing when the server does not publish the package', async () => {
  const v = view({ schema: { domains: {} }, 'work-task': [] });
  await v.work.renderQueue();
  assert.match(text(v.mount), /does not have the work package/);
  assert.doesNotMatch(text(v.mount), /Complete/);
});

test('the queue separates open from closed, discloses its bound, and states every limit', async () => {
  const v = view({ 'work-task': [OPEN_TASK, DONE_TASK] });
  await v.work.renderQueue();
  const rendered = text(v.mount);
  assert.match(rendered, /Open \(1\)/);
  assert.match(rendered, /Completed and cancelled \(1\)/);
  assert.match(rendered, /Follow up with Dana Rossi/);
  // The four claims the screen exists to keep straight.
  assert.match(rendered, /Nothing here is scheduled, reminded, assigned or sent/);
  assert.match(rendered, /human-actor boundary/);
  assert.match(rendered, /not RBAC/);
  assert.match(rendered, /scheduler/);
  assert.match(rendered, /reminders/);
  assert.match(rendered, /assignment/);
});

test('an empty queue is an empty state, not a broken table', async () => {
  const v = view({ 'work-task': [] });
  await v.work.renderQueue();
  assert.match(text(v.mount), /No open work\./);
  assert.match(text(v.mount), /Nothing closed yet\./);
});

test('a failed load offers a retry that actually retries', async () => {
  let failing = true;
  const v = view({ 'work-task': [OPEN_TASK] }, {
    '/api/modules/work-task/records?limit=100': () => {
      if (failing) throw Object.assign(new Error('network is down'), { status: 500 });
      return { items: [OPEN_TASK] };
    },
  });
  await v.work.renderQueue();
  assert.match(text(v.mount), /Could not load work: network is down/);
  const retry = v.mount.findAll('button').find((node) => node.textContent === 'Retry');
  assert.ok(retry, 'a failure without a way back is a dead end');
  failing = false;
  await retry.listeners.click[0]();
  assert.match(text(v.mount), /Follow up with Dana Rossi/);
});

test('the detail shows immutable source and subject evidence, with the snapshot labelled as one', async () => {
  const v = view({ 'work-task': [OPEN_TASK], 'work-activity': [CREATED, NOTE] });
  await v.work.renderTask('task-1');
  const rendered = text(v.mount);
  assert.match(rendered, /lead-qualified:lead-1/);
  assert.match(rendered, /this project \(host record\)/);
  assert.match(rendered, /host · qualify/);
  assert.match(rendered, /snapshot taken when this task was opened/);
  assert.match(rendered, /nothing in the database guarantees the subject still exists/);
  assert.match(rendered, /A due date is evidence of intent/);
  assert.match(rendered, /assigned to nobody/);
});

test('a package-owned subject is labelled as the package that owns it', async () => {
  const v = view({ 'work-task': [DONE_TASK], 'work-activity': [] });
  await v.work.renderTask('task-2');
  assert.match(text(v.mount), /package · lifecycle/);
});

test('controls are state-aware: an open task can move, a terminal one offers nothing', async () => {
  const open = view({ 'work-task': [OPEN_TASK], 'work-activity': [CREATED] });
  await open.work.renderTask('task-1');
  const openActions = open.mount.findAll('button').map((node) => node.getAttribute('data-action'));
  assert.ok(openActions.includes('complete'));
  assert.ok(openActions.includes('cancel'));

  const done = view({ 'work-task': [DONE_TASK], 'work-activity': [] });
  await done.work.renderTask('task-2');
  const doneActions = done.mount.findAll('button').map((node) => node.getAttribute('data-action'));
  assert.equal(doneActions.includes('complete'), false, 'the server would refuse it, so it is not offered');
  assert.equal(doneActions.includes('cancel'), false);
  assert.match(text(done.mount), /final/);
  assert.match(text(done.mount), /no reopen/);
  // A note is still legitimate on a closed task, and is still offered.
  assert.ok(doneActions.includes('add-note'));
});

test('a control disables while its request is in flight: no double submit', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const v = view({ 'work-task': [OPEN_TASK], 'work-activity': [CREATED] }, {
    '/api/modules/work-task/records/task-1/actions/complete': async () => { await gate; return { ok: true }; },
  });
  await v.work.renderTask('task-1');
  const complete = v.mount.findAll('button').find((n) => n.getAttribute('data-action') === 'complete');
  const pending = complete.listeners.click[0]();
  assert.equal(complete.disabled, true, 'the control is disabled while the request is in flight');
  release();
  await pending;
});

test('a refused move renders the server message and leaves the screen usable', async () => {
  const v = view({ 'work-task': [OPEN_TASK], 'work-activity': [CREATED] }, {
    '/api/modules/work-task/records/task-1/actions/cancel': () => {
      throw Object.assign(new Error('reason is required'), { status: 400 });
    },
  });
  await v.work.renderTask('task-1');
  const cancel = v.mount.findAll('button').find((n) => n.getAttribute('data-action') === 'cancel');
  await cancel.listeners.click[0]();
  assert.match(text(v.mount), /reason is required/);
  assert.equal(cancel.disabled, false, 'the control comes back');
});

test('the timeline renders oldest first, as text, and says what it is not', async () => {
  const hostile = { ...NOTE, id: 'act-3', body: '<script>alert(1)</script>', occurredAt: '2026-08-03T00:00:00.000Z', createdAt: '2026-08-03T00:00:00.000Z' };
  const v = view({ 'work-task': [OPEN_TASK], 'work-activity': [hostile, NOTE, CREATED] });
  await v.work.renderTask('task-1');
  const items = v.mount.findAll('li');
  assert.deepEqual(items.map((node) => node.getAttribute('data-kind')), ['task_created', 'note', 'note']);
  // The hostile value is TEXT. It is present as characters and never as markup.
  const node = items[2];
  assert.match(node.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(node.childNodes.some((child) => child.tagName === 'SCRIPT'), false);
  assert.match(text(v.mount), /not the audit log/);
  assert.match(text(v.mount), /nothing on it was sent anywhere/);
});

test('the note form says a note reaches nobody, and that two notes are two notes', async () => {
  const v = view({ 'work-task': [OPEN_TASK], 'work-activity': [CREATED] });
  await v.work.renderTask('task-1');
  const rendered = text(v.mount);
  assert.match(rendered, /emails nobody, notifies nobody and reaches no customer/);
  assert.match(rendered, /two identical notes are two notes|Two identical notes are two notes/);
});

test('a stale response is discarded rather than drawn over a newer one', async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let first = true;
  const v = view({ 'work-task': [OPEN_TASK, DONE_TASK], 'work-activity': [CREATED] }, {
    '/api/schema': async () => {
      if (first) { first = false; await slow; }
      return SCHEMA;
    },
  });
  const stale = v.work.renderTask('task-1');
  const fresh = v.work.renderTask('task-2');
  await fresh;
  releaseSlow();
  await stale;
  // The newer render wins: the older one must not repaint over it.
  assert.match(text(v.mount), /Commercial follow-up: renewal/);
  assert.doesNotMatch(text(v.mount), /Follow up with Dana Rossi/);
});

test('the timeline sort is deterministic when two entries share an instant', () => {
  const a = { id: 'b', occurredAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' };
  const b = { id: 'a', occurredAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' };
  // Not chronology — there is none — but two readers of the same data must see
  // the same list, which is what the package publishes.
  assert.deepEqual(sortTimelineRows([a, b]).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(sortTimelineRows([b, a]).map((row) => row.id), ['a', 'b']);
});
