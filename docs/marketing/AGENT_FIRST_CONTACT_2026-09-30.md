# First contact: Grok Build and Muse Code (2026-09-30)

The site and `llms.txt` name Grok and Muse beside Claude Code, Codex and Gemini CLI.
This is the receipt for that sentence. It is a smoke, not a benchmark: one prompt,
one run per agent, no build attempted.

## Setup

- Project: `npm create accordo@0.1.0 smoke-crm --apply` in an empty scratch directory,
  then `git init`. The project ships `AGENTS.md` (42 lines) and no agent-specific file.
- Agents: Muse Code 1.4.1 (`muse exec`), Grok Build 1.0.44 (`grok -p`), headless,
  default permissions, run from the project root.
- Prompt, identical for both:

  > Without changing any file: what framework is this project built on, and what are
  > the exact first commands you would run, per this project instructions, before
  > adding a rule that quotes over 20% discount need sales-manager approval?
  > Answer in under 120 words.

## Result

Both identified the project as Accordo and gave the two commands `AGENTS.md` names,
in its order: `npm run crm -- app inspect --json`, then
`npm run crm -- project doctor --json`, with the `valid` → `problems[]` →
`limitations[]` reading order. Muse added that the approval must stay
human-required; Grok also found the `build-commercial-operations` skill.

One difference matters for onboarding: Muse printed
`rules file ... AGENTS.md exists, but the workspace is untrusted, so it is skipped`
and still reached the same answer by reading the file with its tools. In an
interactive session the user is asked to trust the workspace first.

## What this does not show

It does not show that either agent can build and verify a CRM change end to end,
and it is not the Successful Agent Build Rate, which has not been measured for any
agent.
