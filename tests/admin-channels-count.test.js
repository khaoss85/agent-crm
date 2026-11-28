// @ts-check
/**
 * Backlog 58f27bf6e757 (seguito di 6d0df351): in Stato sync Stripe e SMS
 * avevano entrambi la sigla «S», e SMS aveva direzione «—» mentre il
 * dettaglio Connettori dice «in arrivo e in uscita».
 *
 * Prova: ogni canale ha una sigla unica, la direzione di SMS è quella di
 * Connettori, e la tabella sigle non ha doppioni.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_DIRECTION_LINES,
  CHANNEL_MARKS,
  channelDirectionLine,
  channelMark,
} from '../apps/admin/public/admin-channels-count.js';
import { CONNECTOR_CATALOG } from '../apps/admin/public/admin-connectors.js';

test('58f27bf6e757: ogni sigla canale e unica, SMS non doppia Stripe', () => {
  const rows = Object.entries(CHANNEL_MARKS);
  assert.ok(rows.length > 0);
  const seen = new Map();
  for (const [channel, mark] of rows) {
    assert.ok(typeof mark === 'string' && mark !== '', `sigla vuota per ${channel}`);
    assert.ok(!seen.has(mark), `sigla duplicata '${mark}': ${seen.get(mark)} e ${channel}`);
    seen.set(mark, channel);
  }
  assert.notEqual(channelMark('sms'), channelMark('stripe'), 'SMS e Stripe condividono la sigla');
  assert.equal(channelMark('sms'), 'SMS');
});

test('58f27bf6e757: la direzione di SMS e quella del dettaglio Connettori', () => {
  const sms = CONNECTOR_CATALOG.find((entry) => entry.channel === 'sms');
  assert.ok(sms, 'scheda SMS assente dal catalogo');
  const lines = sms.syncLines.join(' ');
  assert.match(lines, /arrivo/, 'la scheda SMS non parla di arrivi');
  assert.match(lines, /uscita/, 'la scheda SMS non parla di uscite');
  assert.equal(channelDirectionLine('sms'), '↔ bidirezionale');
  assert.equal(CHANNEL_DIRECTION_LINES.sms, '↔ bidirezionale');
});
