import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { shellScreenFor } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:bfc070243427 — offer/quote page follow-up: no empty fields, the
 * sidebar stays highlighted on the preventivo, the two top links never
 * touch. Only the points that do not collide with other items' locked
 * contracts are covered here (the duplicate «Apri il preventivo», the raw
 * policy tag in the history and the «progetto» wording stay as the existing
 * tests lock them — see the item's report).
 */

const SCHEMA = {
  pipelines: [{
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'discovery',
    stages: [
      { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
    ],
  }],
};

function stubClient(record) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return SCHEMA;
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...record };
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
}

const flushAll = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('bfc070243427: an offer without a close date paints no «Chiusura prevista» row', async () => {
  const record = {
    id: 'off1',
    name: 'Cucina per Giulia',
    contactName: 'Giulia Verdi',
    companyName: null,
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    valueCents: 2750000,
    currency: 'EUR',
    expectedCloseDate: null,
    createdAt: '2026-10-02T09:15:00.000Z',
    updatedAt: '2026-10-28T18:40:00.000Z',
    owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: stubClient(record) }).renderOfferDetail('off1');
  await flushAll();
  const text = mount.textContent;
  assert.ok(!text.includes('Chiusura prevista'), 'no empty close-date field is shown');
  assert.ok(!text.includes('chiusura prevista —'), 'no empty hero note either');
  assert.ok(text.includes('27.500 €'), 'the value still paints');
});

test('bfc070243427: the sidebar highlights Pipeline on the preventivo, like on the offer', () => {
  assert.deepEqual(shellScreenFor({ view: 'quote-detail' }), { id: 'pipeline', label: 'Preventivo' });
  assert.deepEqual(shellScreenFor({ view: 'offer-detail' }), { id: 'pipeline', label: 'Offerta' });
});

test('bfc070243427: the two top quote links are separated by the stylesheet', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.quote-back + .quote-offer-link'), 'an adjacent-sibling gap keeps «← cliente» and «Apri l’offerta» apart');
});
