#!/usr/bin/env bash
# Full measurement in short pieces (backlog:9fff957f3968, backlog:664d5f481a96).
#
# The monolith (`node scripts/measure-suite.js --apply`, one `npm run verify`
# ~25-40 minutes under a single machine-lock acquisition) queued every other
# factory's heavy step behind it: priority orders the queue, not the length
# of a running job. This runner measures the same corpus piece by piece:
#
#   1. `npm run check` under its own lock (the `check && tests` of `verify`,
#      fail-fast first);
#   2. one `measure-suite.js --shard i/n` per piece, each under its OWN
#      heavy-job acquisition with its OWN declared maximum — the lock is
#      free between two pieces, and a piece past its maximum fails red
#      instead of holding the machine;
#   3. `measure-suite.js --combine`, which runs no tests and takes no lock.
#
# One waiter at a time (backlog:664d5f481a96): the pieces run strictly in
# series in the loop below — each piece enters the machine-lock queue only
# after the previous one released the lock, so this run never holds two
# lock waiters at once (a backgrounded piece would queue beside Arvo with
# its own aging: never background a piece here). `tests/measure-pieces.test.js`
# pins the seriality by counting coexisting waiters through test doubles.
#
# Budgets (declared maxima, enforced by the wrapper): every piece gets
# 900 s — the check, then each of the MEASURE_SHARDS pieces. The
# shell-classifier oracle used to dominate whichever piece held it (~13-20
# minutes against its own 40-minute driver budget, 907-1070 s on the machine
# log), so that piece once kept 1800 s. The verifier failed the exception
# (backlog:664d5f481a96: every piece declares 900 s), so the corpus is
# sliced by grouping pair across tests/shell-oracle-a/b/c.test.js — same
# 26,880 cells, three pieces of about a third each — and no piece needs
# more than the common 900 s. If a slice ever outgrows it, slice smaller,
# never cap one piece higher.
#
# Usage: bash scripts/measure-pieces.sh [--apply]
#   without --apply prints the { measuredAgainst } block (CI redirects it
#   into the measurement artifact); with --apply writes site/claims.json.
#   MEASURE_SHARDS sets the piece count (default 6).
# Stdout carries ONLY the combined record: every progress line and every
# heavy child (check included) is redirected to stderr, so a redirected
# stdout stays parsable JSON for apply-ci-measurement.js.
set -euo pipefail

APPLY=0
for arg in "$@"; do
  if [ "$arg" = "--apply" ]; then APPLY=1; else
    echo "measure-pieces: unexpected argument $arg (only --apply)." >&2
    exit 2
  fi
done

SHARDS="${MEASURE_SHARDS:-6}"
if ! [[ "$SHARDS" =~ ^[0-9]+$ ]] || [ "$SHARDS" -lt 1 ]; then
  echo "measure-pieces: MEASURE_SHARDS must be a positive whole number, got ${MEASURE_SHARDS:-(unset)}." >&2
  exit 2
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/accordo-measure-pieces-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

echo "measure-pieces: check piece under its own lock (max 900s)…" >&2
HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC=900 \
  scripts/ci-heavy.sh measure-check -- npm run check >&2

for (( i = 1; i <= SHARDS; i++ )); do
  echo "measure-pieces: piece $i of $SHARDS (lock max 900s)…" >&2
  start="$(date +%s)"
  HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC=900 \
    scripts/ci-heavy.sh "measure-$i-of-$SHARDS" -- \
    node scripts/measure-suite.js --shard "$i/$SHARDS" --out "$scratch/shard-$i.json" >&2
  echo "measure-pieces: piece $i of $SHARDS green in $(( $(date +%s) - start ))s; lock released." >&2
done

if [ "$APPLY" = 1 ]; then
  node scripts/measure-suite.js --combine "$scratch"/shard-*.json --apply
else
  node scripts/measure-suite.js --combine "$scratch"/shard-*.json
fi
