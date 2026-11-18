// @ts-check
/**
 * backlog:776cf3469e64 — nel mese in corso la frase del grafico «Nuovi
 * clienti per canale» finisce a oggi, mai a una domenica futura che i primi
 * contatti non possono ancora aver riempito.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelsLede } from '../apps/admin/public/admin-reporting.js';

const RUNNING = {
  total: 28,
  weeks: [{ week: '2026-10-26' }, { week: '2026-11-02' }, { week: '2026-11-09' }, { week: '2026-11-16' }],
};

test('776cf3469e64: nel mese in corso la frase finisce a oggi, non alla domenica della settimana', () => {
  assert.equal(
    channelsLede(RUNNING, '2026-11-18T10:00:00.000Z'),
    '28 primi contatti da un canale nelle 4 settimane dal 26 ott al 18 nov · ogni cliente conta una volta, nel canale del primo contatto',
  );
});

test('776cf3469e64: a mese chiuso la frase tiene la fine della settimana, come prima', () => {
  assert.equal(
    channelsLede(
      { total: 28, weeks: [{ week: '2026-09-28' }, { week: '2026-10-05' }, { week: '2026-10-12' }, { week: '2026-10-19' }] },
      '2026-11-18T10:00:00.000Z',
    ),
    '28 primi contatti da un canale nelle 4 settimane dal 28 set al 25 ott · ogni cliente conta una volta, nel canale del primo contatto',
  );
});

test('776cf3469e64: senza un oggi leggibile la frase tiene la fine della settimana, mai un tiro', () => {
  assert.equal(
    channelsLede(RUNNING, 'non-una-data'),
    '28 primi contatti da un canale nelle 4 settimane dal 26 ott al 22 nov · ogni cliente conta una volta, nel canale del primo contatto',
  );
});
