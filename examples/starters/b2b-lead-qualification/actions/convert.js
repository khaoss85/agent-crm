// @ts-check

import { AppError, ValidationError } from '../../../../packages/core/src/errors.js';

const CURRENCY_RE = /^[A-Za-z]{3}$/;

/**
 * Convert a qualified lead into Company + Contact + Opportunity (ADR-013).
 *
 * Allowed only from status `qualified` — the state guard is also what makes a
 * repeat conversion a stable 409, because this action moves the lead to
 * `converted`. In one atomic transaction it:
 *
 *   1. resolves the Company: exact deterministic match on the lead's
 *      companyName (normalized: NFC, trimmed, whitespace collapsed,
 *      lowercased) — 0 matches creates one, 1 match reuses it, more than one
 *      is a 409 AMBIGUOUS_COMPANY (the framework refuses to guess);
 *   2. resolves the Contact by the lead's email (globally unique in core):
 *      none creates one under the resolved Company; one under the same
 *      Company is reused; one under a DIFFERENT Company is a 409
 *      CONTACT_COMPANY_MISMATCH (re-parenting would corrupt another account);
 *   3. creates exactly ONE Opportunity (type new_business, stage
 *      qualification) tagged sourceKey `lead-conversion:<leadId>` — a partial
 *      UNIQUE index makes a duplicate conversion Opportunity impossible at
 *      the database layer, even if the state guard were bypassed;
 *   4. writes the lead's managed conversion links (status → converted,
 *      convertedAt, all three ids) in ONE applyManaged call, so there is one
 *      lead audit/event and partial links cannot exist.
 *
 * All creates go through the real core module services via the declared
 * ctx.core adapters — validation, audit and events preserved; reused records
 * get no fake create audit/event. Everything commits or rolls back together;
 * a rollback can never delete pre-existing reused records.
 */
export const convertLead = {
  module: 'lead',
  name: 'convert',
  label: 'Convert lead',
  description: 'Create (or reuse) Company and Contact, open one Opportunity, and mark the lead converted.',
  actionContract: 1,
  stateField: 'status',
  fromStates: ['qualified'],
  input: [
    { name: 'opportunityName', type: 'string', required: true },
    { name: 'valueCents', type: 'integer', required: true },
    { name: 'currency', type: 'string' },
    { name: 'owner', type: 'string' },
  ],
  /** @param {any} ctx */
  async execute({ record, input, actor, core, managed, step, now }) {
    // Validate everything before the first write, so a bad input never costs
    // a rollback.
    if (input.valueCents < 0) {
      throw new ValidationError('valueCents must be zero or positive (integer minor units)', { field: 'valueCents' });
    }
    const currency = (input.currency ?? 'EUR');
    if (!CURRENCY_RE.test(currency)) {
      throw new ValidationError('currency must be a 3-letter ISO-4217 code', { field: 'currency' });
    }
    if (typeof record.companyName !== 'string' || record.companyName.trim() === '') {
      throw new ValidationError(
        'This lead has no companyName; set it before converting',
        { field: 'companyName' },
      );
    }
    const actorId = actor && typeof actor === 'object' && typeof (/** @type {any} */ (actor).id) === 'string'
      ? /** @type {any} */ (actor).id
      : 'conversion';
    const owner = input.owner ?? actorId;

    // 1. Company: deterministic exact reuse, create, or refuse ambiguity.
    const companyMatches = core.findCompaniesByNormalizedName(record.companyName);
    let company;
    let companyCreated = false;
    if (companyMatches.length > 1) {
      throw new AppError(
        `Cannot convert: ${companyMatches.length} companies match "${record.companyName.trim()}" — merge or rename before converting`,
        { code: 'AMBIGUOUS_COMPANY', status: 409, details: { field: 'companyName', matches: companyMatches.map((match) => match.id) } },
      );
    }
    if (companyMatches.length === 1) {
      company = companyMatches[0];
    } else {
      company = await core.createCompany({ name: record.companyName.trim() }, { actor });
      companyCreated = true;
    }
    step('company', { id: company.id, reused: !companyCreated });

    // 2. Contact: exact email reuse under the same company, else create, else refuse.
    const existingContact = core.findContactByEmail(record.email);
    let contact;
    let contactCreated = false;
    if (existingContact && existingContact.companyId !== company.id) {
      throw new AppError(
        `Cannot convert: ${record.email} already belongs to a contact of another company`,
        { code: 'CONTACT_COMPANY_MISMATCH', status: 409, details: { field: 'email', contactId: existingContact.id, companyId: existingContact.companyId } },
      );
    }
    if (existingContact) {
      contact = existingContact;
    } else {
      contact = await core.createContact(
        {
          companyId: company.id,
          firstName: record.firstName,
          lastName: record.lastName,
          email: record.email,
        },
        { actor },
      );
      contactCreated = true;
    }
    step('contact', { id: contact.id, reused: !contactCreated });

    // 3. Exactly one Opportunity, database-enforced via the unique sourceKey.
    const opportunity = await core.createOpportunity(
      {
        companyId: company.id,
        contactId: contact.id,
        name: input.opportunityName,
        type: 'new_business',
        valueCents: input.valueCents,
        currency: currency.toUpperCase(),
        stage: 'qualification',
        owner,
        sourceKey: `lead-conversion:${record.id}`,
      },
      { actor },
    );
    step('opportunity', { id: opportunity.id });

    // 4. One managed update carries the full conversion state.
    const lead = await managed(record.id, {
      status: 'converted',
      convertedAt: now(),
      convertedCompanyId: company.id,
      convertedContactId: contact.id,
      convertedOpportunityId: opportunity.id,
    });

    return {
      lead: {
        id: lead.id,
        status: lead.status,
        convertedAt: lead.convertedAt,
      },
      company: { id: company.id, reused: !companyCreated },
      contact: { id: contact.id, reused: !contactCreated },
      opportunity: { id: opportunity.id, sourceKey: opportunity.sourceKey },
    };
  },
};

export default convertLead;
