# Gemini CLI guidance

Read `AGENTS.md` first and follow it as the canonical repository guidance. It is
the same guidance Claude Code and Codex receive; this file exists because Gemini
CLI loads `GEMINI.md`, not `AGENTS.md`.

Before substantial work, also read `PRODUCT.md`, `ARCHITECTURE.md`,
`DECISIONS.md`, and — for the current state of what is built versus designed —
`docs/PROJECT_STATUS.md`.

Non-negotiable rules:

- All CRM mutations go through module services or named workflows.
- Preserve validation, actor identity, audit and trace.
- Keep commercial policy deterministic; AI may recommend but cannot silently override approval rules.
- Code-generating or destructive MCP actions must remain explicit and safe by default.
- Use an ExecPlan for multi-file work and finish with `npm run verify`.

The repository's task playbooks live in `.claude/skills/` as `SKILL.md` files —
they are plain Markdown and apply to any agent. Read the one that matches the
task before starting: `solve-business-goal` for a stated business objective,
`create-crm-module` for a new object, `create-crm-workflow` for a lifecycle
step, the `build-*` skills for a named milestone, `debug-crm-run` for a failed
run, and `adversarial-review` before a merge.

The MCP server for a project is configured in `.mcp.json`; Gemini CLI reads MCP
servers from its own settings, so point it at
`node --no-warnings packages/mcp/bin/server.js` with `CRM_DB_PATH` set to the
project's SQLite file.
