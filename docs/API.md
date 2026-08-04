# API overview

Base URL: `http://localhost:4000`

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Runtime and module health |
| GET | `/api/schema` | Agent-readable CRM schema |
| GET/POST | `/api/companies` | List/create companies |
| GET/POST | `/api/contacts` | List/create contacts |
| GET/POST | `/api/opportunities` | List/create opportunities |
| POST | `/api/opportunities/:id/stage` | Run the stage-change workflow |
| GET | `/api/approvals` | List approval requests |
| POST | `/api/approvals/:id/approve` | Approve through workflow |
| POST | `/api/approvals/:id/reject` | Reject through workflow |
| GET | `/api/traces` | List workflow runs |
| GET | `/api/traces/:id` | Run with step spans |
| GET | `/api/audit` | List audit events |
| POST | `/api/demo/seed` | Seed the demonstration data |
