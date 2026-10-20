# Space Permissions (`space-permissions`)

BO-F0-06 — backoffice "08 Spazi e accessi": the five AI switches of a space,
and what a switched-off action becomes.

## What it owns

- The five AI permission keys and their defaults
  (`src/permissions.js`): `merge-duplicates`, `drafts`,
  `send-without-approval`, `book-appointments`, `move-offers`. Only
  `send-without-approval` is off by default — a fresh space sends nothing
  unattended until its owner opts in.
- Per-space overrides: `space-permission-override` rows, one per flipped
  switch, keyed by space id.
- Action proposals: `space-ai-proposal` rows. A switched-off action is never
  executed on the proposal path; it is recorded as `proposed` until a human
  `approve`s or `refuse`s it, both terminal. Approval authorizes that one
  action — executing it stays the consumer's job.
- Invitation shape review (`src/invites.js`): `reviewSpaceInvite` checks one
  assignment — a role mirrored from the control plane (`owner`, `operator`,
  `observer`) plus a non-empty set of reply channels (the framework's
  `CHANNELS` minus entry-only TikTok and site-form). Refusal is data, shown
  next to the form. Assignments are validated, never stored: membership is
  control-plane data.

## How consumers use it

Through the `space-permission-gate@1` capability (declared in `requires`,
opened with `domains.capability(...)`):

1. `gate({ spaceId, permission })` → `{ decision: 'allow' }` or
   `{ decision: 'proposal' }`.
2. On `allow`, run. On `proposal`, call
   `propose({ spaceId, permission, actionKind, actionKey, summary, actor })`
   inside the same transaction and stop. There is no third outcome.
   `actor` must be identified (anonymous callers are refused with
   `SPACE_ACTOR_REQUIRED`); the proposal stamp comes from the server clock,
   never from the caller.
3. Reads are space-scoped: `effective(spaceId)` and
   `proposal(spaceId, proposalId)` never reach another space's rows.

Actions (same semantics over the record path): `set-permission`
(input-driven upsert, human user actor only — `HUMAN_APPROVAL_REQUIRED`
otherwise, so a gated agent can never switch itself on), `propose-action`
(refuses with `SPACE_PERMISSION_ENABLED` when the switch is on — proposing
what is allowed is a caller bug), `approved` / `refused` (human user actor
only, `HUMAN_APPROVAL_REQUIRED` otherwise).

## What it deliberately does not do

Spaces, members and invitation storage (control plane); role vocabulary
beyond the control-plane mirror; execution of an approved action; provider
sends of any kind. See `metadata()` `notModeled`.

## Enable it

One static import in `packages/domains/generated/index.js`:

```js
import { createSpacePermissionsDomain } from '../../space-permissions/src/index.js';
// generatedDomains = [createSpacePermissionsDomain()];
```

Removing the line removes the domain; the application keeps working without
it. Optional per space from the Blueprint, like every domain package.
