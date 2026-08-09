# GitHub listing pack

Everything the repository's public surface needs, written out so applying it is mechanical.
GitHub is the slow-burn discovery channel: its README and description feed both task-time
retrieval and, eventually, training corpora. Treat every field here as copy a model will
paraphrase back to a user.

> **Gate.** Applying any of this mutates a public surface and requires the name and visibility
> decisions in `PENDING_HUMAN_SUBMISSION.md`. Prepared, not applied.

## About panel

**Description** (GitHub truncates around 350 characters; this is 219, which survives being
quoted in full):

> The open-source framework coding agents use to build custom CRMs. Describe your commercial
> process to Claude Code or Codex; get a working CRM as reviewable code you own — deterministic
> workflows, human approvals, audit and trace built in.

**Website**: the landing page URL once a domain exists. Until then, leave empty rather than
pointing at a placeholder.

**Topics** — ordered by how likely each is to be the term someone actually searches:

```
crm
framework
ai-agents
mcp
model-context-protocol
claude-code
codex
agents-md
code-generation
workflow-engine
audit-trail
nodejs
typescript
open-source-crm
sales-automation
```

Rationale: the first six are how this is found by people already looking for agent tooling;
`agents-md`, `code-generation` and `workflow-engine` are how it is found by people looking for
the mechanism; `open-source-crm` and `sales-automation` are the category terms that have real
query volume even though they describe us imprecisely. Fifteen is under GitHub's twenty-topic
cap, which leaves room to add terms that prove themselves.

**Social preview**: `site/dist/shots/social-preview.png`, regenerated with `npm run site:shots`.
Upload under Settings → General → Social preview. It is 2560×1280, twice GitHub's rendered
1280×640, so the type stays sharp.

**Settings to enable**: Issues, Discussions. **Not** Wikis (documentation lives in the
repository and must move with the code), **not** Projects until there is a public roadmap board
someone maintains.

## Repository files that carry weight

| File | Purpose | State |
|---|---|---|
| `README.md` | First screen answers what, for whom, and with what proof — then the limits | ✅ |
| `SECURITY.md` | States the posture rather than implying one; scopes reports usefully | ✅ |
| `.github/ISSUE_TEMPLATE/claim-not-supported.md` | Invites the most useful issue anyone can file against a project positioned on traceable claims | ✅ |
| `.github/pull_request_template.md` | The quality gates as a checklist, with an evidence table | ✅ |
| `LICENSE` | MIT, pending confirmation | ✅ |
| `CONTRIBUTING.md` | How to propose a change, and what a reviewable one looks like here | ⏳ |
| `CODE_OF_CONDUCT.md` | Table stakes for a public repository | ⏳ |
| `CITATION.cff` | Once the benchmark is published and citable | ⏳ |

## Discussions layout

Start with categories that produce content, not noise:

- **Show and tell** — what people built. The source of future case studies.
- **Q&A** — answered questions become recipes; a recurring one is a documentation bug.
- **RFC** — manifest and contract changes. The audience that cares about determinism will want
  a say; let them have it early.
- **Benchmark** — protocol disputes and reproduction attempts. Somebody arguing with the
  methodology in public is the best thing that can happen to a benchmark.

No Discord (`GO_TO_MARKET.md` §9.11). Reconsider at two consecutive months of twenty or more
substantive Discussions threads *and* a named human on call within 24 hours.

## Releases

Fourteen milestones of history exist in `DECISIONS.md` and none of it is visible as a release.
On the day the repository goes public, that history should be legible: draft release notes from
the ADR log, one per milestone, each stating what became possible and what remained impossible.

A release note that only lists what was added, in a project whose positioning is honesty about
what is missing, is a wasted surface.

## What not to do

- **Do not measure or celebrate stars.** `COMPETITOR_MAP.md` documents this category's counts
  as marketing-inflected. Measure forks, clones and unique cloners.
- **Do not add badges that assert things no one measured** — coverage, "production ready",
  download counts that are zero. A CI badge and a licence badge are enough.
- **Do not pin a "star us" issue.** It reads as what it is.
- **Do not enable Sponsors before there is a maintenance commitment** worth funding.
