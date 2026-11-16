// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * The sales playbook proposal (backlog:ad7e03ac).
 *
 * The space's playbook — who the space is, what it sells, to whom, in
 * what tone, what never to say, links and hours — is the context every
 * space AI writes from (Kombo map 12/11, sections 8-9: «si dice
 * l'obiettivo, l'agente propone, la persona approva»). This module is the
 * framework side of the proposal: it builds the prompt from a site or a
 * plain description, calls the package's `complete` handle (purpose
 * `assistant`, so the spend is audited exactly like every other
 * assistant call, reusing `message-draft.js` and never a second billing
 * path), and parses the model's answer back into the playbook shape the
 * member reviews.
 *
 * What is deliberately NOT here: any storage, any session, any HTTP.
 * Proposing returns values and saves nothing — the member's explicit
 * confirm (`savePlaybook` on the `sales-playbook` module) is the only
 * write. A test pins this: the fake `complete` below answers, the
 * proposal comes back, and no row exists until `savePlaybook` runs.
 * The same no-storage split is what makes this testable against a fake
 * `complete`.
 */

/** The purpose a proposal spends as: the assistant's own audited workload. */
export const SALES_PLAYBOOK_PROPOSE_PURPOSE = 'assistant';

/** The playbook fields the proposal fills, in the order the member reads them. */
export const SALES_PLAYBOOK_FIELDS = Object.freeze([
  'companyName',
  'description',
  'website',
  'products',
  'idealCustomer',
  'tone',
  'avoidTopics',
  'links',
  'hours',
]);

export const SALES_PLAYBOOK_MAX_SOURCE_CHARS = 8000;
export const SALES_PLAYBOOK_MAX_FIELD_CHARS = 2000;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * @param {unknown} value @param {string} field @param {number} max
 */
function optionalField(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`playbook proposal ${field} must be text`, { field });
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text === '') return null;
  if (text.length > max) {
    throw new ValidationError(`playbook proposal ${field} is at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(text.replace(/\n/g, ''))) {
    throw new ValidationError(`playbook proposal ${field} carries no control characters`, { field });
  }
  return text;
}

/**
 * @param {unknown} value @param {string} field @param {number} max
 */
function requiredSource(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`playbook proposal ${field} must be non-empty text`, { field });
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > max) {
    throw new ValidationError(`playbook proposal ${field} is at most ${max} characters`, { field });
  }
  return text;
}

/**
 * Validate the proposal request. At least one source travels: a site, a
 * plain description, or both. Throws fail-closed; returns the frozen
 * request the prompt builder and the caller execute.
 */
export function assertPlaybookProposalInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('playbook proposal input must be a plain object', { field: 'input' });
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const hasWebsite = typeof value.website === 'string' && value.website.trim() !== '';
  const hasDescription = typeof value.description === 'string' && value.description.trim() !== '';
  if (!hasWebsite && !hasDescription) {
    throw new ValidationError('playbook proposal needs a website or a description', { field: 'input' });
  }
  return Object.freeze({
    website: hasWebsite
      ? requiredSource(value.website, 'website', SALES_PLAYBOOK_MAX_SOURCE_CHARS)
      : null,
    description: hasDescription
      ? requiredSource(value.description, 'description', SALES_PLAYBOOK_MAX_SOURCE_CHARS)
      : null,
  });
}

/**
 * Build the completion messages for one proposal. Pure: the acceptance
 * pins that the member's own source reaches the model — the site or the
 * description travels verbatim — so the test reads it back from exactly
 * what this function returns.
 *
 * @param {{website: string | null, description: string | null}} source
 */
export function buildPlaybookProposalPrompt(source) {
  const checked = assertPlaybookProposalInput(source);
  const lines = [];
  if (checked.website !== null) lines.push(`Sito dell'azienda: ${checked.website}`);
  if (checked.description !== null) lines.push(`Descrizione dell'attivita: ${checked.description}`);
  const user = [
    ...lines,
    '',
    "Scrivi il playbook di vendita di questa attivita: chi e, cosa vende, a chi vende,",
    'con che tono parla, cosa non deve mai dire, link utili e orari.',
    'Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, con esattamente queste chiavi',
    '(ogni valore e testo semplice, una stringa vuota dove non sai cosa scrivere):',
    '{"companyName": "<nome azienda>", "description": "<cosa fa in una frase>",',
    ' "website": "<sito>", "products": "<prodotti e servizi, uno per riga>",',
    ' "idealCustomer": "<cliente ideale>", "tone": "<tono di voce>",',
    ' "avoidTopics": "<cose da non dire mai>", "links": "<link utili, uno per riga>",',
    ' "hours": "<orari>"}',
  ].join('\n');
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({
        role: 'system',
        content: 'Sei l\u2019assistente che compila il playbook di vendita di una piccola azienda italiana. '
          + 'Scrivi in italiano, concreto e senza gergo. Rispondi solo con il JSON richiesto, '
          + 'senza inventare prodotti, prezzi, orari o link che la fonte non nomina.',
      }),
      Object.freeze({ role: 'user', content: user }),
    ]),
  });
}

/**
 * Parse one model answer back into the playbook proposal. Missing or
 * empty fields stay null so the member fills them by hand; an answer
 * with no usable field at all refuses typed instead of proposing an
 * empty playbook.
 *
 * @param {unknown} text
 */
export function parsePlaybookProposalResponse(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AppError('the model did not answer a usable playbook', {
      code: 'PLAYBOOK_PROPOSAL_INVALID', status: 502,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new AppError('the model did not answer a usable playbook', {
      code: 'PLAYBOOK_PROPOSAL_INVALID', status: 502,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('the model did not answer a usable playbook', {
      code: 'PLAYBOOK_PROPOSAL_INVALID', status: 502,
    });
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const proposal = {};
  for (const field of SALES_PLAYBOOK_FIELDS) {
    proposal[field] = optionalField(record[field], field, SALES_PLAYBOOK_MAX_FIELD_CHARS);
  }
  if (Object.values(proposal).every((value) => value === null)) {
    throw new AppError('the model did not answer a usable playbook', {
      code: 'PLAYBOOK_PROPOSAL_INVALID', status: 502,
    });
  }
  return Object.freeze(proposal);
}

/**
 * Propose one sales playbook through the package's `complete` handle and
 * return it unsaved: nothing is stored here, the member's explicit
 * confirm writes it. The space, the caps and the audit are `complete`'s
 * own: a disabled space refuses with `LLM_SPACE_DISABLED` and a missing
 * key with `LLM_SECRET_UNAVAILABLE` before any provider is touched.
 *
 * @param {{complete: (request: any) => Promise<any>, spaceId: string, actor: unknown,
 *   website?: unknown, description?: unknown, maxTokens?: number,
 *   organizationId?: string}} input
 */
export async function proposeSalesPlaybook({
  complete, spaceId, actor, website = null, description = null, maxTokens = 1024,
  organizationId = undefined,
}) {
  if (typeof complete !== 'function') {
    throw new ValidationError('playbook proposal needs the llm complete handle', { field: 'complete' });
  }
  const checked = assertPlaybookProposalInput({ website, description });
  const { messages } = buildPlaybookProposalPrompt(checked);
  const result = await complete({
    actor, spaceId, purpose: SALES_PLAYBOOK_PROPOSE_PURPOSE, messages, maxTokens,
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  // Like the message draft: the no-key dry run answers the fixture's
  // literal text, which is not the playbook JSON the model owes. A dry
  // run answers without error but stays off — no presentable proposal
  // rides a dry run, only the reason, so nothing fixture-shaped can
  // reach the member's confirm screen as a model proposal.
  if (result?.dryRun === true) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'the completion ran as a dry run without a key: the playbook proposal stays off, compile it by hand instead',
      proposal: null,
      dryRun: true,
    });
  }
  const proposal = parsePlaybookProposalResponse(result?.text);
  return Object.freeze({ ...proposal, dryRun: result?.dryRun === true });
}
