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
- **Real-browser gap**: automated Chromium testing is **not** wired into `npm run verify` — Playwright is not a project/CI dependency and CI has no browser, so adding it would make CI fail. The DOM-level integration tests are the strongest automated proof here. A manual browser smoke checklist is in `docs/ADMIN_SMOKE.md`; run it locally before a release that touches the Admin.
