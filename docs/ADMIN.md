# Admin UI

The Admin is a zero-build, dependency-free static app (`apps/admin/public/`) served by the HTTP server at `/`. It has two parts: the handwritten CRM dashboard (opportunities, approvals, traces) and, since Milestone 4, an automatic experience for **generated modules**.

> Local development only. The Admin sends a declared actor identity for audit — it is **not** authentication and a local caller can set any actor. Do not expose the server publicly until authentication, tenancy and RBAC exist.

## From manifest to a managed record

```bash
# 1. describe the module
cat > examples/modules/partner.module.json   # name, fields…

# 2. generate and apply
npm run crm -- module plan   examples/modules/partner.module.json
npm run crm -- module create examples/modules/partner.module.json --apply

# 3. run the app and open the Admin
npm run dev            # http://localhost:4000
```

The module now appears under **Generated modules** in the Admin nav — no page code written. You can list records, create one, open it, and edit it.

## Routes (hash-based)

```text
#/                          dashboard (unchanged)
#/modules/:module           collection / list
#/modules/:module/new       create form
#/modules/:module/:id       detail / edit
```

## How it works

- **Discovery**: the nav is populated from `GET /api/schema` (`generatedModules`), gated on `generatedResourceContract === 1`. An unsupported future contract shows a clear "needs an update" note and leaves the rest of the Admin working. A schema-load failure never breaks the dashboard. Modules are sorted by name; nothing is hard-coded.
- **Rendering**: one generic, schema-driven renderer (`admin-modules.js`) builds every view with DOM APIs — `createElement` + `textContent`/`setAttribute`/`.value`. It **never** uses `innerHTML` with data, so hostile manifest or record strings (`<script>`, `${…}`, backticks) are inert text, never markup. Pure helpers (label derivation, control mapping, payload building, error mapping, contract gating) live in `admin-core.js` and are unit-tested.
- **Controls** are derived from field metadata: string/email/timestamp → text input; integer → number input (whole numbers only); boolean → checkbox (strict `true`/`false`); enum → select (options in manifest order). Required fields are marked; optional blanks are omitted from the payload; immutable `id`/`createdAt`/`updatedAt` are shown read-only and never editable; unique fields show a non-blocking hint.
- **Mutations** go through the same `/api/modules/:module/records` surface and the generated service, preserving validation, transaction, audit and events. Create/update each produce exactly one audit record and one domain event; failed validation/conflict produce neither; reads produce nothing.
- **Capabilities**: UI actions appear only for capabilities the module declares (`create`/`get`/`list`/`update`). Handwritten core modules (Company, Contact, Opportunity, Approval) keep their dedicated dashboard and are never shown through the generated-module screen.

## Customization seam

Default views are intended to be immediately useful, not final. `admin-modules.js` is small, readable vanilla JS you own; a future milestone can add per-module overrides without regenerating files. This milestone ships the generic default only (see ADR-009).

## Display conventions (documented, no manifest changes)

- Module and field labels are humanized from their identifiers (`companyName → "Company name"`, `company_name → "Company name"`, `URLValue → "URL value"`).
- Field and enum order follow schema/manifest order.
- A record's display title is its first required string field, falling back to `id`.

## Actor identity

Admin mutations send `x-actor-type: user`, `x-actor-id: admin-ui`. In this framework the human identity is actor type **`user`** (the approval workflow requires `actor.type === 'user'`); there is no separate `human` type. This identity is for audit only — not authentication.

## Testing and the browser gap

- **Unit** (`tests/admin-core.test.js`): label derivation, control mapping, payload/error mapping, contract gating, filtering.
- **Integration** (`tests/admin-modules.test.js`): the real view code against a real `node:http` server and real `fetch`, using a small dependency-free fake `document` (`tests/helpers/fake-dom.js`). Covers list columns, create/edit with audit+events, validation/conflict/404 handling, XSS-as-text, Supplier isolation, and unsupported-contract handling.
- **Real-browser status**: automated Chromium testing is deliberately **not** wired into `npm run verify` — Playwright is not a project/CI dependency and CI has no browser, so adding it would make CI fail (and the repo's zero-dependency stance). The DOM-level integration tests are the automated proof that runs in CI. Separately, the flow **was validated once in real Chromium** during the Milestone 4 adversarial review (16 checks: nav ordering, list, create controls, required error, create + navigation, hostile value rendered as literal text with no injected element or dialog, edit, immutable id, direct-hash navigation + refresh, malformed-hash safety). That was a manual, out-of-CI run; re-run `docs/ADMIN_SMOKE.md` before a release that touches the Admin. The milestone is **not** labelled "browser-tested in CI".

## Reference fields (Milestone 5)

A `reference` field renders as an accessible target selector: options are loaded via the target module's `list` (safe limit 100) and labelled by its display field; the submitted value is the target id. Required references have a non-selectable placeholder; optional ones a "None" option (submits `null`). On edit the current target is preselected, and if it is not on the first page it is fetched by id so the value is never silently lost. List/detail views show the resolved label (deduplicated per distinct target, one fetch per id, raw-id fallback). Labels render as text. Large target sets will need a searchable control in a later milestone.

## Record actions (Milestone 6)

When a generated module declares actions (`generatedModules[].actions`), the record detail renders an **Actions** panel below the edit form, built entirely from that metadata — there is no per-module page and the customization seam above is untouched.

- One button per action whose `fromStates` includes the record's current state (read from the action's `stateField`, default `status`). When none applies, the panel says so rather than showing dead buttons.
- An action that declares `input` reveals a small form built from its input schema — text for `string`, a `select` for `enum`, and text with an ISO-8601 hint for `timestamp`. Required fields are checked client-side for a fast message; the server stays authoritative.
- Submitting posts to the action route and, on success, re-renders the detail, so the new state and the newly valid actions appear together. Failures restore the button and show the server's message, mapped to the offending field when the error names one (a `409 INVALID_STATE` shows as a panel-level message).
- Fields marked `writable: "managed"` are **not** rendered as editable inputs — the edit form omits them — and are shown read-only in the Actions panel instead. The enforcement itself is at the service boundary, not here (see `docs/ACTIONS.md`).
- Every label, description, value and error is inserted with `textContent`, never `innerHTML`, so hostile action metadata is inert text like all other schema-derived content.
