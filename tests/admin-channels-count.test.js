// @ts-check
/**
 * Backoffice — Conteggi canali (backlog:58f27bf6e757): la sigla è unica per
 * canale e la direzione dell'SMS è quella dei Connettori.
 *
 * What it must prove: nessun canale noto condivide la sigla con un altro
 * (tabella anti-duplicati, compresi gli alias storici email/gmail,
 * phone/voice, web/form/site-form, calendar/google_calendar); ogni canale
 * del catalogo Connettori ha sigla e direzione; la direzione dell'SMS è
 * '↔ bidirezionale' come dichiara la scheda catalogo ('Nuovi SMS in arrivo
 * e in uscita'); gli id sconosciuti non inventano righe fisse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_ALIASES,
  CHANNEL_DIRECTION,
  CHANNEL_SIGLA,
  canonicalChannel,
  channelDirection,
  channelSigla,
  connectorChannelCards,
} from '../apps/admin/public/admin-channels-count.js';
import { CONNECTOR_CATALOG } from '../apps/admin/public/admin-connectors.js';

test('sigle uniche per canale: la tabella non ha duplicati', () => {
  const rows = Object.entries(CHANNEL_SIGLA);
  assert.ok(rows.length > 0);
  const seen = new Map();
  for (const [channel, sigla] of rows) {
    assert.match(sigla, /^\S{1,3}$/, `sigla breve senza spazi per ${channel}`);
    assert.ok(!seen.has(sigla), `sigla duplicata '${sigla}': ${seen.get(sigla)} e ${channel}`);
    seen.set(sigla, channel);
  }
});

test('alias storici: sigla diversa dal canonico (tabella anti-duplicati)', () => {
  const pairs = [
    ['email', 'gmail'],
    ['phone', 'voice'],
    ['web', 'form'],
    ['web', 'site-form'],
    ['form', 'site-form'],
    ['calendar', 'google_calendar'],
  ];
  for (const [first, second] of pairs) {
    assert.notEqual(
      channelSigla(first),
      channelSigla(second),
      `${first} e ${second} condividono la sigla`,
    );
  }
  for (const [alias, canonical] of Object.entries(CHANNEL_ALIASES)) {
    assert.equal(canonicalChannel(alias), canonical, `l'alias ${alias} non si risolve`);
    assert.equal(channelDirection(alias), channelDirection(canonical), `direzione di ${alias} diversa da ${canonical}`);
  }
});

test('ogni canale del catalogo Connettori ha sigla e direzione', () => {
  assert.ok(CONNECTOR_CATALOG.length > 0);
  for (const entry of CONNECTOR_CATALOG) {
    assert.ok(typeof entry.channel === 'string' && entry.channel !== '', 'canale catalogo senza id');
    assert.ok(typeof channelSigla(entry.channel) === 'string' && channelSigla(entry.channel) !== '', `sigla mancante per ${entry.channel}`);
    assert.ok(channelDirection(entry.channel) !== null, `direzione mancante per ${entry.channel}`);
  }
  const cards = connectorChannelCards();
  assert.equal(cards.length, CONNECTOR_CATALOG.length);
  for (const card of cards) {
    const sigle = new Set(cards.map((row) => row.sigla));
    assert.ok(sigle.has(card.sigla));
  }
  assert.equal(new Set(cards.map((row) => row.sigla)).size, cards.length, 'sigle duplicate fra le card catalogo');
});

test('direzione SMS come i Connettori: bidirezionale', () => {
  const sms = CONNECTOR_CATALOG.find((entry) => entry.channel === 'sms');
  assert.ok(sms, 'scheda SMS assente dal catalogo');
  const lines = sms.syncLines.join(' ');
  assert.match(lines, /arrivo/, 'la scheda SMS non parla di arrivi');
  assert.match(lines, /uscita/, 'la scheda SMS non parla di uscite');
  assert.equal(channelDirection('sms'), '↔ bidirezionale');
});

test('direzioni fisse: solo entrata dove non si invia, pagamenti per Stripe', () => {
  assert.equal(channelDirection('tiktok'), '← in entrata');
  assert.equal(channelDirection('site-form'), '← in entrata');
  assert.equal(channelDirection('stripe'), '↔ pagamenti e link');
  assert.equal(channelDirection('whatsapp'), '↔ bidirezionale');
  assert.equal(channelDirection('sconosciuto'), null);
  assert.equal(channelDirection(''), null);
  assert.equal(channelDirection(null), null);
});

test('sigla di ripiego per gli sconosciuti, mai vuota', () => {
  assert.equal(channelSigla('pippo'), 'PI');
  assert.equal(channelSigla(''), '·');
  assert.equal(channelSigla(null), '·');
  assert.equal(channelSigla(undefined), '·');
  assert.equal(CHANNEL_DIRECTION.whatsapp, '↔ bidirezionale');
});
