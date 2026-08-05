# Tasks

The first unchecked item is the default next task for Codex.

- [x] Introduce a declarative module manifest and generate SQLite migrations from it (`docs/MODULE_MANIFEST.md`, `agent-crm module:validate` / `module:migration`).
- [x] Generate an Admin form and table from module metadata (Milestone 4, `docs/ADMIN.md`).
- [x] Add code-first record actions with atomic execution, post-commit events and trace, proven by the Lead Qualification starter (Milestone 6, `docs/ACTIONS.md`, `examples/starters/b2b-lead-qualification/`).
- [ ] Add Activity and a first-class Task module with a general automatic follow-up workflow. Partially explored: the Lead starter ships a Task module and creates one follow-up inside the qualify action, but scheduling, reminders and a reusable task engine are not built.
- [ ] Add lead conversion (lead → Company/Contact/Opportunity) on top of record actions.
- [ ] Add a provider adapter example for MailUp-compatible list enrollment.
- [ ] Add tenant and role boundaries before exposing remote write tools.
- [ ] Add Streamable HTTP transport for MCP with authorization.
- [ ] Add PostgreSQL storage adapter behind the existing database contract.
