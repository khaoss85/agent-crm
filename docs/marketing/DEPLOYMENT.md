# Public-site deployment

`vercel.json` builds the dependency-free static site with `npm run site:check` and serves `site/dist`. The same build regenerates HTML, strategic Markdown, retrieval JSON, llms assets, sitemap, robots and `/version.json`; generated output is never edited or deployed separately.

## Freshness contract

`/version.json` uses `provenanceContract: 2` and publishes:

- `commit`: derived from `git rev-parse HEAD` in the checkout, never trusted from an inherited deployment variable;
- `branch`: Vercel branch metadata when present, otherwise `local`;
- `measuredAgainst`: the commit whose suite measurement is recorded in `site/claims.json`;
- `generatedAt` and `generation`: deterministic generation metadata, explicitly not benchmark evidence;
- repository and product identity.

A copied test fixture has no Git metadata. Only `NODE_ENV=test` may inject a full SHA through `ACCORDO_SITE_TEST_CHECKOUT_SHA`; production and local builds refuse that escape hatch. `site:check` validates the contract, SHA shape and claims-measurement relationship.

## Machine content and caching

`llms.txt`, `llms-full.txt`, JSON contracts, Markdown peers and `/version.json` are CORS-readable with explicit content types. Strategic HTML is canonical and advertises its generated Markdown peer. The Content Security Policy permits static styles/images and same-origin scripts and connections for public-site Web Analytics. Inline executable scripts remain blocked; navigation and content work without JavaScript. The referrer policy is `no-referrer` so outgoing requests do not carry the current page query.

## Production verification

Vercel project settings, production branch and the `accordo.dev` alias are account state. After the canonical PR merges, the release owner or an explicitly authorized agent must:

1. confirm the production branch is `main` and the alias targets its latest successful deployment;
2. fetch `https://accordo.dev/version.json`;
3. compare `commit` with merged `main` and `measuredAgainst` with the served `claims.json` record;
4. inspect the homepage and representative product journeys on the production alias.

No secret is required to perform the public comparison. A mismatch is deployment drift even if the repository build is green.

## Match the installation to the site

`site/brand.json` records the registry-verified `npm.publishedVersion` separately
from the source publication candidate. The developer page names the published
local snapshot and offers a current-source path; a candidate is never presented
as an installed release. After staged approval, read the registry version and
artifact integrity, install that exact tarball into an empty directory, and only
then update the published-version record and the corresponding page copy.

CI uploads `claims-measurement-<sha>` from its actual verification run. Confirm
that the named commit is the reviewed source and an ancestor of the publication
commit before copying the generated `measuredAgainst` record. A green site build
with an old measurement is not evidence that the current suite was measured.

## Public-site analytics

`site/assets/analytics.js` uses Vercel's hosted static Web Analytics script, with no
framework or scaffolder dependency. The shared page emitter supplies the canonical
public URL; previews and localhost do not load the collector. DNT or Global Privacy
Control suppresses collection. An external referrer containing a path, query or
fragment also suppresses collection because the hosted collector cannot redact it.

Only `tutorial_open`, `example_open` and `quickstart_open` CTA names are accepted
through `data-accordo-event`. Optional attribution is exactly `source` (one of
`dev`, `hashnode`, `skills`, `gemini`, `smithery`) and `campaign_id: quote-approval`,
read only when `utm_campaign=quote-approval`; all other query data is ignored.
Attribution lasts for that document only: no cookie or local storage carries it
to another page. Page views carry the canonical URL without query or fragment;
our CTA payloads are reconstructed from the allowlist. No text, form values, CRM
records, MCP queries or runtime activity is instrumented. This is minimization at
our checked-in call sites, not a sandbox around Vercel's global API: its other
commands and options can send routes, flags or additional metadata outside this
hook. This integration never calls those APIs. Adding another analytics caller or
script requires a new payload and privacy review; the current tests do not certify
arbitrary third-party JavaScript.

The project owner must enable Web Analytics in Vercel before deployment. Custom
events require the account's supported plan. Verify collector and event responses
on the production origin after deployment; passing local tests does not establish
dashboard ingestion. Page views and CTA clicks are interest signals, not successful
installs or benchmark outcomes. See `privacy.html` for platform metadata and controls.
