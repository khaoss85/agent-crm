// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingClaim, isWebLink, placeRefusal } from '../apps/admin/public/admin-calendario.js';

/**
 * backlog:9ff9a9ee1fea (review indipendente su agent-crm#1029, testa
 * 9c37750169: P1 + P2). La cura del ponte /bo (pilota #695) accetta
 * location/locationUrl, ma il ponte rifiuta i campi che non conosce con
 * BO_APPOINTMENT_BODY_REFUSED (revert #1021): la forma senza luogo deve
 * restare quella di prima, e uno schema nudo non è un link.
 */

function claimWithoutPlace() {
  return bookingClaim({
    spaceId: 'locale',
    customer: { resource: 'contact', id: 'c1' },
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    priceCents: 4500,
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
    notes: null,
    location: null,
    locationUrl: null,
  });
}

test('9ff9a9ee1fea P1: senza luogo il claim omette le chiavi, la forma resta quella di prima', () => {
  const claim = claimWithoutPlace();
  assert.ok(!('location' in claim), 'no location key when the place is absent');
  assert.ok(!('locationUrl' in claim), 'no locationUrl key when the place is absent');
});

test('9ff9a9ee1fea P1: con il luogo il claim porta entrambe le chiavi', () => {
  const claim = bookingClaim({
    spaceId: 'locale',
    customer: { resource: 'contact', id: 'c1' },
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    priceCents: 4500,
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
    notes: null,
    location: 'Online',
    locationUrl: 'https://meet.example.com/abc-def',
  });
  assert.equal(claim.location, 'Online');
  assert.equal(claim.locationUrl, 'https://meet.example.com/abc-def');
});

test('9ff9a9ee1fea P2: uno schema nudo non è un link di riunione', () => {
  assert.ok(!isWebLink('http://'), 'bare http scheme is not a meeting link');
  assert.ok(!isWebLink('https://'), 'bare https scheme is not a meeting link');
  assert.ok(!isWebLink('https:// '), 'scheme with only spaces is not a meeting link');
  assert.ok(!isWebLink('https://exa mple.com/x'), 'a link with whitespace is not a meeting link');
  assert.ok(isWebLink('https://meet.example.com/abc-def'), 'a real meeting link still passes');
});

test('9ff9a9ee1fea P2: un link a schema nudo non lascia il form e lo dice in italiano', () => {
  const refusal = placeRefusal({ location: 'Online', locationUrl: 'https://' });
  assert.ok(typeof refusal === 'string' && refusal !== '', 'the bare-scheme link is refused');
  assert.ok(/link/i.test(refusal), 'the note names the link in Italian');
});
