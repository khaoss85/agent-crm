# Jobs to be done

## The common interaction model

```text
“I need this commercial outcome”
              ↓
       Codex / Claude Code
              ↓
AGENTS.md + Skills + MCP + CLI
              ↓
  Agent CRM infrastructure
```

## Medusa-style use cases translated to CRM

| Ecommerce use case | CRM use case | Request to the coding agent | Framework outcome |
|---|---|---|---|
| Custom commerce module | Custom CRM object | “Add a Partner module with tier and territory.” | Module, schema, service, API, Admin and tests |
| Storefront redesign | Sales workspace redesign | “Show renewals at risk first and simplify the account page.” | Updated Admin UI backed by existing APIs |
| Discount rule | Commercial approval rule | “Discounts above 15% require VP approval.” | Explicit workflow policy, approval and audit |
| Checkout funnel analysis | Lead-to-won funnel analysis | “Find where enterprise deals stall.” | Agent reads CRM data and traces, then proposes or implements instrumentation |
| Abandoned-cart nurturing | Stalled-deal follow-up | “After seven inactive days create a task and draft an email.” | Delayed workflow through Task and Email providers |
| Deploy/debug via CLI | Operate CRM via CLI | “The sync failed; inspect the trace, fix it and verify.” | CLI/MCP exposes logs, runs and diagnostics to the coding agent |

## Principal JTBD

> When my commercial process differs from standard CRM behavior, I want to describe the result rather than the implementation, so a coding agent can safely build and operate the customization on reusable CRM infrastructure.
