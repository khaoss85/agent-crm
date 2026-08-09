# Deployment

How `accordo.dev` gets served, what is already configured, and the two things a person has to
click. Nothing here has been executed — the site is built and configured, not deployed.

## What is configured

`vercel.json` at the repository root is the whole deployment. Vercel reads it, runs
`npm run site:build`, and serves `site/dist`. There is no framework to detect, no bundler and no
install step of consequence — the build is one dependency-free Node script.

The important property: **the site rebuilds from the claims ledger on every push.** A claim that
loses its evidence, or its limitation, fails `npm run gtm:check` in CI before it can reach a
visitor. The deploy is not a separate copy of the truth.

| Path | What it serves | Why it matters |
|---|---|---|
| `/` | the landing page | |
| `/evidence` | the full claims ledger, rewritten from `evidence.html` | the page that makes the rest believable |
| `/llms.txt` | the machine-readable summary, `text/plain`, CORS-open | **what an agent fetches mid-task to decide whether to recommend this** |
| `/llms-full.txt` | the expanded variant with the key documents inlined | |
| `/jobs.json` | 149 CRM jobs with status and evidence, `application/json`, CORS-open | a definitive machine answer to *"can this do X?"*, including 102 explicit no's |
| `/robots.txt` | generated from the repository's visibility | |

`Content-Type` and `Access-Control-Allow-Origin` on the three machine-readable files are not
incidental. A retrieval client that gets `application/octet-stream`, or a CORS refusal, silently
treats the fetch as a failure — which would quietly defeat the entire retrieval strategy while
the page looked fine to a human.

The Content-Security-Policy is `default-src 'none'` with styles and images only. The site ships
zero JavaScript, so the policy states that rather than leaving room for some.

## The two things a person must do

An agent cannot do either. The GoDaddy connector exposes domain *search* and nothing else — no
DNS record management — and the Vercel connector can deploy a project but cannot attach a custom
domain to one.

**1. Connect the repository to Vercel.** New Project → import `accordo` → it reads `vercel.json`
and needs no further configuration. From then on every push to the default branch redeploys.

**2. Add `accordo.dev` to the project.** Project → Settings → Domains → add `accordo.dev` and
`www.accordo.dev`. Vercel will show the records to create; at GoDaddy that is an `A` record on
the apex pointing at Vercel's address, and a `CNAME` on `www`. Alternatively move the
nameservers to Vercel and it manages both.

## Do not deploy to the domain before the repository is public

Not a preference — the page currently tells the truth about being in a holding state, and it does
so automatically:

- `site/brand.json` has `repository.status: "private"`, so the build emits
  `<meta name="robots" content="noindex, nofollow">`, a `Disallow: /` robots.txt, and a banner
  saying the source is not public yet.
- The primary call to action points at `/evidence` rather than at the repository, because a
  "read the source" button over a private repository is a 404 with a confident label on it.

All three flip together the moment `repository.status` becomes `"public"` and the site is
rebuilt. That is one edit, and it is the *only* edit — nothing about indexing or the call to
action is hand-maintained, which is the point.

Attaching the domain now is fine and useful: it reserves the address and proves the pipeline
while the site is explicitly noindexed. Announcing it is what waits.

## The launch sequence, in order

1. Rename the GitHub repository to `accordo`, then update `repository.value` in
   `site/brand.json` and the URLs in the plugin manifests.
2. Make the repository public.
3. Set `repository.status` to `"public"`, run `npm run gtm:check`, push. Indexing, the robots
   file, the banner and the call to action all change in that one commit.
4. Register the npm namespaces — `accordo`, `create-accordo`, `@accordo`. First-come and
   unrenameable.
5. Then, and only then, the listings in `PENDING_HUMAN_SUBMISSION.md`.

## Rebuilding locally

```bash
npm run site:build     # renders site/dist
npm run gtm:check      # every claim still has its evidence and its limitation
npm run site:shots     # social preview and page captures
```
