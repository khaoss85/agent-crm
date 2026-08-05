// @ts-check

/**
 * Disqualify a lead (ADR-011 code-first action).
 *
 * Allowed only from status `new`. Sets the lead's managed fields — status →
 * disqualified, disqualificationReason → the required reason, clearing any
 * qualifiedAt. No Task is created. A blank reason is rejected as a 400 by the
 * runtime's input validation (empty strings count as missing).
 *
 * There is deliberately no reopen action in this starter; re-qualifying a
 * disqualified lead is out of scope for the milestone.
 */
export const disqualifyLead = {
  module: 'lead',
  name: 'disqualify',
  label: 'Disqualify lead',
  description: 'Mark the lead disqualified with a required reason. No task is created.',
  actionContract: 1,
  stateField: 'status',
  fromStates: ['new'],
  input: [{ name: 'reason', type: 'string', required: true }],
  /** @param {any} ctx */
  async execute({ record, input, managed }) {
    const lead = await managed(record.id, {
      status: 'disqualified',
      disqualificationReason: input.reason,
      qualifiedAt: null,
    });
    return {
      lead: {
        id: lead.id,
        status: lead.status,
        disqualificationReason: lead.disqualificationReason,
      },
    };
  },
};

export default disqualifyLead;
