import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_FIT_MODEL,
  contactFitFingerprint,
  extractIdealCues,
  scoreContactFit,
} from '../packages/intelligence/src/index.js';

/**
 * The contact-fit score (backlog:e80c6aee42c5): how close a contact is to the
 * space's ideal customer, with the reasons in plain Italian.
 *
 * What it must prove: the model is composed in the intelligence package
 * (exported, validated, fingerprinted); the score is about the CONTACT the
 * caller hands over, not only a lead example; the criteria come from the
 * space's playbook, so the same contact scores differently when the ideal
 * customer changes; without a playbook (or with an unusable ideal customer)
 * the score is unavailable — never a zero that would read as «not a fit».
 */

const GUIDO = {
  firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it', role: 'Titolare',
};
const PALESTRA = { name: 'Palestra Esempio', domain: 'palestra-esempio.it' };
const PALESTRA_PLAYBOOK = { idealCustomer: 'Il cliente ideale è il titolare di una palestra che vende abbonamenti e pacchetti' };
const STUDIO_PLAYBOOK = { idealCustomer: 'Il cliente ideale è il commercialista di uno studio associato con partita IVA' };

test('the contact-fit model is composed in the intelligence package and fingerprinted', () => {
  assert.equal(CONTACT_FIT_MODEL.name, 'contact-fit-score');
  assert.ok(CONTACT_FIT_MODEL.rules.length >= 2);
  for (const rule of CONTACT_FIT_MODEL.rules) {
    assert.ok(typeof rule.key === 'string' && rule.key !== '');
    assert.ok(Number.isFinite(rule.weight) && rule.weight > 0);
    assert.equal(typeof rule.evaluate, 'function');
  }
  const fingerprint = contactFitFingerprint();
  assert.equal(typeof fingerprint, 'string');
  assert.equal(fingerprint.length, 64);
  assert.equal(contactFitFingerprint(), fingerprint, 'the definition fingerprints identically');
});

test('the score is about the contact handed over: a matching contact scores high', () => {
  const fit = scoreContactFit({ contact: GUIDO, company: PALESTRA }, PALESTRA_PLAYBOOK);
  assert.equal(fit.available, true);
  assert.ok(fit.value >= 80, `a titolare of a palestra reads high, got ${fit.value}`);
  assert.ok(fit.reasons.length >= 2, 'every rule names its reason');
  assert.ok(fit.reasons.some((reason) => reason.includes('titolare')), `a reason names the cue: ${fit.reasons}`);
  assert.ok(fit.reasons.every((reason) => typeof reason === 'string' && reason !== ''));
});

test('the same playbook scores a different profile differently', () => {
  const other = scoreContactFit({
    contact: { firstName: 'Anna', lastName: 'Bianchi', email: 'anna@studio-associato.it', role: 'Commercialista' },
    company: { name: 'Studio Associato', domain: 'studio-associato.it' },
  }, PALESTRA_PLAYBOOK);
  const fit = scoreContactFit({ contact: GUIDO, company: PALESTRA }, PALESTRA_PLAYBOOK);
  assert.equal(other.available, true);
  assert.ok(other.value < fit.value, `different profiles read different scores: ${other.value} vs ${fit.value}`);
});

test('the criteria come from the playbook: changing the ideal customer changes the score', () => {
  const subject = { contact: GUIDO, company: PALESTRA };
  const palestra = scoreContactFit(subject, PALESTRA_PLAYBOOK);
  const studio = scoreContactFit(subject, STUDIO_PLAYBOOK);
  assert.equal(palestra.available, true);
  assert.equal(studio.available, true);
  assert.notEqual(palestra.value, studio.value, 'the same contact scores differently under another ideal');
  assert.ok(studio.value < palestra.value, `a titolare of a palestra drops under a commercialista ideal: ${studio.value} vs ${palestra.value}`);
});

test('without a playbook, or with an unusable ideal, the score is unavailable — never zero', () => {
  for (const playbook of [null, undefined, {}, { idealCustomer: null }, { idealCustomer: '' }, { idealCustomer: 'il cliente ideale' }]) {
    const fit = scoreContactFit({ contact: GUIDO, company: PALESTRA }, playbook);
    assert.equal(fit.available, false, `unavailable for ${JSON.stringify(playbook)}`);
    assert.equal(fit.value, null);
    assert.ok(fit.reasons.length > 0, 'the reason says what to do');
    assert.match(fit.reasons[0], /cliente ideale|playbook/);
  }
});

test('cue extraction folds accents and drops glue words, deterministically', () => {
  assert.deepEqual(extractIdealCues('Titolare Palestra TITOLARE palestra'), ['palestra', 'titolare']);
  assert.deepEqual(extractIdealCues(PALESTRA_PLAYBOOK.idealCustomer), extractIdealCues(PALESTRA_PLAYBOOK.idealCustomer));
  assert.ok(!extractIdealCues(PALESTRA_PLAYBOOK.idealCustomer).includes('cliente'), 'cliente names no cue');
  assert.ok(!extractIdealCues(PALESTRA_PLAYBOOK.idealCustomer).includes('ideale'), 'ideale names no cue');
});
