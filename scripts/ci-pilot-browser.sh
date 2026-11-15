#!/usr/bin/env bash
# Pilot-browser gate (backlog:ae2d5d3c).
#
# On agent-crm PRs that touch the served backoffice client, run the pilot's
# browser proof against this exact head: the pilot serves `apps/admin/public`
# under /bo, so a client change that breaks the served modules (agent-crm#905:
# a regex literal with `//` that the serving step cut as a comment, leaving
# the whole shell without its sidebar) must fail here, on the PR, instead of
# reddening the pilot's pin on main the next night. PRs that do not touch the
# client skip in ~1 s and pay nothing.
#
# What it does on a client-touching diff:
# 1. clones the pilot (shallow, main) unless PILOT_DIR names a checkout;
# 2. installs its dependencies (`npm ci --prefer-offline`, skipped when
#    PILOT_SKIP_INSTALL=1 — local proof only, never CI);
# 3. replaces its pinned `accordo` dependency with THIS working tree
#    (`npm install --no-save`), so the browser drives the PR head, not the
#    last pin;
# 4. runs the pilot's browser proof (`npm run test:browser`): red when the
#    shell sidebar does not draw, green otherwise. Since the pilot's own
#    pageerror change (same backlog) the failing log also prints the page's
#    script and console errors, not just the missing markup.
#
# The elapsed time prints on every outcome (`pilot-browser: PASS/FAIL/SKIP
# in Ns`): that line is the live evidence for the "under 6 minutes" bound,
# and the PR body reports the measured figure. Auth reuses the runner's own
# git access to the private pilot repo (the same URL the Mac external CI
# clones); when the clone is denied, override with PILOT_GIT_URL.
#
# Usage (from the repository root, inside the `fast` CI job):
#
#   BASE_REF='<pr base branch>' bash scripts/ci-pilot-browser.sh
#
# Env overrides (local proof and diagnoisis only):
#   PILOT_DIR=<path> ......... use this pilot checkout instead of cloning;
#   PILOT_SKIP_INSTALL=1 ..... skip `npm ci` in the pilot checkout;
#   PILOT_BROWSER_FORCE=1 .... run the browser proof even when the diff does
#                              not touch the client (measures the green path);
#   HEAD_SHA=<sha> ............ pin named in the log (default: `git rev-parse HEAD`);
#   PILOT_GIT_URL=<url> ....... pilot remote (default: the github https URL);
#   AGENT_CRM_DIR=<path> ...... the agent-crm checkout under test (default:
#                              the checkout holding this script; the skip-path
#                              unit test points it at a throwaway repo).
set -euo pipefail

: "${BASE_REF:?ci-pilot-browser.sh needs BASE_REF (the PR base branch short name)}"

started=$SECONDS

root="${AGENT_CRM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
head_sha="${HEAD_SHA:-$(git -C "$root" rev-parse HEAD)}"
pilot_url="${PILOT_GIT_URL:-https://github.com/khaoss85/accordo-arvo-pilot.git}"
pilot_dir="${PILOT_DIR:-}"
skip_install="${PILOT_SKIP_INSTALL:-0}"
force="${PILOT_BROWSER_FORCE:-0}"

list="$(mktemp)"
work="$(mktemp -d)"
trap 'rm -f "$list"; rm -rf "$work"' EXIT

base="$(git -C "$root" merge-base HEAD "origin/$BASE_REF")"
git -C "$root" diff --name-only "$base" HEAD > "$list"
touches="$(CI_TOUCHED_NO_MAIN=1 node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { touchesAdminClient } = await import(String(pathToFileURL(process.argv[1])));
const files = [];
for await (const line of (await import("node:readline")).createInterface({ input: process.stdin })) {
  if (line !== "") files.push(line);
}
process.stdout.write(touchesAdminClient(files) ? "yes" : "no");
' "$script_dir/ci-touched-tests.js" < "$list")"

if [ "$force" != "1" ] && [ "$touches" != "yes" ]; then
  echo "pilot-browser: SKIP in $((SECONDS - started))s (no change under apps/admin/public, head $head_sha)"
  exit 0
fi

pilot="$pilot_dir"
if [ -z "$pilot" ]; then
  pilot="$work/pilot"
  if ! git clone -q --depth 1 "$pilot_url" "$pilot"; then
    echo "::error::ci-pilot-browser: cannot clone the pilot from $pilot_url (head $head_sha): the runner needs read access to the private pilot repo; override with PILOT_GIT_URL"
    exit 1
  fi
fi

echo "pilot-browser: running the pilot browser proof against agent-crm head $head_sha"
if [ "$skip_install" != "1" ]; then
  (cd "$pilot" && npm ci --prefer-offline)
fi
(cd "$pilot" && npm install --no-save "$root")
if (cd "$pilot" && npm run test:browser); then
  echo "pilot-browser: PASS in $((SECONDS - started))s (agent-crm head $head_sha)"
else
  code=$?
  echo "::error::ci-pilot-browser: the pilot browser proof failed on agent-crm head $head_sha after $((SECONDS - started))s"
  exit "$code"
fi
