// @ts-check

/**
 * `recordTimelineNote` on the declared `follow-up@1` edge (backlog:d547f65e).
 *
 * The undo of a wrong merge writes its cronologia row through this edge, so
 * these tests pin the two properties the review demanded: work resolves its
 * own activity record through its own module names (rename-safe), and a
 * missing record fails closed instead of writing nowhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFollowUpCapability } from '../packages/work/src/index.js';

const ACTOR = { type: 'user', id: 'a3' };

const stubService = () => ({ createManaged: async () => ({}), listWhere: async () => [] });

test('the follow-up edge appends timeline notes beside follow-up creation', () => {
  const opened = createFollowUpCapability().create({ modules: { get: () => null }, consumer: 'customer-data' });
  assert.equal(typeof opened.createFollowUp, 'function', 'creation stays');
  assert.equal(typeof opened.recordTimelineNote, 'function', 'the undo writes through this handle');
});

test('the note resolves the activity record through work names, even renamed', async () => {
  const modules = {
    get: (name) => {
      if (name === 'attivita') return { service: stubService() };
      if (name === 'compiti') return { service: stubService() };
      return null;
    },
  };
  const renamed = createFollowUpCapability({ 'work-activity': 'attivita', 'work-task': 'compiti' })
    .create({ modules, actor: ACTOR, consumer: 'customer-data' });
  // Past storage resolution (no WORK_STORAGE_INVALID): the only refusal left
  // is the missing caller transaction, which the real action always has.
  await assert.rejects(
    () => renamed.recordTimelineNote({
      subject: { resource: 'contact', id: 'c1' },
      body: 'Unione annullata: motivo di prova',
      occurredAt: '2026-11-20T20:00:00.000Z',
      source: { package: 'customer-data', action: 'unlink-canonical-identity' },
    }),
    (error) => error.code === 'WORK_TRANSACTION_REQUIRED',
    'the renamed record resolves; the transaction guard fires, not a storage miss',
  );
  const plain = createFollowUpCapability()
    .create({ modules, actor: ACTOR, consumer: 'customer-data' });
  await assert.rejects(
    () => plain.recordTimelineNote({
      subject: { resource: 'contact', id: 'c1' },
      body: 'Unione annullata: motivo di prova',
      occurredAt: '2026-11-20T20:00:00.000Z',
      source: { package: 'customer-data', action: 'unlink-canonical-identity' },
    }),
    (error) => error.code === 'WORK_STORAGE_INVALID',
    'the default name finds nothing under a rename: fails closed, never nowhere',
  );
});

test('the note without the activity record fails closed', async () => {
  const opened = createFollowUpCapability().create({ modules: { get: () => null }, actor: ACTOR, consumer: 'customer-data' });
  await assert.rejects(
    () => opened.recordTimelineNote({
      subject: { resource: 'contact', id: 'c1' },
      body: 'Unione annullata: motivo di prova',
      occurredAt: '2026-11-20T20:00:00.000Z',
      source: { package: 'customer-data', action: 'unlink-canonical-identity' },
    }),
    (error) => error.code === 'WORK_STORAGE_INVALID',
  );
});
