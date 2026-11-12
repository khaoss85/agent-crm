#!/usr/bin/env bash
# Promote a touched-tests busy CANDIDATE to the confirmed busy record
# (backlog:3d560518f3e2). Called by scripts/ci-fast.sh only after every lane
# has ended and the failures are counted:
#
#   scripts/ci-fast-busy-confirm.sh <candidate> <record> <failed lane>...
#
# The record is written (atomic rename of the candidate) only when the one
# failed lane is the touched-tests lane and the candidate exists; in every
# other case the candidate is removed and no record exists. The workflow
# retries ONLY on the record, so a gate killed before this point (the 540 s
# wrapper during `wait`) leaves at most a candidate, never a retry that could
# turn a red with other failures green. Exit 0 = confirmed busy, 1 = not.
set -uo pipefail
candidate="$1"
record="$2"
shift 2
touched_lane='tests of the touched files, then public claims and packaging agree'
rm -f "$record"
if [ -s "$candidate" ] && [ "$#" -eq 1 ] && [ "$1" = "$touched_lane" ]; then
  mv -f "$candidate" "$record"
  exit 0
fi
rm -f "$candidate"
exit 1
