#!/usr/bin/env bash
#
# Opens the three pull-request-route awesome-list submissions prepared in
# docs/marketing/AWESOME_LIST_SUBMISSIONS.md. Run it from a machine with `gh`
# logged in as the maintainer.
#
#   ./scripts/submit-awesome-lists.sh            # dry run: prints every patch, changes nothing
#   ./scripts/submit-awesome-lists.sh --apply    # forks, branches, pushes, opens the PRs
#
# The fourth list, hesreallyhim/awesome-claude-code, is deliberately absent.
# It takes an issue form rather than a PR, and its CONTRIBUTING says outright
# that "resource recommendations must be created by human beings" — so it is
# a browser tab, not a script step.
#
# Why this file exists at all: an agent session is bound to this repository,
# and its proxy refuses write access to every GitHub path outside it. Forking
# is such a path. The entry text was written and checked by an agent; the
# sending is yours, which is also what MASTER_PLAN.md §10.4 asks for.
#
# Anchors below were read out of each upstream README on 2026-08-26. Lists
# move. If an anchor is gone the script stops on that list rather than
# guessing a location — a misplaced entry is worse than no entry.

set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

REPO_URL="https://github.com/khaoss85/agent-crm"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

note() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

command -v gh  >/dev/null || die "gh is not installed — https://cli.github.com"
command -v git >/dev/null || die "git is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"

WHO="$(gh api user --jq .login)"
note "Authenticated as $WHO"
[ "$WHO" = "khaoss85" ] || warn "expected khaoss85 — the entries name that account as the author"

if [ "$APPLY" -eq 1 ]; then
  # Three upstream repositories get cloned over https and one fork gets pushed
  # to. Without a git credential helper the push prompts for a password that
  # GitHub stopped accepting years ago; this is the one-liner that fixes it,
  # and it is idempotent.
  gh auth setup-git

  git config --get user.email >/dev/null \
    || die "git user.email is unset — the commits would be unattributable. Set it and re-run."
fi

if [ "$APPLY" -eq 0 ]; then
  note "DRY RUN — nothing will be forked, pushed or opened. Re-run with --apply."
fi

# ---------------------------------------------------------------- insertion
#
# Inserts PAYLOAD into FILE immediately after ANCHOR (a fixed string), or, when
# AFTER is non-empty, after the first line matching that regex at or below the
# anchor. Exits 3 if the anchor never appears, which is the whole point: the
# caller then skips that list instead of appending to the wrong section.

insert_after() {
  local file="$1" anchor="$2" after="$3" payload="$4"
  awk -v ANCHOR="$anchor" -v AFTER="$after" -v PAYLOAD="$payload" '
    { print }
    state == 0 && index($0, ANCHOR) > 0 { state = 1; if (AFTER == "") emit = 1 }
    state == 1 && AFTER != "" && $0 ~ AFTER { emit = 1 }
    emit == 1 {
      while ((getline l < PAYLOAD) > 0) print l
      close(PAYLOAD); emit = 0; state = 2
    }
    END { if (state != 2) exit 3 }
  ' "$file" > "$file.tmp"
}

# ---------------------------------------------------------------- one list

submit() {
  local upstream="$1" branch="$2" file="$3" anchor="$4" after="$5"
  local payload="$6" title="$7" body="$8"
  local name; name="$(basename "$upstream")"

  note "── $upstream"

  local dir="$WORK/$name"
  git clone -q --depth 1 "https://github.com/$upstream.git" "$dir" 2>/dev/null \
    || { warn "clone failed — skipping"; return 0; }

  if grep -qF "khaoss85/agent-crm" "$dir/$file"; then
    warn "already listed in $file — nothing to do"
    return 0
  fi

  if ! insert_after "$dir/$file" "$anchor" "$after" "$payload"; then
    warn "anchor not found in $file:"
    warn "  $anchor"
    warn "the list reorganised — re-read it and update this script. Skipping."
    return 0
  fi
  mv "$dir/$file.tmp" "$dir/$file"

  echo
  git -C "$dir" --no-pager diff --unified=2 -- "$file" | sed 's/^/  /'

  if [ "$APPLY" -eq 0 ]; then
    warn "dry run — not submitted"
    return 0
  fi

  # Fork and push. gh fork is idempotent: an existing fork is reused.
  gh repo fork "$upstream" --remote=false --clone=false >/dev/null 2>&1 || true
  sleep 3   # a just-created fork is not immediately pushable

  git -C "$dir" remote add fork "https://github.com/$WHO/$name.git"
  git -C "$dir" checkout -qb "$branch"
  git -C "$dir" commit -qam "$title"

  local n=0
  until git -C "$dir" push -q -u fork "$branch" 2>/dev/null; do
    n=$((n + 1)); [ "$n" -ge 4 ] && die "push to $WHO/$name failed after 4 attempts"
    sleep $((2 ** n))
  done

  gh pr create --repo "$upstream" \
    --head "$WHO:$branch" \
    --title "$title" \
    --body-file "$body"
}

# ---------------------------------------------------------------- the three

# 1. punkpeye/awesome-mcp-servers — the docs MCP server.
#    Entries sit directly under the heading with no blank line, and the file
#    does not keep the alphabetical order its CONTRIBUTING asks for; recent
#    additions go on top. Following the file rather than the instruction.
cat > "$WORK/p1" <<'ENTRY'
- [khaoss85/agent-crm](https://github.com/khaoss85/agent-crm) 🎖️ 📇 ☁️ - Read-only documentation server for Accordo, an open-source CRM framework that coding agents build with. Three tools over the published corpus: `search_docs`, `get_capability` — which returns every capability together with the limitation that bounds it — and `check_job` over a CRM jobs matrix whose default status is "not supported". Opens no database and holds no customer record. Endpoint: `https://accordo.dev/api/mcp`; also runs over stdio from a checkout.
ENTRY

cat > "$WORK/b1" <<'BODY'
Adds the Accordo documentation MCP server under Developer Tools.

- Repository: https://github.com/khaoss85/agent-crm (MIT)
- Endpoint: https://accordo.dev/api/mcp (Streamable HTTP, no auth, read-only)
- Also in the official MCP Registry as `io.github.khaoss85/agent-crm`

Three read-only tools over the project's published documentation corpus.
`get_capability` returns a capability together with the limitation that bounds
it — the server has no way to return one without the other — and `check_job`
answers over a jobs matrix whose default status is "not supported". The server
opens no database, imports no CRM runtime and persists no request; its own
tests reject any import path into the runtime.

Checked before submitting: both links resolve, and `tools/list` against the
endpoint returns exactly `search_docs`, `get_capability` and `check_job`, each
with `readOnlyHint: true`.

No Glama badge: Accordo has no Glama listing yet, and a badge for a listing
that does not exist renders as a broken image.
BODY

submit "punkpeye/awesome-mcp-servers" "add-accordo-docs-mcp" "README.md" \
  '<a name="developer-tools"></a>Developer Tools' "" \
  "$WORK/p1" "Add Accordo docs MCP server (Developer Tools)" "$WORK/b1"

# 2. travisvn/awesome-claude-skills — the eleven-skill plugin.
#    Collections & Libraries is a bulleted list with sub-bullets, not a table.
#    Matching the shape obra/superpowers uses, "Installation:" line included.
#    The trailing blank line is load-bearing: the anchor resolves to the blank
#    line under the heading, so a leading blank would double it and the entry
#    would run straight into obra/superpowers with nothing between them.
cat > "$WORK/p2" <<'ENTRY'
- **[Accordo](https://github.com/khaoss85/agent-crm)** - Eleven skills for building a custom CRM as code you own: modules, deterministic workflows, domain packages, commercial operations, contract activation, delivery and service
  - Commercial policy is generated as code and proven by tests in the project's merge gate, so a rule the agent is asked to bypass fails a test rather than a prompt
  - Ships a local project MCP; code generation stays dry-run until `--apply`
  - Installation: `/plugin marketplace add khaoss85/agent-crm` then `/plugin install accordo`

ENTRY

cat > "$WORK/b2" <<'BODY'
Adds Accordo under Community Skills → Collections & Libraries.

- Repository: https://github.com/khaoss85/agent-crm (MIT)
- Install: `/plugin marketplace add khaoss85/agent-crm` then `/plugin install accordo`
- Skills: eleven, each a `SKILL.md` with YAML frontmatter under `skills/`

The skills build CRM modules, deterministic workflows and domain packages
against an open-source framework in the same repository. Approval rules are
generated as code and proven by tests that run in the project's merge gate, so
a policy the agent is asked to bypass fails a test rather than a prompt.

Filed under Collections & Libraries rather than Individual Skills because it is
a plugin of eleven skills, not one.

Actively maintained: commits on the default branch this week.
BODY

submit "travisvn/awesome-claude-skills" "add-accordo" "README.md" \
  "### Collections & Libraries" '^$' \
  "$WORK/p2" "Add Accordo (eleven CRM-building skills) to Community Skills" "$WORK/b2"

# 3. sneg55/awesome-open-source-crm — the only list carrying a CRM Frameworks
#    section, which is the category this project has to be read as. House style
#    there is one short clause; the "not a deployable CRM" half stays, because
#    every other row in that table is something a reader can deploy tonight.
cat > "$WORK/p3" <<'ENTRY'
| [Accordo](https://github.com/khaoss85/agent-crm) | Framework for building a custom CRM as code with a coding agent, with deterministic policy and audit; not a deployable CRM — it ships no authentication | Node.js | ![GitHub stars](https://img.shields.io/github/stars/khaoss85/agent-crm?style=flat-square) |
ENTRY

cat > "$WORK/b3" <<'BODY'
Adds Accordo under CRM Frameworks.

- Repository: https://github.com/khaoss85/agent-crm (MIT)
- Stack: Node.js
- Try it: `npm create accordo`

Against the four criteria in CONTRIBUTING: open source (MIT), commits within
twelve months (this week), working software (`create-accordo` is published on
npm and scaffolds a running project), CRM-related (it builds CRMs).

The description says it is not a deployable CRM on purpose. Accordo ships no
authentication and is a framework a coding agent builds with, not an
application you host — and every other row in that table is something a reader
can deploy. Happy to shorten the entry, but that clause is the part worth
keeping.
BODY

submit "sneg55/awesome-open-source-crm" "add-accordo" "README.md" \
  "## CRM Frameworks" '^\|-' \
  "$WORK/p3" "Add Accordo under CRM Frameworks" "$WORK/b3"

# ---------------------------------------------------------------- remaining

note "Remaining, and not scriptable: hesreallyhim/awesome-claude-code"
cat <<'REMAINING'
  An issue form, not a PR, and its CONTRIBUTING requires the recommendation to
  come from a human. Eligible since 2026-08-18 (14 days from the first commit,
  2026-08-04). One recommendation at a time, so it is worth the two minutes.

  Issues → New issue → "Recommend a resource" on hesreallyhim/awesome-claude-code
  Fields and the exact checklist are in docs/marketing/AWESOME_LIST_SUBMISSIONS.md §2.
REMAINING
