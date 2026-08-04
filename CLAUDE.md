# Claude Code guidance

Read `AGENTS.md` first and follow it as the canonical repository guidance.

Before substantial work, also read `PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md` and the relevant skill under `.claude/skills/`.

Non-negotiable rules:

- All CRM mutations go through module services or named workflows.
- Preserve validation, actor identity, audit and trace.
- Keep commercial policy deterministic; AI may recommend but cannot silently override approval rules.
- Code-generating or destructive MCP actions must remain explicit and safe by default.
- Use an ExecPlan for multi-file work and finish with `npm run verify`.
