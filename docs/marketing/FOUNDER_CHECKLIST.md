# Founder checklist

Everything an agent cannot do, in the order that matters, with the exact commands and clicks.
Nothing here is blocked on more engineering.

Rule of thumb for the ordering: **irreversible-and-cheap first** (namespaces), then
**unblocking** (repository, domain), then **judgement** (trademark, launch).

---

## 1. Reserve the npm namespaces — today

The most urgent item on this page, because it is first-come and unrenameable. `accordo`,
`create-accordo` and `@accordo` were all free on 2026-08-07 (verified against the registry, not
assumed). Every day they stay unclaimed is a day someone else can take the front door of the
whole distribution strategy.

One thing to know, because it changes what you do: **npm has no "reserve" button.**

- **The `@accordo` scope** is reserved by creating an organisation. Free, immediate, no publish
  required. → https://www.npmjs.com/org/create → name it `accordo`.
- **The unscoped names** `accordo` and `create-accordo` are only held by *publishing* a package.
  There is no other mechanism.

```bash
npm login
# then, from a scratch directory, a minimal placeholder for each unscoped name:
#   package.json → { "name": "create-accordo", "version": "0.0.0", "license": "MIT",
#                    "description": "Placeholder. The create command is not implemented yet." }
npm publish --access public
```

Publish a placeholder that says it is one. A `0.0.0` whose description reads "placeholder, not
implemented" is honest; a `1.0.0` that installs nothing is not, and this project cannot afford
that particular kind of small lie.

If you would rather not publish placeholders, create the org (which reserves the scope) and accept
the risk on the two unscoped names. Say which you chose and I will make the manifests match.

---

## 2. GitHub — rename, then open

```
Settings → General → Repository name → accordo
Settings → General → Danger Zone → Change visibility → Public
```

Then tell me, and I make it real in the repository in one commit: `repository.value` and
`repository.status` in `site/brand.json`, plus the URLs in the four plugin manifests and
`server.json`. That single edit also flips the site from `noindex` to `index`, turns the
`Disallow: /` robots file into `Allow: /`, removes the "source not public yet" banner, and points
the primary call to action back at the repository. All four are derived, not hand-maintained.

While you are there:

- **Description and topics** — copy them from `docs/marketing/GITHUB_LISTING.md`. Topics matter
  more than they look: they are how the repository is found by people already searching for agent
  tooling.
- **Social preview** — `Settings → General → Social preview`, upload
  `site/dist/shots/social-preview.png` (run `npm run site:shots` to regenerate it).
- **Enable Issues and Discussions.** Not Wikis — documentation lives in the repository and must
  move with the code.

---

## 3. Vercel — connect the repository, attach the domain

```
New Project → Import accordo → Deploy
```

It reads `vercel.json` at the root and needs no further configuration. From then on every push
redeploys.

```
Project → Settings → Domains → add accordo.dev   (and www.accordo.dev)
```

Vercel will show the DNS records to create. At GoDaddy, `Manage DNS` on `accordo.dev`:

| Type | Name | Value |
|---|---|---|
| A | `@` | the address Vercel shows |
| CNAME | `www` | the target Vercel shows |

Or move the nameservers to Vercel and let it manage both — fewer moving parts, and one place to
look when something is wrong.

**Attaching the domain now is fine.** The site is explicitly noindexed and says it is pre-launch,
so this reserves the address and proves the pipeline. It is *announcing* it that waits for step 2.

---

## 4. Trademark screen — before anything is published

EUIPO and USPTO, classes 9 and 42. This is the only remaining step that can still force a second
rename, which is why it should not wait for a quiet week.

What to have the search cover: `Accordo` as a word mark in software and SaaS. The two known
adjacent facts, so your lawyer does not have to rediscover them: an "Accordo Group" IT
asset-management consultancy existed and was acquired some years ago, and a music application may
use the name. Neither looked disqualifying from here, and neither is a legal opinion.

If it comes back badly: `node scripts/brand-set.js <newname> --apply`. The rename is one command
now — 389 occurrences, 139 files, 411 tests still green. That was the point of building it.

---

## 5. Social handles — same day as the name

X, LinkedIn, Bluesky, GitHub org. Cheap, and the same first-come logic as npm. You do not have to
use them; you have to not lose them.

---

## 6. Then, and only then — the submissions

Everything in `docs/marketing/PENDING_HUMAN_SUBMISSION.md` is prepared and validated. In order of
what they cost you:

| Where | Effort | Needs |
|---|---|---|
| skills.sh / `npx skills add` | **nothing** — it already reads `skills/` | repository public |
| Self-hosted Claude + Codex marketplaces | nothing — `/plugin marketplace add <owner>/accordo` | repository public |
| Anthropic community marketplace | one Console form | repository public |
| MCP registry | `mcp-publisher` | a published npm package |
| Show HN | posting it | a reason to post — see the strategy recap |
| Product Hunt | posting it, **once** | a benchmark result |

---

## The two decisions still open

| # | Decision | Note |
|---|---|---|
| 4 | **Telemetry policy** | No collection code should ship before the policy exists. Nothing else is blocked on it |
| 5 | **The launch claim, its timing, and the benchmark pre-commitment** | The pre-commitment — that the benchmark number gets published whatever it says — is yours to make. An agent must not make it on your behalf, and it is worth more made *before* the run than after |

---

## What I do, so you know where the line is

I build, verify, prepare and document. I do not submit, publish, register, buy, or commit us to
anything in public. If a future session offers to be helpful about one of those, the answer is no
— that rule is written into `PENDING_HUMAN_SUBMISSION.md` for exactly that reason.
