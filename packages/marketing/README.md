# Marketing — Funnel Insight + Campaign Proposal (MK1)

An agent records supplied funnel counts, prepares a campaign proposal, and a
human reviews it in Admin. Approval creates local evidence. This package sends,
publishes and spends nothing, and declares no provider or external operation.
It does not query a source, validate consent, resolve audience membership,
verify a provider installation or schedule a campaign.

## Enable in a project

The repository's default registry remains empty. In a project using this
package, generate its records with the existing module factory:

```sh
for manifest in packages/marketing/modules/*.module.json; do
  npm run crm -- module create "$manifest" --apply
done
```

Then add this static import and instance to the project's
`packages/domains/generated/index.js`, preserving any other package entries:

```js
import { createMarketingDomain } from '../../marketing/src/index.js';

export const generatedDomains = [createMarketingDomain({
  proposalPolicies: [{
    name: 'standard-proposal', version: 1, label: 'Standard proposal',
    config: { allowedChannels: ['email'], allowedModes: ['one-shot'] },
  }],
})];
```

Validate the resulting composition with `npm run crm -- app inspect --json`.
The Admin Marketing section appears when the running schema publishes this
package. The Admin code is app-owned; no package Admin extension seam is claimed.
Removing the registry entry removes the actions and section; existing generated
records and their data remain. No global default composition is changed.

## Public journey

Use the existing SDK's `client.module(name)` interface (also available through
its generic HTTP record/action routes):

1. Create `funnel-definition` with `name`, `label`, `stepsJson` (an ordered JSON
   array of step names) and `version`. These are authored definitions; they may
   be edited. They do not assert measured data.
2. Run `observe` on that definition with `counts` (one non-negative safe integer
   per step) and a stated `source`. It creates a `funnel-run`, snapshotting steps
   and counts, and a `funnel-drop-insight` for the largest relative loss. A run
   without a measurable loss returns `insightId: null`. It performs no query or
   causal diagnosis. Each successful observation is a new observation.
3. Run `prepare-proposal` on the insight with `draft`. It returns `proposalId`;
   each insight accepts one proposal, and a repeat is refused.
4. Run `propose` on that proposal with `policy` and explicit `policyVersion`.
   Every section must be stated: audience, exclusions, channel, provider
   rationale, content plan, tracking plan, risks and required approvals.
   Incomplete content is recorded as `refused` with named missing sections.
   `revise` replaces content on a draft or refused proposal, then `propose`
   re-evaluates it. A proposed or approved proposal cannot be edited.
5. A human uses the Admin review screen to approve. `approve` refuses non-user
   actors before reading the policy, checks the reviewed policy identity and
   its allowed vocabulary again, then atomically writes the immutable
   `campaign-version` and stamps the proposal approved. Approved is terminal.
   A subsequent campaign requires a new observation and proposal.

`draft` contains `title`, `mode`, `channel`, `providerRationale`, and these
JSON-encoded text fields: `audienceJson`, `exclusionsJson`, `contentPlanJson`,
`trackingPlanJson`, `risksJson`, `requiredApprovalsJson`. JSON sections must be
non-empty structured values with stated content; this is a completeness check,
not a claim that the strategy or its audience is correct. Lifecycle fields,
policy identity and approval evidence cannot be supplied through draft input.

## Guarantees and limits

All observation, insight, proposal and version fields are managed, with public
get/list only. Mutations use the existing action transaction, audit and trace.
A failed multi-record action rolls back its writes, audits and events while
retaining its failed action trace. Definition changes do not rewrite run
snapshots. The policy is versioned and fingerprinted using ADR-015 machinery.
`marketing-proposals@1` offers read-only proposal, version and insight evidence
to declared consumers; it grants no approval or write authority.

The human boundary is `actor.type === 'user'`. Development mode accepts an
asserted actor; a deployment needs the existing Production Spine identity and
membership configuration to establish who that user is. Approval is one human
decision, not enforcement of every named role in `requiredApprovalsJson`.
The package and policy source are trusted code, never a sandbox.

Evidence: `tests/marketing-e2e.test.js` drives real HTTP/SDK creation, refusal,
revision, approval, public write refusal, immutable snapshots, detach, fault
injection after each multi-record write and two-connection approval contention.
`tests/admin-marketing.test.js` covers DOM rendering with a fake document;
it does not replace a real-browser smoke. The network/import checks in
`tests/marketing-no-external-effect.test.js` guard this package's checked-in
source; no production provider, deployment or marketing effectiveness is proven.
