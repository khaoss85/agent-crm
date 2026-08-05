# Architecture

## Core rule

> CRM state is deterministic. AI agents interpret the user's intent and compose the system, but state changes pass through services and workflows.

## Medusa-inspired mapping

| Medusa concept | Agent CRM equivalent |
|---|---|
| Commerce module | CRM domain module |
| Product/customer/order | Offer/company/opportunity or contract |
| Workflow | Commercial process |
| Provider | Email, calendar, ERP or enrichment adapter |
| Admin extension | CRM workspace extension |
| Cloud CLI | Serve, migrate, inspect, trace and deploy commands |
| Docs MCP | Project schema, workflow and operational context |
| Agent skills | Repeatable module/workflow implementation instructions |

## Layers

```text
Admin / API / SDK
        ↓
Workflows and policies
        ↓
CRM module services
        ↓
SQLite adapter

MCP + CLI sit beside the application and invoke the same public layer.
Trace + audit observe every controlled mutation.
```

## Modules

A module owns one domain boundary. It exposes a service and metadata. Other modules do not update its tables directly.

Current modules:

- Company
- Contact
- Opportunity
- Approval

## Workflows

A workflow is a named sequence of traced steps. It coordinates modules and providers. A step can optionally define compensation for reversible side effects.

Current workflows:

- `request-opportunity-stage-change`
- `decide-opportunity-approval`

## Actions

A record action is a lifecycle operation on a single record that is more than a field edit — qualify a lead, close an opportunity. Actions are code-first definitions (`packages/actions/generated/index.js`) exposed through one generic route, SDK method and Admin control rendered from metadata, never per-action generated files and never a declarative DSL.

The action runtime wraps `execute` in the guarantees a hand-rolled service method would not have: all business writes in one outer transaction (generated-service savepoints nest inside it), domain events held in a transaction-scoped outbox and dispatched only after commit, and a workflow trace written after the transaction resolves so a failed action still leaves a record. Fields a workflow owns are declared `writable: "managed"` in the manifest and refused by generic CRUD, so lifecycle state is enforced at the service boundary rather than in the UI.

Use an action for a single-record lifecycle step; use a workflow for a multi-record or multi-step process, or when a human approval gate is involved. See `docs/ACTIONS.md`, ADR-011 and ADR-012.

## Providers

Providers isolate external systems from business logic. The proof of concept includes a notification provider contract and an in-memory implementation. Email, calendar, ERP and marketing providers belong here later.

## MCP responsibilities

MCP exposes:

- project and CRM context as resources;
- controlled application operations as tools;
- reusable build/debug prompts.

It does not bypass services or workflows.

## Extension rule

A new business feature should normally add or change only:

1. one module;
2. one workflow;
3. one API or MCP surface;
4. tests;
5. docs/decision record when architecture changes.
