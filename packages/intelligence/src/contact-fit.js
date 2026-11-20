// @ts-check

import { computeDefinitionFingerprint } from '../../core/index.js';
import { validateScoringModel } from './registry.js';

/**
 * Contact-fit score (backlog:e80c6aee42c5): how close a contact is to the
 * space's ideal customer, with the reasons in plain Italian.
 *
 * The criteria come from the space's sales playbook (`idealCustomer`): the
 * playbook text is reduced to significant cue words, and the contact's own
 * evidence (role words, company-name words, email-domain words) is matched
 * against those cues. Changing the ideal customer changes the cues, so the
 * same contact scores differently — no model edit, no redeploy.
 *
 * The rules below follow this package's scoring-model contract (key, label,
 * non-zero weight, synchronous total `evaluate`, validated fail-closed by
 * `validateScoringModel`), so the definition is fingerprinted exactly like
 * every other model. What differs is the runner: lead scoring persists
 * score-runs against the project-owned `lead` record, while a contact fit is
 * computed on read (the Clienti list shapes it per row) and never stored —
 * a contact that enters or changes, or a playbook that is rewritten, reads
 * fresh with no button and no stale row.
 *
 * Deliberately NOT here: any country or sector claim. The contact record
 * carries no country or industry field, so a «paese fuori zona» verdict
 * would be invented. The miss reasons name only the dimensions the card
 * actually holds (role, company, completeness).
 */

/** The versioned model definition: identity, weights and thresholds. */
export const CONTACT_FIT_MODEL = {
  name: 'contact-fit-score',
  version: 1,
  label: 'Aderenza al cliente ideale',
  minScore: 0,
  maxScore: 100,
  config: {
    cueMinLength: 4,
    roleWeight: 40,
    companyWeight: 40,
    completeWeight: 20,
  },
  rules: [
    {
      key: 'role-fit',
      label: 'Ruolo in linea col cliente ideale',
      weight: 40,
      /** @param {any} ctx */
      evaluate({ contact, cues }) {
        const words = contactWords(contact?.role);
        const hit = words.find((word) => cues.includes(word)) ?? null;
        return hit === null
          ? { matched: false, reason: 'ruolo non in linea col cliente ideale' }
          : { matched: true, reason: `ruolo «${hit}» nel cliente ideale` };
      },
    },
    {
      key: 'company-fit',
      label: 'Azienda in linea col cliente ideale',
      weight: 40,
      /** @param {any} ctx */
      evaluate({ company, contact, cues }) {
        const words = [...contactWords(company?.name), ...contactWords(domainWords(contact?.email))];
        const hit = words.find((word) => cues.includes(word)) ?? null;
        return hit === null
          ? { matched: false, reason: 'azienda non in linea col cliente ideale' }
          : { matched: true, reason: `azienda «${hit}» nel cliente ideale` };
      },
    },
    {
      key: 'complete-card',
      label: 'Scheda completa',
      weight: 20,
      /** @param {any} ctx */
      evaluate({ contact }) {
        const matched = typeof contact?.firstName === 'string' && contact.firstName.trim() !== ''
          && typeof contact?.lastName === 'string' && contact.lastName.trim() !== ''
          && typeof contact?.role === 'string' && contact.role.trim() !== '';
        return matched
          ? { matched: true, reason: 'scheda completa (nome e ruolo)' }
          : { matched: false, reason: 'scheda incompleta (manca nome o ruolo)' };
      },
    },
  ],
};

/**
 * Italian glue words that carry no ideal-customer meaning, folded already
 * (no accents, lowercase): the cue extractor folds first, so this list holds
 * only folded forms. `cliente`, `azienda` and `ideale` are excluded on
 * purpose — every playbook names them, so they discriminate nothing.
 */
const FIT_STOPWORDS = new Set([
  'cliente', 'clienti', 'azienda', 'aziende', 'ideale', 'ideali',
  'alla', 'alle', 'allo', 'anche', 'ancora', 'altra', 'altre', 'altri', 'altro',
  'abbiamo', 'bene', 'cerca', 'cerchiamo', 'come', 'con', 'cui', 'che', 'chi',
  'dagli', 'dai', 'dal', 'dalla', 'dalle', 'dallo', 'degli', 'dei', 'del', 'della',
  'delle', 'dello', 'dentro', 'dopo', 'dove', 'durante', 'fuori', 'gia', 'hanno',
  'infatti', 'inoltre', 'loro', 'lontano', 'male', 'mai', 'meno', 'mentre', 'molto',
  'mia', 'miei', 'mie', 'mio', 'nel', 'nella', 'nelle', 'nello', 'non', 'nostra',
  'nostre', 'nostri', 'nostro', 'ogni', 'oltre', 'prima', 'poco', 'per', 'pero',
  'perche', 'piu', 'piuttosto', 'poiche', 'quando', 'quale', 'quali', 'quanto',
  'quella', 'quelle', 'quelli', 'quello', 'questa', 'queste', 'questi', 'questo',
  'quindi', 'senza', 'sempre', 'sopra', 'sotto', 'solo', 'sono', 'stessa', 'stesse',
  'stessi', 'stesso', 'sua', 'sue', 'sulla', 'sulle', 'sullo', 'suo', 'suoi', 'sul',
  'sui', 'sugli', 'tale', 'tali', 'tanto', 'tra', 'fra', 'troppo', 'tua', 'tue',
  'tuo', 'tuoi', 'tutta', 'tutte', 'tutti', 'tutto', 'una', 'uno', 'due', 'tre',
  'vicino', 'vogliamo', 'vostra', 'vostre', 'vostri', 'vostro',
]);

/**
 * The significant cue words of an ideal-customer text: lowercase, split on
 * anything but letters, at least `min` chars, no glue words, deduplicated
 * and sorted so the same text always yields the same cues.
 * @param {unknown} idealCustomer
 * @param {number} [min]
 */
export function extractIdealCues(idealCustomer, min = 4) {
  if (typeof idealCustomer !== 'string') return [];
  const words = idealCustomer
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^a-z]+/u)
    .filter((word) => word.length >= min && !FIT_STOPWORDS.has(word));
  return [...new Set(words)].sort();
}

/**
 * The evidence words of one free-text field: same folding as the cues, so a
 * role «Titolare» meets the cue «titolare».
 * @param {unknown} value
 */
export function contactWords(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(
    value.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').split(/[^a-z]+/u)
      .filter((word) => word.length >= 4),
  )].sort();
}

/**
 * The domain words of a mailbox (`marco@palestra-esempio.it` → the middle
 * parts): a company name often hides there when the company line is empty.
 * Free-mail domains prove nothing and are excluded.
 * @param {unknown} email
 */
export function domainWords(email) {
  if (typeof email !== 'string') return '';
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  if (domain === '' || FREE_MAIL_DOMAINS.has(domain)) return '';
  return domain.split('.').slice(0, -1).join(' ');
}

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.it', 'hotmail.com', 'hotmail.it', 'outlook.com',
  'outlook.it', 'live.com', 'live.it', 'icloud.com', 'libero.it', 'virgilio.it',
  'tiscali.it', 'alice.it', 'email.it', 'pec.it',
]);

/** The fingerprinted identity of the contact-fit model (registry discipline). */
export function contactFitFingerprint() {
  validateScoringModel(CONTACT_FIT_MODEL);
  return computeDefinitionFingerprint({
    type: 'scoring-model',
    name: CONTACT_FIT_MODEL.name,
    version: CONTACT_FIT_MODEL.version,
    minScore: CONTACT_FIT_MODEL.minScore,
    maxScore: CONTACT_FIT_MODEL.maxScore,
    config: CONTACT_FIT_MODEL.config,
    rules: CONTACT_FIT_MODEL.rules.map((rule) => ({
      key: rule.key,
      label: rule.label,
      weight: rule.weight,
      evaluate: rule.evaluate,
    })),
  });
}

/**
 * Score one contact against one space playbook. Pure: the caller hands the
 * records it already read, so this never touches storage.
 *
 * Without a playbook, or with a playbook whose ideal customer carries no
 * usable cue, the score is unavailable — never a zero that would read as
 * «not a fit».
 *
 * @param {{contact?: any, company?: any}} subject
 * @param {any} playbook the space playbook row (or null)
 */
export function scoreContactFit(subject = {}, playbook = null) {
  const idealCustomer = typeof playbook?.idealCustomer === 'string' ? playbook.idealCustomer : null;
  const cues = extractIdealCues(idealCustomer, CONTACT_FIT_MODEL.config.cueMinLength);
  if (cues.length === 0) {
    return Object.freeze({
      available: false,
      value: null,
      reasons: Object.freeze(['il cliente ideale non è compilato: compila il playbook e il punteggio compare']),
      model: CONTACT_FIT_MODEL.name,
      version: CONTACT_FIT_MODEL.version,
    });
  }
  const context = Object.freeze({
    contact: subject?.contact ?? null,
    company: subject?.company ?? null,
    cues: Object.freeze(cues),
    config: Object.freeze({ ...CONTACT_FIT_MODEL.config }),
  });
  let total = 0;
  const reasons = [];
  for (const rule of CONTACT_FIT_MODEL.rules) {
    let outcome;
    try {
      outcome = rule.evaluate(context);
    } catch (error) {
      throw new Error(
        `Contact-fit rule "${rule.key}" threw (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'})`,
      );
    }
    const matched = outcome === true || (outcome !== null && typeof outcome === 'object' && outcome.matched === true);
    const reason = outcome !== null && typeof outcome === 'object' && typeof outcome.reason === 'string'
      ? outcome.reason
      : (matched ? rule.label : `regola ${rule.key} senza motivo`);
    if (matched) total += rule.weight;
    reasons.push(reason);
  }
  if (total > CONTACT_FIT_MODEL.maxScore) total = CONTACT_FIT_MODEL.maxScore;
  if (total < CONTACT_FIT_MODEL.minScore) total = CONTACT_FIT_MODEL.minScore;
  return Object.freeze({
    available: true,
    value: total,
    reasons: Object.freeze(reasons),
    model: CONTACT_FIT_MODEL.name,
    version: CONTACT_FIT_MODEL.version,
  });
}
