// @ts-check

import { createFollowUp } from '../../../../packages/work/src/index.js';

/**
 * Qualify a lead (ADR-011 code-first action).
 *
 * Allowed only from status `new`. In one atomic unit it:
 *   1. sets the lead's managed fields — status → qualified, qualifiedAt → now,
 *      clearing any prior disqualificationReason;
 *   2. opens exactly one follow-up **Task** on that lead, with its `task_created`
 *      **Activity**, through the `work` package's one follow-up creator, keyed by
 *      the deterministic business identity `lead-qualified:<leadId>`.
 *
 * **This is the migration of the bespoke Task slice.** Before Work v1 the
 * starter shipped its own `task` module — table `tasks`, a *required* `leadId`
 * reference, `status` in `open`/`done`, and every field publicly writable, so a
 * client could forge a follow-up through generic CRUD. That module is gone; the
 * table it wrote is untouched and still readable, and
 * `packages/work/src/legacy-tasks.js` adopts its rows forward. See
 * `docs/plans/activity-task-operations.md` §6.
 *
 * **Why this imports the creator rather than opening the capability.**
 * `PackageRegistry.capability({ consumer })` resolves the consumer against
 * *registered packages*, and this is a **host** action in project source — the
 * project is not a package and cannot declare a requirement. Rather than weaken
 * the declaration check (which is the entire value of the seam), the project
 * composes the package's exported creator the same way
 * `packages/domains/generated/index.js` composes the package itself. It is the
 * **same function** the `follow-up@1` capability closes over: one
 * implementation, two callers, no fallback.
 *
 * Atomicity comes from the action runtime: the lead update, the task and the
 * activity all run inside one outer transaction, so if any of them fails the
 * others roll back. The unique `sourceKey` makes a repeated or concurrent
 * qualify replay rather than duplicate — and the `fromStates: ['new']` guard
 * already rejects a second qualify with a 409 before it reaches this code.
 *
 * `managed` is the only way to write the lead's workflow-managed fields; they
 * are refused through public create/update, so `status` can never become
 * `qualified` through generic CRUD.
 */

/** Control characters, line and paragraph separators — never stored as-is in a label. */
const UNSAFE_DISPLAY_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Display text derived from customer data, made safe for a stored label.
 *
 * Hostile or merely untidy record values must not be able to fail a
 * qualification: a lead whose name carries a newline is a lead, not an error.
 * Control characters are replaced and the value is bounded, so what is stored is
 * inert text either way.
 *
 * @param {unknown} value
 */
function displayText(value) {
  return String(value ?? '')
    .replace(UNSAFE_DISPLAY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

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
  async execute({ record, input, actor, modules, managed, now }) {
    const qualifiedAt = now();
    const lead = await managed(record.id, {
      status: 'qualified',
      qualifiedAt,
      disqualificationReason: null,
    });
    const person = `${displayText(record.firstName)} ${displayText(record.lastName)}`.trim();
    const who = person === '' ? `lead ${record.id}` : person;
    const followUp = await createFollowUp({ modules, actor, now }, {
      // The business identity of this follow-up: the lead that was qualified.
      // No clock is in it — a key that moves every millisecond identifies
      // nothing, and every retry would open a second task.
      sourceKey: `lead-qualified:${record.id}`,
      title: `Follow up with ${who}`,
      dueAt: input.dueAt,
      subject: { resource: 'lead', id: record.id, owner: 'host', label: who },
      source: { package: 'host', action: 'qualify' },
    });
    return {
      lead: { id: lead.id, status: lead.status, qualifiedAt: lead.qualifiedAt },
      task: {
        id: followUp.task.id,
        status: followUp.task.status,
        dueAt: followUp.task.dueAt,
        sourceKey: followUp.task.sourceKey,
      },
      activity: { id: followUp.activity?.id ?? null, kind: followUp.activity?.kind ?? null },
      replayed: followUp.replayed,
    };
  },
};

export default qualifyLead;
