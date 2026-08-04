// @ts-check

export const OPPORTUNITY_TYPES = Object.freeze(['new_business', 'renewal', 'upsell']);
export const OPPORTUNITY_STAGES = Object.freeze([
  'discovery',
  'qualification',
  'proposal',
  'approval_pending',
  'negotiation',
  'won',
  'lost',
]);
export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

export const CRM_SCHEMA = Object.freeze({
  version: '0.1.0',
  money: 'integer cents',
  entities: [
    {
      name: 'company',
      description: 'An organization with which the business has a relationship.',
      fields: {
        id: 'uuid',
        name: 'string required',
        domain: 'string optional',
        createdAt: 'ISO timestamp',
        updatedAt: 'ISO timestamp',
      },
    },
    {
      name: 'contact',
      description: 'A person associated with a company.',
      fields: {
        id: 'uuid',
        companyId: 'company uuid required',
        firstName: 'string required',
        lastName: 'string required',
        email: 'email required',
        role: 'string optional',
        createdAt: 'ISO timestamp',
        updatedAt: 'ISO timestamp',
      },
    },
    {
      name: 'opportunity',
      description: 'A new-business, renewal or upsell commercial process.',
      fields: {
        id: 'uuid',
        companyId: 'company uuid required',
        contactId: 'contact uuid optional',
        name: 'string required',
        type: OPPORTUNITY_TYPES,
        valueCents: 'non-negative integer',
        currency: 'ISO 4217 string',
        stage: OPPORTUNITY_STAGES,
        owner: 'string required',
        expectedCloseDate: 'ISO timestamp optional',
        createdAt: 'ISO timestamp',
        updatedAt: 'ISO timestamp',
      },
    },
    {
      name: 'approval',
      description: 'A human decision required by an explicit commercial policy.',
      fields: {
        id: 'uuid',
        opportunityId: 'opportunity uuid required',
        status: APPROVAL_STATUSES,
        reason: 'string required',
        requestedBy: 'actor id',
        decidedBy: 'actor id optional',
        requestedAt: 'ISO timestamp',
        decidedAt: 'ISO timestamp optional',
      },
    },
  ],
});
