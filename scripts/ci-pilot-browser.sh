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
# 2. ensures a drivable Chromium: the first binary of the pilot's
#    browserBinCandidates order wins (ACCORDO_BROWSER_BIN included); when
#    none exists — a fresh Linux runner — it installs the browser the
#    pilot's pinned playwright-core expects (one-off, then cached) and
#    points the proof at it through ACCORDO_BROWSER_BIN;
# 3. installs its dependencies (`npm ci --prefer-offline`, skipped when
#    PILOT_SKIP_INSTALL=1 — local proof only, never CI);
# 4. replaces its pinned `accordo` dependency with THIS working tree
#    (`npm install --no-save`), so the browser drives the PR head, not the
#    last pin;
# 5. runs the pilot's browser proof (`npm run test:browser`): red when the
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
#   ACCORDO_BROWSER_BIN=<path>  drive this Chromium instead of resolving or
#                              installing one (also read by the pilot itself);
#   PILOT_DIR=<path> ......... use this pilot checkout instead of cloning;
#   PILOT_SKIP_INSTALL=1 ..... skip `npm ci` in the pilot checkout;
#   PILOT_BROWSER_FORCE=1 .... run the browser proof even when the diff does
#                              not touch the client (measures the green path);
#   PILOT_BROWSER_IGNORE_SYSTEM=1  tests only: resolve browsers under $HOME
#                              only, so the provisioning path is the same on
#                              every runner;
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

# A drivable Chromium in the same order as the pilot's browserBinCandidates
# (accordo-arvo-pilot tests/browser/browser-launch.js: env override first,
# then the Mac cache, Chrome on the Mac, the Linux cache, the Linux system
# binaries). Keep the two lists in sync: the build number below is the one
# the pilot's pinned playwright-core expects.
resolve_browser_bin() {
  home_dir="${HOME:-/root}"
  if [ -n "${ACCORDO_BROWSER_BIN:-}" ] && [ -x "$ACCORDO_BROWSER_BIN" ]; then
    printf '%s' "$ACCORDO_BROWSER_BIN"
    return 0
  fi
  candidate=""
  for candidate in \
    "$home_dir/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$home_dir/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell" \
    /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
    # PILOT_BROWSER_IGNORE_SYSTEM=1 (tests only): skip the machine-wide
    # binaries and look only under $HOME, so the provisioning path is
    # deterministic on any runner (a runner with a system Chromium would
    # otherwise never reach the install it is meant to prove).
    if [ "${PILOT_BROWSER_IGNORE_SYSTEM:-0}" = "1" ]; then
      case "$candidate" in "$home_dir"/*) ;; *) continue;; esac
    fi
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# A fresh Linux runner has no browser yet: install the headless shell the
# pilot's pinned playwright-core drives. It lands in the Linux cache above,
# so this is a one-off cost per runner, not per PR. The binary the proof
# uses is exported through ACCORDO_BROWSER_BIN, which the pilot checks
# first: even if the installed build drifts from the hardcoded one above,
# the proof drives exactly the binary this gate resolved.
ensure_browser() {
  bin=""
  if bin="$(resolve_browser_bin)"; then
    export ACCORDO_BROWSER_BIN="$bin"
    return 0
  fi
  play_version="$(cd "$pilot" && node -e 'console.log(require("./package.json").devDependencies["playwright-core"])')"
  echo "pilot-browser: no drivable Chromium found, installing the browser for playwright-core $play_version (one-off, then cached)"
  if ! (cd "$pilot" && npx -y "playwright@$play_version" install chromium); then
    echo "::error::ci-pilot-browser: could not provision a Chromium on this runner (head $head_sha): pre-install one of the browserBinCandidates paths or set ACCORDO_BROWSER_BIN"
    exit 1
  fi
  if bin="$(resolve_browser_bin)"; then
    export ACCORDO_BROWSER_BIN="$bin"
    return 0
  fi
  # Build-number drift between the pilot's hardcoded cache path and the
  # playwright release: ask the pinned playwright-core itself where its
  # browser lives.
  if bin="$(cd "$pilot" && node -e 'console.log(require("playwright-core").chromium.executablePath())')" && [ -x "$bin" ]; then
    export ACCORDO_BROWSER_BIN="$bin"
    return 0
  fi
  echo "::error::ci-pilot-browser: the headless shell install finished but no drivable Chromium resolves (head $head_sha)"
  exit 1
}

echo "pilot-browser: running the pilot browser proof against agent-crm head $head_sha"
if [ "$skip_install" != "1" ]; then
  (cd "$pilot" && npm ci --prefer-offline)
fi
(cd "$pilot" && npm install --no-save "$root")
# After the installs: the executablePath fallback below needs the pilot's
# own playwright-core on disk, which a fresh clone only has from here on.
ensure_browser
if (cd "$pilot" && npm run test:browser); then
  echo "pilot-browser: PASS in $((SECONDS - started))s (agent-crm head $head_sha)"
else
  code=$?
  echo "::error::ci-pilot-browser: the pilot browser proof failed on agent-crm head $head_sha after $((SECONDS - started))s"
  exit "$code"
fi
