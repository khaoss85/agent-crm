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
# 1800 s (PIECE_MAX_SEC) — the check, then each of the MEASURE_SHARDS pieces. The
# shell-classifier oracle used to dominate whichever piece held it (~13-20
# minutes against its own 40-minute driver budget, 907-1070 s on the machine
# log), so that piece once kept 1800 s. The verifier failed the exception
# (backlog:664d5f481a96: every piece declares the same maximum), so the corpus is
# sliced one grouping per file across tests/shell-oracle-a/b/c/d/e/f.test.js
# — the same 27,340 full cells (26,880 command-shape plus the heredoc
# cross-product), six pieces of about a sixth each. Timed on this Mac on
# 2026-10-21, file by file, sequential (the shard run adds
# --test-concurrency=2, which only helps): the heaviest full slice (F: trap
# plus the heredoc cells, 4,940 cells) drives in 214 s, the 4,480-cell
# slices in ~190 s (B measured 189 s), and the heaviest whole piece
# (piece 5: slice F plus its 47 shard-mates) totals ~502 s — about 400 s
# of margin under the common maximum (900 s then; 1800 s since 28/10). Shard-mates cost the same in default
# and full mode: only tests/helpers/shell-oracle.js reads
# ACCORDO_FULL_SHELL_ORACLE. If a slice ever outgrows it, slice smaller,
# never cap one piece higher.
#
# Usage: bash scripts/measure-pieces.sh [--apply]
#   without --apply prints the { measuredAgainst } block (CI redirects it
#   into the measurement artifact); with --apply writes site/claims.json.
#   MEASURE_SHARDS sets the piece count (default 6, minimum 6: the six
#   oracle slices need one piece each, and any smaller count would
#   co-locate two slices in one piece past the common maximum).
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

# One machine-lock maximum for every piece (backlog:664d5f481a96). 900 s held at
# night but not under the shared Mac's daytime load (45-75): on 28/10 two full
# runs were killed at 900 s with every finished piece green. 1800 s keeps the
# pieces serial and the lock released between them, so Arvo keeps precedence.
PIECE_MAX_SEC=1800

SHARDS="${MEASURE_SHARDS:-6}"
if ! [[ "$SHARDS" =~ ^[0-9]+$ ]] || [ "$SHARDS" -lt 1 ]; then
  echo "measure-pieces: MEASURE_SHARDS must be a positive whole number, got ${MEASURE_SHARDS:-(unset)}." >&2
  exit 2
fi
if [ "$SHARDS" -lt 6 ]; then
  echo "measure-pieces: MEASURE_SHARDS must be at least 6: the six oracle slices" >&2
  echo "  (tests/shell-oracle-a/b/c/d/e/f.test.js) need one piece each, and fewer" >&2
  echo "  pieces would co-locate two full slices past the ${PIECE_MAX_SEC} s lock maximum." >&2
  echo "  Refusing before taking any lock; use the default 6 or more." >&2
  exit 2
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/accordo-measure-pieces-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

echo "measure-pieces: check piece under its own lock (max ${PIECE_MAX_SEC}s)…" >&2
HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC="$PIECE_MAX_SEC" \
  scripts/ci-heavy.sh measure-check -- npm run check >&2

for (( i = 1; i <= SHARDS; i++ )); do
  echo "measure-pieces: piece $i of $SHARDS (lock max ${PIECE_MAX_SEC}s)…" >&2
  start="$(date +%s)"
  HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC="$PIECE_MAX_SEC" \
    scripts/ci-heavy.sh "measure-$i-of-$SHARDS" -- \
    node scripts/measure-suite.js --shard "$i/$SHARDS" --out "$scratch/shard-$i.json" >&2
  echo "measure-pieces: piece $i of $SHARDS green in $(( $(date +%s) - start ))s; lock released." >&2
done

if [ "$APPLY" = 1 ]; then
  node scripts/measure-suite.js --combine "$scratch"/shard-*.json --apply
else
  node scripts/measure-suite.js --combine "$scratch"/shard-*.json
fi
