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
# Budgets (declared maxima, enforced by the wrapper): a normal piece gets
# 900 s — the ~250 non-oracle files share ~25 minutes, so a normal piece
# finishes in about five, with room for a loaded machine. `npm run check`
# gets the same 900 s. The piece holding the full-oracle file
# (HEAVY_MEASURE_FILE in measure-suite.js, ~13-20 minutes against its own
# 40-minute driver budget) keeps 1800 s: the machine log shows it holding
# 907-1070 s on recent scheduled runs, so a 900 s cap would kill healthy
# runs red (DECISION to be confirmed: split the oracle corpus across pieces
# so the heavy piece fits 900 s too; until then the exception stays). The
# dealing (`--plan`) marks that piece, so no index is hardcoded here: the
# budget follows the file.
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

node scripts/measure-suite.js --plan "$SHARDS" > "$scratch/plan.json"
for (( i = 1; i <= SHARDS; i++ )); do
  if node -e 'process.exit(require(process.argv[1]).pieces[Number(process.argv[2]) - 1].heavy ? 0 : 1)' \
    "$scratch/plan.json" "$i"; then
    max=1800
    why="holds the full-oracle file (DECISION backlog:664d5f481a96: 900 s would kill its healthy 907-1070 s runs)"
  else
    max=900
    why="normal piece"
  fi
  echo "measure-pieces: piece $i of $SHARDS ($why, lock max ${max}s)…" >&2
  start="$(date +%s)"
  HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC="$max" \
    scripts/ci-heavy.sh "measure-$i-of-$SHARDS" -- \
    node scripts/measure-suite.js --shard "$i/$SHARDS" --out "$scratch/shard-$i.json" >&2
  echo "measure-pieces: piece $i of $SHARDS green in $(( $(date +%s) - start ))s; lock released." >&2
done

if [ "$APPLY" = 1 ]; then
  node scripts/measure-suite.js --combine "$scratch"/shard-*.json --apply
else
  node scripts/measure-suite.js --combine "$scratch"/shard-*.json
fi
