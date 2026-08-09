---
name: Bug
about: Something behaves differently from what the tests and docs say
title: ''
labels: ['bug']
---

**What happened**

**What you expected**

**Reproduction**

```bash
# The smallest sequence that shows it. A failing test is ideal.
```

**Environment**

- Node version: <!-- node -v ; the framework requires 22.16+ -->
- Commit: <!-- git rev-parse --short HEAD -->
- Output of `npm run crm -- app inspect --json | head -40`:

```json

```

**Trace**

<!--
Most CRM behaviour here leaves a workflow run with step-level trace and audit events.
`npm run crm -- trace <runId>` or the MCP `crm_get_trace` tool usually shows exactly
which step diverged. Paste it if the bug involves a workflow or an action.
-->
