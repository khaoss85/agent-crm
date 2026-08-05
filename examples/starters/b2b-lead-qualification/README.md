# B2B Lead Qualification starter

A minimal, code-first starter that dogfoods agent-crm's **record actions**
(ADR-011) and **transaction-aware events** (ADR-012). It models the smallest
useful slice of a B2B sales motion:

```
Capture lead ──▶ qualify  (atomically opens the first follow-up task)
            └──▶ disqualify (requires a reason, opens no task)
```

Nothing here is hardcoded into the framework. The Lead and Task modules are
ordinary manifest-generated modules, and qualify/disqualify are ordinary action
definitions. The Admin renders their buttons from action metadata — there is no
Lead-specific screen.

## What it contains

| File | Role |
| --- | --- |
| `lead.module.json` | Lead module manifest. `status`, `qualifiedAt`, `disqualificationReason` are **managed** fields — settable only by actions, never by CRUD. |
| `task.module.json` | Task module manifest. `sourceKey` is **unique** — the idempotency key that makes a repeated/concurrent qualify a no-op at the data layer. |
| `actions/qualify.js` | `lead.qualify` — from `new` only; sets the lead qualified and opens exactly one task, atomically. |
| `actions/disqualify.js` | `lead.disqualify` — from `new` only; sets the lead disqualified with a required reason; no task. |
| `install.mjs` | Builds a clean throwaway project, applies both modules, registers the actions, and verifies the whole flow. |

## Try it

From the repository root:

```bash
node examples/starters/b2b-lead-qualification/install.mjs
```

It prints a JSON summary and exits `0` when every guarantee holds. It writes
only to a temporary directory — your own database is untouched.

## Wire it into your own project by hand

1. **Apply the modules** (Task references Lead, so apply Lead first):

   ```bash
   npm run crm -- module create examples/starters/b2b-lead-qualification/lead.module.json --apply
   npm run crm -- module create examples/starters/b2b-lead-qualification/task.module.json --apply
   ```

2. **Register the actions** in `packages/actions/generated/index.js`:

   ```js
   import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';
   import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';

   export const generatedActions = [qualifyLead, disqualifyLead];
   ```

3. **Run it** — `npm run dev`, open the Admin, create a Lead, and the
   **Qualify** / **Disqualify** buttons appear on its detail. Or from the SDK:

   ```js
   const leads = client.module('lead');
   const lead = await leads.create({ firstName: 'Dana', lastName: 'Rossi', email: 'dana@acme.example' });
   await leads.action(lead.id, 'qualify', { dueAt: '2026-08-12T09:00:00Z' });
   ```

## Guarantees demonstrated

- **Atomic** — the lead update and the task insert commit together or not at
  all. A failure creating the task rolls back the status change.
- **Exactly one task** — the deterministic `sourceKey` (`qualify:<leadId>`)
  plus the `new`-only guard prevent duplicate follow-ups under repeat or
  concurrent calls; the second attempt is a clean `409`.
- **Events after commit** — `lead.updated` and `task.created` are dispatched
  only after the outer transaction commits (ADR-012), so a subscriber never
  observes a half-applied qualify.
- **No CRUD bypass** — `status` cannot be moved to `qualified` through the
  generic create/update surface; the managed-field policy rejects it with a
  `400` at the service boundary.

## Deliberately out of scope

Lead conversion to Company/Contact/Opportunity, pipelines and stages, a general
task engine, reminders, reopen, scheduling, and auth/tenancy. This starter is
the seed, not the CRM.
