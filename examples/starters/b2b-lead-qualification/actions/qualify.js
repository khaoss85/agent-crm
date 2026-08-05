// @ts-check

/**
 * Qualify a lead (ADR-011 code-first action).
 *
 * Allowed only from status `new`. In one atomic unit it:
 *   1. sets the lead's managed fields — status → qualified, qualifiedAt → now,
 *      clearing any prior disqualificationReason;
 *   2. creates exactly one follow-up Task (status `open`, the given dueAt),
 *      tagged with the deterministic idempotency key `qualify:<leadId>`.
 *
 * Atomicity comes from the action runtime: both writes run inside one outer
 * transaction, so if Task creation fails the lead update rolls back too. The
 * unique `sourceKey` on Task makes a repeated or concurrent qualify a no-op at
 * the data layer — but the `fromStates: ['new']` guard already rejects a second
 * qualify with a 409 before it reaches this code.
 *
 * `managed` is the only way to write the lead's workflow-managed fields; they
 * are refused through public create/update, so `status` can never become
 * `qualified` through generic CRUD.
 */
export const qualifyLead = {
  module: 'lead',
  name: 'qualify',
  label: 'Qualify lead',
  description: 'Mark the lead qualified and open the first follow-up task.',
  actionContract: 1,
  stateField: 'status',
  fromStates: ['new'],
  input: [{ name: 'dueAt', type: 'timestamp', required: true }],
  /** @param {any} ctx */
  async execute({ record, input, actor, modules, managed }) {
    const qualifiedAt = new Date().toISOString();
    const lead = await managed(record.id, {
      status: 'qualified',
      qualifiedAt,
      disqualificationReason: null,
    });
    const task = await modules.get('task').service.create(
      {
        title: `Follow up with ${record.firstName} ${record.lastName}`,
        status: 'open',
        dueAt: input.dueAt,
        leadId: record.id,
        sourceKey: `qualify:${record.id}`,
      },
      { actor },
    );
    return {
      lead: { id: lead.id, status: lead.status, qualifiedAt: lead.qualifiedAt },
      task: { id: task.id, dueAt: task.dueAt, sourceKey: task.sourceKey },
    };
  },
};

export default qualifyLead;
