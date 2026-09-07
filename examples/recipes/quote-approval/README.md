# Run a B2B quote approval workflow

A synthetic customer asks for 25% off a 30-seat proposal. This recipe creates a
local CRM project, prices the proposal, verifies that an agent cannot approve
it, then records a simulated user decision and its audit receipt.

This is a deterministic SDK/HTTP replay, not a coding-agent build session.
The [client brief](../../../site/assets/recipes/quote-approval-brief.md) describes
the inputs and acceptance checks; the script implements them with existing
commercial primitives. No real data or provider credentials are needed.

## Run from an empty directory

Requires Git, Node.js 22.16 or newer, npm and internet access for the checkout
and dependency installation. The business journey uses only localhost and a
fixture catalog. The script installs the generated project's dependencies and updates its
empty-composition test to require the commercial package.

```sh
git clone https://github.com/khaoss85/agent-crm.git framework-source
cd framework-source
git rev-parse HEAD
node --no-warnings examples/recipes/quote-approval/run.mjs ../my-quote-crm
```

Run this from the source checkout containing the recipe; it does not use the
published npm scaffolder. The receipt records the checkout commit and recipe
hash. Use that commit with `git checkout <commit>` to reproduce a saved run.
The source baseline used to develop this recipe was `3b51b97`.

Choose a new project directory for each replay. An existing nonempty directory
is refused; a failed run stays available for diagnosis and is not silently
reused or deleted. An assertion failure exits nonzero rather than printing PASS.

## Read the result

```sh
cd ../my-quote-crm
cat data/quote-approval-receipt.json
npm run verify
npm run crm -- app inspect --json
```

The receipt contains separate one-time/monthly amounts, the agent refusal,
failed and successful traces, frozen quote version, approval decision and user
audit record. The SQLite database remains at `data/accordo.sqlite`.
`app inspect` reads the composition; the recipe assertions check this journey.

The fixture gives EUR 3,750 once and EUR 2,400 per month after the discount.
These are sample quote amounts, not Accordo pricing. The script prints each
checked transition. It uses the same policy and catalog as the existing
[B2B starter](../../starters/b2b-lead-qualification/commercial.js).

## What to change next

Read `examples/quote-approval/commercial.js` inside the generated project to see
the catalog and the versioned threshold. Describe your own customer process
using the brief and ask your coding agent for a reviewed change. This recipe
has not measured whether an agent can complete that adaptation.

The example simulates both actors. Local actor headers are assertions, not
verified identities; the `sales-manager` approval key is a label, not a login
role. This is not a hosted CRM, production deployment, vendor integration or
benchmark result. No email, signature, billing or customer notification is sent.
