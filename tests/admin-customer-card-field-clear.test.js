import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldValueRefusalText } from '../apps/admin/public/admin-customer-card.js';

/**
 * Voce ed03a20360d5: un rifiuto di validazione dice il motivo in italiano,
 * mai «riprova più tardi». La scheda salvava con humanReadError (l'aiuto
 * delle letture) e ogni 400 leggeva «Salvataggio non riuscito. Riprova più
 * tardi.»: ora il rifiuto nominato dal server passa com'è, il resto tiene
 * il testo della scrittura.
 */

test('a named validation refusal reads the reason the server gave', () => {
  const italian = '«Amico» vuole sì o no';
  for (const error of [
    { code: 'VALIDATION_ERROR', status: 400, message: italian },
    { code: 'VALIDATION_FAILED', status: 422, message: italian },
    { status: 400, message: italian },
    { status: 422, message: italian },
  ]) {
    assert.equal(fieldValueRefusalText(error), italian, `${error.code ?? error.status} names the reason`);
  }
});

test('nothing a validation refusal answers is «riprova più tardi»', () => {
  for (const error of [
    { code: 'VALIDATION_ERROR', status: 400, message: '«Amico» vuole sì o no' },
    { code: 'VALIDATION_ERROR', status: 400, message: '' },
    { code: 'VALIDATION_ERROR', status: 400 },
    { status: 503, message: 'l’AI non è attiva' },
    { status: 0, message: 'fetch failed' },
    new TypeError('fetch failed'),
    null,
  ]) {
    assert.ok(
      !/riprova più tardi/i.test(fieldValueRefusalText(error)),
      `no retry-later text for ${JSON.stringify(error?.code ?? error?.status ?? String(error))}`,
    );
  }
});

test('an unnamed failure keeps the write wording', () => {
  assert.equal(
    fieldValueRefusalText({ code: 'VALIDATION_ERROR', status: 400, message: '' }),
    'Alcuni dati non sono validi: controlla i campi e riprova.',
    'a named-but-empty refusal still reads Italian, never retry-later',
  );
  assert.equal(
    fieldValueRefusalText({ status: 0, message: 'fetch failed' }),
    'Connessione non riuscita, riprova.',
  );
});
