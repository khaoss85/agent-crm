# Name verification log

Re-verification of the `BRAND_REQUIREMENTS.md` shortlist, so the founder's remaining work is a
registrar session and a trademark screen rather than a research project.

**Checked 2026-08-07 from the build environment.** The August 4 checks in `BRAND_REQUIREMENTS.md`
still hold; this run adds the `create-*` and scoped-package checks, which matter because
`npm create <name>` is the single highest-leverage distribution artifact.

## What was checked, and how

| Check | Method | Reliability |
|---|---|---|
| npm unscoped, `create-<name>`, `@<name>/core` | `registry.npmjs.org/<pkg>` — 404 means free | **Authoritative** |
| Domain | DNS A-record lookup | **Indicative only.** No A record is not proof of availability — a registered but unpointed domain looks identical. RDAP is unreachable from here |
| GitHub org / user | `api.github.com/users/<name>` | **Failed** — the proxy returns 403 unauthenticated. Not checked. A human must confirm |
| Trademark | — | **Not checked and not checkable here.** A real EUIPO + USPTO class 9 and 42 screen is a lawyer's job |

## Results

| Name | npm unscoped | `create-<name>` | `@<name>/core` | `.dev` | `.com` | Verdict |
|---|---|---|---|---|---|---|
| **Accordo** | free | free | free | no A record | taken | **Recommended** |
| **Pactio** | free | free | free | no A record | taken | Viable, one flag |
| **Vinculo** | free | free | free | no A record | taken | Viable |
| Relato | free | free | free | **resolves — taken** | taken | **Out** |

Every npm surface for all four is unclaimed, which is a better position than most projects get.
Relato is eliminated on the domain, confirming the August 4 finding.

## Recommendation: Accordo

Ranked on what is actually checkable: cleanest collision profile, every npm surface free,
`accordo.dev` unresolved, no dominant software namesake found, and it survives being said aloud —
`ah-KOR-doh`, three syllables, spelled the way it sounds. The semantics are exactly on target:
*agreement*, which is what a commercial process converges on, and "accord" reads in English
without translation. It also survives the product outgrowing CRM, which criterion 4 requires.

**Pactio's flag stands:** a live UK legal-tech company trades under that name, in adjacent
software. It has the same npm position as Accordo and a materially worse trademark position, so
Accordo wins on the axis that is hardest to fix later.

**Vinculo** is clean but three syllables with an accent-mark ambiguity (`vínculo` vs `vinculo`)
that costs you every time someone types it from memory.

## What a human must still do — in this order

1. **Trademark screen** on Accordo (EUIPO + USPTO, classes 9 and 42). This is the only step that
   can invalidate the choice, so it goes first. Everything below is cheap to undo; this is not.
2. **Registrar check and purchase** of `accordo.dev` — DNS silence here is not availability.
3. **Say it to five people and ask them to spell it.** The cheapest test that catches the most
   failures, and it takes ten minutes.
4. **Register defensively on selection**, same day: GitHub organisation, npm organisation scope
   *and* the unscoped `create-accordo`, `.dev` plus an accepted alternative TLD, and the social
   handles. Namespaces are unrenameable; a gap here is permanent.
5. **Confirm the GitHub organisation is free** — this environment could not check it.

Then, and only then:

```bash
node scripts/brand-set.js accordo          # dry run, prints every change
node scripts/brand-set.js accordo --apply  # one command
npm run gtm:check
```

## The rule

An agent may check a registry and recommend. An agent may not register a namespace, buy a domain,
create an account, or decide the name. This file is research handed to the person who decides —
`PENDING_HUMAN_SUBMISSION.md` decision 1.
