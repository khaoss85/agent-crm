# Site Forms

Website-form intake for one Accordo space (backlog:9d42035eca26).

A visitor fills the snippet pasted into the site. The pilot pre-checks the
request (`checkSiteForm`), opens a `site-form-submission` row — open gates
base anti-spam before anything is stored, so a refused request resolves
nobody — then resolves the sender through `customer-data`
(`resolveChannelSender`) and runs the row's `submit` action. The action
re-gates spam, logs an inbound `website-form` message on the contact's
conversation through `interactions/interaction-log@1`, and records the reply
channels: WhatsApp when the request carries a phone number, email when it
carries only an email address, both when it carries both.

## What it owns

- `site-form-submission` — one evidence row per request: bounded fields, the
  resolved subject, the message it became, the reply channels, the spam
  verdict. `pending -> accepted | rejected | needs-review` through `submit`
  only. The raw IP is never stored — only its hash.
- The base anti-spam rules (`src/rules.js`): honeypot, 1.5 s minimum dwell,
  at most 5 submissions per space and submitter hash per 60 seconds. No
  captcha, no scoring service, no third party.
- The paste-into-the-site snippet (`siteFormSnippet`): a dependency-free form
  posting JSON to the pilot's per-space route.

## What it needs

- `interactions` with `interaction-log@1` (declared in `requires`).
- The deployment's `resolveSecret` custody edge for the per-space IP-hash
  secret (like the channels package): without it the intake refuses
  instead of inventing custody.
- The pilot calls, in order: `checkSiteForm` (spam pre-check — stop when it
  refuses), `openSiteFormSubmission` (mandatory spam gate before anything is
  stored), `resolveChannelSender` (customer-data, only for a gated-clean
  request), then the `submit` action. A sender the resolution leaves
  `unresolved` stays `needs-review`: evidence for a human, never a message
  from nobody.
- The pilot passes the caller socket address as `ip` plus the per-space
  secret locator as `ipHashSecretRef` (never the value). A caller-supplied
  `ipHash` is refused, and the raw address is never stored — only its HMAC
  reaches the row. The trap is strict: only an empty trap passes.

## What it deliberately does not do

- No HTTP route (the pilot owns it and passes `spaceId` from the path).
- No sender resolution and no identity writes — `customer-data` owns them.
- No provider sends: the team answers from the card.
- No paid anti-spam.
