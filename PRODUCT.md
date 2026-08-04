# Product

## One sentence

Agent CRM is a framework that lets a user describe a commercial process to Codex or Claude Code and have the agent safely build, run, inspect and improve a CRM application.

## Primary job

> When I need a CRM process that is specific to my business, I want to describe the outcome in natural language, so the coding agent can implement and operate it without rebuilding CRM foundations each time.

## Target users

1. Product and revenue leaders who know the process but do not want to specify every technical detail.
2. Developers using Codex or Claude Code to deliver CRM customizations quickly.
3. SaaS teams embedding CRM capabilities into their own product.

## Product boundary

Agent CRM is not an autonomous salesperson and is not a full Salesforce replacement in milestone 0.

It provides:

- reusable CRM primitives;
- deterministic actions and workflows;
- extension points for providers and modules;
- agent-readable project context;
- CLI/MCP operations;
- trace, audit and human approval.

## Success criterion for milestone 0

A coding agent can understand the repository and safely implement a new CRM module or workflow while preserving tests, trace and audit.
