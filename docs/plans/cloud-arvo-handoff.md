# Cloud C0–C3 and the Arvo pilot — executable handoff

Written at the close of the public-production-operations campaign, for the
campaign that executes Cloud. Nothing here is implemented. Everything here is
either a fact checked against a working tree, or a decision named as a human's.

**Read the scope line first.** The six public production-operations slices are
complete and measured, and the handoff below is ready to be executed *by a
campaign that has the private repository*. That is the whole of the claim. It
may not be read as "Production Spine complete" or "Cloud unblocked": the v4
remainder also names remote-safe MCP (Streamable HTTP with authorization),
which is open; shared-database tenancy stays deliberately deferred; and the
identity verifier is by design supplied by the deployment. Because *"done"
means the whole phase, not v1*, finishing v3 and v4 does not open the Cloud
gate by itself.

## 0. The human action that was blocking, and is now taken

**Closed.** `khaoss85/accordo-platform` now exists, private, created on the
repository owner's explicit authorisation at the close of this campaign. It is
empty: a README stating the boundary and pointing back at this document, and
nothing else. C0 has not started.

The rule that produced the block has not changed and should not be read as
relaxed: no agent creates a repository on its own initiative. What changed is
that a person decided, which is exactly what the block was there to require.

**What this does not unblock.** C0 was gated on the repository *and* on
everything else in this document. Access grants, branch protection and the
migration sequence in `docs/editions/PRIVATE_REPOSITORY_MIGRATION.md` are still
human steps, and the Arvo pilot's own precondition — whether the B2B layer is
real enough to pilot against, §3 Correction 3 — is still unanswered.

## 1. What this campaign made representable, and what it did not

| Item | Status after this campaign |
|---|---|
| Durable job store, transactional outbox, scheduled timers | merged, composable, application-started |
| Secret provider, backup/verify/restore, telemetry export | merged as bounded self-host contracts |
| One application composing all six | merged; construction starts nothing |
| Bounded operational posture | available from the composed handle's `status()` |
| Cloud C3 fields "job and outbox state" | **representable**, not implemented |
| Managed jobs service, operator console, autostart | absent, and deliberately so |

Three Deployment Receipt fields of the twenty-three become answerable:
**worker/job posture**, **traces reference or command**, and **backup posture
and last verified receipt**. No document specifies their schema — they are
field names, not a contract. The composed handle's `status()` is the natural
source for the first, and this handoff says so without inventing the schema.

## 2. Roadmap continuity

**Dependency-only** — unblocked as a prerequisite, not delivered, and not
promoted: M12 renewal scheduling; M15 renewal/upsell signal and SLA timers;
MK4 Durable Journey Orchestration, whose outbox dependency is met and which is
**still blocked on MK2 Data Governance**; the Integration Runtime, whose
"jobs/outbox then secret management" chain is satisfied at self-host level and
which still gates on every real provider adapter, of which none exists.

Nothing above moves a coverage row. Coverage stays **five evidence-backed
`partially supported` rows out of 600**. Building a connector, prompt or agent
does not promote neighbouring JTBDs, and no infrastructure milestone promotes
business JTBD coverage by itself.

**Deferred to Cloud/Arvo, with why each is still blocked:** AW2 durable
outreach needs Interactions, which does not exist; AW1 supervised prospecting
was never gated on Spine v3 and needs authorised sources and adversarial
prompt-injection fixtures; AW3 needs a Marketing runtime and customer-success
primitives, both absent; AW4 needs provider identity, consent, budget controls
and a kill-switch; the Arvo managed pilot needs C0–C3, an adapter, Interactions,
Customer Data Operations v2, package install/update/remove, a deployment
authentication verifier and the health/coaching data boundary — which is Data
Governance, not infrastructure.

**Must not claim, before and after:** the framework authenticates nobody; actor
headers are not authentication; the general "production ready" claim stays
withheld; managed secret custody, managed backup custody/scheduling/retention
and an observability backend remain absent; telemetry stays off by default, and
v4C is off in the strong sense that without a composed sink nothing is
allocated.

**Two pre-existing inconsistencies — inherit neither.** `OWNERSHIP.md` says
"Managed Cloud C0-C6" while every other document says C0–C3, and no document
reconciles them; this handoff uses C0–C3 and names the discrepancy. AX2 is
`implemented` in `CODING_AGENT_DX_NORTH_STAR.md` and in PROJECT_STATUS's merged
list, `not implemented` in `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md` §7, and still
an open item in `TASKS.md`; any citation of AX2 must say which surface it cites.

## 3. The Arvo boundary — a live audit, and four corrections to the dossier

Read-only audit of `khaoss85/arvo` at `edbd14fa`. Nothing was modified.

**Source caveat that bounds everything below.** Not Prisma — Postgres/Supabase,
415 migrations plus generated types. **The B2B tables' migrations are empty
placeholders** ("Migration already applied to production database … DO NOT
MODIFY"), so RLS policies and FK constraints on exactly the B2B tables are not
verifiable from source. Absence of evidence there is not evidence of absence.

**Correction 1 — the support chat is the coaching assistant, not customer
support.** The support agent's own tools include `report_physical_issue`,
`get_body_progress`, `get_check_analyses`, `get_caloric_history` and
`get_coach_notes`. So `support_messages.content` must be presumed
health-saturated, and `support_conversations.title` is model-generated from it,
so the "metadata" title is contaminated too. Genuinely separable: only
`id / user_id / created_at / updated_at / message_count / archived_at /
pinned_at`, plus `support_message_quality` metrics. **Traps:**
`support_message_analytics.question_text` holds the user's question verbatim in
a table whose name reads as analytics, and `conversation_decision_audit.evidence_collected`
holds health payload inside an audit table.

**Correction 2 — `gym_id` names three different things.** The B2B tenant
(`gyms.id`, `gym_members.gym_id`); `gym_profiles`, which is one user's
*equipment* profile and is training data; and `gym_crews`, a social feature. An
adapter joining on "gym_id" without knowing which one walks into training
context. `from('gym_profiles')` appears 16 times in app code; `from('gyms')`
appears once.

**Correction 3 — the B2B layer is largely dormant.** Zero occurrences of
`from('gym_members')`, `from('gym_staff')` or `from('gym_branding')`. Exactly
one read of `from('gyms')`. The tenant schema exists; the functionality appears
mostly unbuilt. **The pilot's target entity may be a shell, and that is a
question for a human before any adapter is scoped.**

**Correction 4 — there is no single subscription table.** Entitlement truth
lives in three places and the one actually read is the consumer one,
`user_profiles`, written by both the Stripe and RevenueCat webhooks. A
projection reading `stripe_subscriptions` alone will disagree with the app.

**Where the two boundaries touch.** `user_profiles` is simultaneously the
commercial record and the health record: `subscription_status`, `tier` and
`email_frequency` sit in the same row as `injuries`, `injuries_notes`,
`body_fat_percentage` and `training_maxes`. There is no separate person-level
commercial account table, so **every projection must be an explicit column
allow-list, never a row and never a `SELECT *`**. Related: `stripe_payments`
carries `booking_id`, which reaches `bookings.client_notes` — a payment is a
door into session content, and no join may pass through it.

**Reconciliation hazards.** `reset_user_data` is an in-app reset, not a
deletion: it recreates the bootstrap rows with the same `user_id`, so the
person's identity survives while every child id disappears and reappears new —
an incremental projection keyed on child ids sees mass deletion without an
account deletion. Account deletion is a hard delete with no tombstone and
removes billing history before identity, so nothing remains to reconcile from:
the pilot must treat disappearance as terminal and must not attempt to rebuild.

**Consent has four independent tracks** (global email flags, per-category
`product_updates_enabled`, AI/research consent, and a separate pre-signup
`marketing_leads` track), so a converted lead has two independent consent
states. **Which of these authorises an outbound commercial contact is a
human/legal decision, not an engineering one.** Legal basis, consent validity
and GDPR/ePrivacy interpretation stay human decisions throughout: the pilot
records the chosen policy and its evidence; it does not decide the law.

## 4. Three pilot scenarios, with acceptance criteria

Each states its source, idempotency key, timer expectation, approval boundary,
audit trace and rollback. The approval boundaries are not invented — they are
what the Accordo packages already enforce.

**A. Lead or trial → Company/Contact → qualification.** Source: `gyms`, never
`user_profiles`. Idempotency key: `gyms.id`, because `slug` and `invite_code`
are unique but mutable-looking; there is **no tax id anywhere in Arvo**, so a
Company reconciled across systems by name would be wrong. No timer. The
qualification decision stays a human action — Work refuses every closing action
to a non-human actor. **Gated on Correction 3.**

**B. Subscription or trial → durable renewal review.** *This is the scenario
v3C's timer consumers exist for.* Source: `gyms.trial_ends_at` and
`subscription_status`, or the consumer columns as an explicit allow-list. A
human schedules the review for the notice instant; a worker the application
starts explicitly presents it there and marks it due — it reaches no domain seam
and decides nothing. The renewal decision stays the human action `lifecycle`
owns; the timer may never write `pursue_renewal` or `not_renewing`. Hazard from
the audit: entitlement disagreement across the three sources — read the consumer
column, or read all three and refuse on disagreement; do not average them.

**C. Support engagement → human decision + evidence.** The scenario the audit
changed most. Only counts and quality metrics cross; never what anyone asked.
No content crosses, so no automated triage on content is possible **by
construction — which is the correct outcome, not a limitation to work around**.
Note that `reset_user_data` archives conversations rather than deleting them,
so a projection must treat `archived_at` as a terminal state, not as absence.

## 5. What a future campaign must satisfy regardless of scenario

1. Projection is an explicit column allow-list. `user_profiles` and
   `gym_members` are mixed tables, and `gym_members.internal_notes` is a
   commercial-sounding free-text field.
2. No join may pass through `bookings`.
3. `gym_id` must be disambiguated at every use.
4. `reset_user_data` breaks naive incremental projection.
5. Account deletion leaves nothing to reconcile from.
6. Which consent track authorises outbound contact is a human decision.
7. The pilot is outbound-only: no write path back into Arvo.

## 6. Facts reported without recommendation

No encryption call was found around `user_integrations.access_token`, and the
RPC `get_user_integration_tools` returns it directly; the GDPR export
deliberately excludes those columns. The unsubscribe token is
`base64url(userId).HMAC-SHA256` truncated to 16 characters, with a fallback
secret when the service-role key is unset. Roughly 30% of API routes (144 of
473) use the service-role client, so their scoping is by code convention rather
than enforced by the database.

These are reported because an auditor found them and a reader of this handoff
should know them. They are Arvo's to weigh, and **no Arvo production code was
read for modification or modified**.
