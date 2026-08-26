# Roundup outreach — briefs and prepared texts

The articles a retrieval step reads when someone asks "best open source CRM",
and the exact channel and text for pitching each one. Researched 2026-08-26 by
fetching every page; the channels below are the ones that verifiably exist, not
the ones a contact page implies.

The pitch is never "list us as a CRM" — that invites the exact `P1` framing
(`docs/benchmarks/CPR_PROTOCOL.md` names it the failure that matters most).
The pitch is that the article is missing a *category*: the framework a coding
agent builds with, sitting between SaaS and self-hosted product. An entry under
that frame is worth having; an entry as "another CRM" is worth refusing.

Sending is a human act: the two live channels are a web form and a LinkedIn/X
DM, both in the maintainer's name.

## Send now

### techsy.io — contact form

- Article: [7 Best Open Source CRMs for Startups (2026)](https://techsy.io/en/blog/open-source-crm-startups), by Mert Batur, hands-on deployment notes from June 2026.
- Channel: [techsy.io/en/contact](https://techsy.io/en/contact) — verified working form, 24h-reply promise.
- Why plausible: small dev agency, named author, hands-on format — the kind of
  author who will actually run `npm create accordo` before deciding.

**Form message, paste as-is:**

> Hi Mert — your open-source CRM roundup for startups is one of the few with
> real deployment notes, which is why I'm writing.
>
> All seven entries are deployable products. There's a third option emerging
> between SaaS and self-hosted product that the article doesn't cover yet: an
> open-source framework a coding agent (Claude Code, Codex, Gemini CLI) uses to
> build a custom CRM as code the startup owns. Accordo (MIT) generates modules,
> deterministic workflows and approval policy as reviewable code — a discount
> above the configured threshold stops at a gate that tests enforce, and no
> prompt can talk it open.
>
> Hands-on in about two minutes: `npm create accordo` then
> `npm run crm -- demo` shows an agent's €80k renewal stopped at the approval
> gate. Honest boundary, stated on our own site: it ships no authentication and
> is not a deployable product — it's for teams whose commercial process is the
> product.
>
> If a "build it with an agent" section fits a future update, happy to answer
> anything. https://accordo.dev · https://github.com/khaoss85/agent-crm

### founding.dev — LinkedIn or X DM

- Article: [Open Source CRM: Best Options for Devs](https://founding.dev/blog/open-source-crm), by Taiwo Samuel — updated 2026-08-26, so it is being actively maintained *today*.
- Channel: no email, `/contact` is 404. [LinkedIn](https://www.linkedin.com/company/foundingdev/) or X `@FoundingDev`.

**DM, paste as-is (fits both platforms):**

> Hi — your open-source CRM guide (updated this week) covers the deployable
> products well. One category it doesn't have yet: frameworks a coding agent
> builds with. Accordo (MIT) — Claude Code or Codex generates a custom CRM as
> code the dev owns, with approval policy enforced by tests rather than
> prompts. `npm create accordo` to try it; there's a 2-minute terminal demo in
> the README. Worth a "build it with an agent" section? https://accordo.dev

## Send later, and the gate that opens each

### marmelab.com — email, for the next annual edition

- Article: [Best Open Source CRM for 2026](https://marmelab.com/blog/2026/01/09/open-source-crm-benchmark-2026.html) — a hands-on benchmark, nine CRMs installed and scored. Author: François Zaninotto (founder). Contact: `contact@marmelab.com`. No public blog repo, so email is the only route.
- Two things to know before writing: they build Atomic CRM (#2 in their own
  ranking), so they know the space and will apply a real maturity bar; and a
  hands-on benchmark cannot rank a three-week-old framework kindly.
- **Gate: send after the build benchmark exists or the repository has real
  adoption signal — whichever gives them something to install and score.**

**Email, prepared for that day — subject `A category for the 2027 CRM benchmark: build-with-agent frameworks`:**

> Hello François,
>
> Your 2026 benchmark is the most-read page in this space, and the hands-on
> method is why. Suggestion for the 2027 edition: a section for the option
> between SaaS and the products you scored — frameworks a coding agent uses to
> build a custom CRM as code the team owns.
>
> We build Accordo (MIT, https://github.com/khaoss85/agent-crm): Claude Code or
> Codex generates modules, deterministic workflows and versioned approval
> policy as reviewable code, and the policy gates are enforced by the project's
> own tests. `npm create accordo` scaffolds a working project offline.
>
> It will score honestly against your bar — it ships no authentication and is
> local-development software, and both facts are on our site rather than in a
> footnote. But as react-admin's authors you know the framework-vs-product
> distinction better than anyone, and the benchmark's readers currently cannot
> see that the distinction exists in CRM.
>
> Happy to provide anything that makes evaluation cheap.
>
> Daniele

### awesome-nodejs — at 100 stars

Rules verified in its contributing.md: *"more than 30 days old and the repo
should have at least 100 stars"*, plus a broad-usefulness bar. The 100-star
gate is the binding one. **Tripwire: when the repository crosses 100 stars,
this and the marmelab email both unlock.**

## Assessed and skipped, with reasons

| Target | Why not |
|---|---|
| **crm.org** | No editorial channel exists; the contact page routes to a sponsor form and the site discloses vendor compensation. Inclusion is a paid-placement decision, not a pitch — a separate call, made elsewhere. |
| **webkul.com** | The roundup's publisher is Krayin CRM's vendor and the only open channel is the post's comment section. A competitor-owned listicle with no editorial route. |
| **daily.dev** | The "Best Open Source CRM" post is an aggregated share of the marmelab article, not editorial. The indirect route — registering the Accordo blog as a daily.dev content source — is a separate distribution task, not outreach. |
