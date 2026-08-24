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

`llms.txt`, `llms-full.txt`, JSON contracts, Markdown peers and `/version.json` are CORS-readable with explicit content types. Strategic HTML is canonical and advertises its generated Markdown peer. The Content Security Policy permits static styles and images but no executable site JavaScript.

## Human-only production check

Vercel project settings, production branch and the `accordo.dev` alias are account state. After the canonical PR merges, an account holder must:

1. confirm the production branch is `main` and the alias targets its latest successful deployment;
2. fetch `https://accordo.dev/version.json`;
3. compare `commit` with merged `main` and `measuredAgainst` with the served `claims.json` record;
4. inspect the homepage and representative product journeys on the production alias.

No secret is required to perform the public comparison. A mismatch is deployment drift even if the repository build is green.
