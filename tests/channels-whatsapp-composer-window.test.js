import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_WINDOW_SKEW_MS,
  WHATSAPP_COMPOSER_FREE,
  WHATSAPP_COMPOSER_TEMPLATE_ONLY,
  describeWhatsAppComposer,
  proposableWhatsAppTemplates,
  refuseWhatsAppFreeText,
} from '../packages/channels/src/composer-window.js';

/**
 * Scheda composer WhatsApp window (backlog:97cba17c, VALIDAZIONE A4): the
 * composer calls the same Meta window rule the adapter and the queue call,
 * and outside it proposes only approved templates with an Italian line —
 * never a free-text send Meta would refuse in silence.
 */

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;

test('97cba17c: the composer skew matches the ingest skew', () => {
  assert.equal(COMPOSER_WINDOW_SKEW_MS, 5 * 60 * 1000);
});

test('97cba17c: inside the window free text may go, no notice', () => {
  const state = describeWhatsAppComposer({ lastInboundAt: iso(NOW - 23 * HOUR), nowMs: NOW });
  assert.equal(state.mode, WHATSAPP_COMPOSER_FREE);
  assert.equal(state.inWindow, true);
  assert.equal(state.noticeIt, null);
  assert.deepEqual(state.templates, []);
});

test('97cba17c: at 24 hours minus a breath free text may still go', () => {
  const state = describeWhatsAppComposer({ lastInboundAt: iso(NOW - 24 * HOUR + 1000), nowMs: NOW });
  assert.equal(state.inWindow, true);
});

test('97cba17c: past 24 hours only templates go, in Italian', () => {
  const state = describeWhatsAppComposer({ lastInboundAt: iso(NOW - 25 * HOUR), nowMs: NOW });
  assert.equal(state.mode, WHATSAPP_COMPOSER_TEMPLATE_ONLY);
  assert.equal(state.inWindow, false);
  assert.match(state.noticeIt ?? '', /modello approvato/);
  assert.match(state.noticeIt ?? '', /24 ore/);
});

test('97cba17c: no inbound seen is template-only, never a silent send', () => {
  for (const lastInboundAt of [null, undefined]) {
    const state = describeWhatsAppComposer({ lastInboundAt, nowMs: NOW });
    assert.equal(state.inWindow, false, String(lastInboundAt));
    assert.equal(typeof state.noticeIt, 'string', String(lastInboundAt));
  }
});

test('97cba17c: future and malformed observations fail closed in Italian', () => {
  for (const lastInboundAt of [iso(NOW + HOUR), 'not-a-date', 42]) {
    const state = describeWhatsAppComposer({ lastInboundAt, nowMs: NOW });
    assert.equal(state.inWindow, false, String(lastInboundAt));
    assert.equal(typeof state.noticeIt, 'string', String(lastInboundAt));
  }
});

test('97cba17c: the refusal is null inside, Italian outside', () => {
  assert.equal(refuseWhatsAppFreeText({ lastInboundAt: iso(NOW - HOUR), nowMs: NOW }), null);
  assert.match(refuseWhatsAppFreeText({ lastInboundAt: iso(NOW - 25 * HOUR), nowMs: NOW }) ?? '', /modello approvato/);
  assert.equal(typeof refuseWhatsAppFreeText({ nowMs: NOW }), 'string');
});

test('97cba17c: only bounded templates are proposed, frozen', () => {
  const templates = proposableWhatsAppTemplates([
    { name: 'promemoria_visita', language: 'it' },
    { name: 'Bad Name', language: 'it' },
    { name: 'ok_name', language: 'italiano' },
    null,
    'promemoria_visita',
  ]);
  assert.deepEqual(templates, [Object.freeze({ name: 'promemoria_visita', language: 'it' })]);
  assert.ok(Object.isFrozen(templates));
});

test('97cba17c: a non-list of templates proposes nothing', () => {
  assert.deepEqual(proposableWhatsAppTemplates(null), []);
  assert.deepEqual(proposableWhatsAppTemplates('promemoria_visita'), []);
});
