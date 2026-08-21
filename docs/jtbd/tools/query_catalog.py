#!/usr/bin/env python3
"""Query the desired-state JTBD catalogue.

Two properties matter here, and both were broken when the catalogue was first
published.

**`--json` output must parse.** It emits exactly one JSON document — always an
array, even for a single match — and nothing else on stdout. The human-readable
match count goes to stderr, so `query_catalog.py --json | jq` works and so does
`json.loads(subprocess.check_output(...))`. The first version printed
`# matches=N` on stdout *after* the JSON, and printed concatenated objects for a
multi-match query. Either alone makes the output unparseable.

**The reader streams.** The catalogue is 4.6 MB and `docs/jtbd/AGENTS.md`
requires selecting the smallest relevant slice rather than materialising 600
records. This iterates line by line and keeps only matches, so memory is bounded
by the result set rather than by the corpus.

This tool reads the desired-state catalogue only. It says nothing about whether
Accordo supports a job; that is the coverage overlay's question, and the two must
not be confused.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "catalog/jtbd.jsonl"


def stream_records(path):
    """Yield one record per line. Never materialises the whole file."""
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def selected(record, args):
    caps = record["capabilities"]["core"] + record["capabilities"]["supporting"]
    if args.persona and args.persona not in {record["persona_id"], record["role"]}:
        return False
    if args.role and args.role != record["role"]:
        return False
    if args.capability and args.capability not in caps:
        return False
    if args.phase and args.phase != record["platform_lifecycle"]:
        return False
    if args.risk and args.risk != record["risk_and_governance"]["risk_level"]:
        return False
    if args.id and args.id != record["jtbd_id"]:
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description="Query the desired-state JTBD catalogue.")
    parser.add_argument("--persona", help="persona id or role name")
    parser.add_argument("--role", help="exact role name")
    parser.add_argument("--capability")
    parser.add_argument("--phase", choices=["ADOPT", "RUN", "OPTIMIZE", "MAINTAIN", "GOVERN", "EVOLVE"])
    parser.add_argument("--risk", choices=["LOW", "MEDIUM", "HIGH"])
    parser.add_argument("--id")
    parser.add_argument("--limit", type=int, help="stop after N matches")
    parser.add_argument("--json", action="store_true", help="emit one JSON array on stdout and nothing else")
    args = parser.parse_args()

    if not CATALOG.exists():
        print(f"catalogue not found: {CATALOG}", file=sys.stderr)
        return 2

    found = []
    for record in stream_records(CATALOG):
        if not selected(record, args):
            continue
        found.append(record)
        if args.limit and len(found) >= args.limit:
            break

    if args.json:
        # One document, always an array: a caller that asked for JSON should not
        # have to branch on how many results came back.
        json.dump(found, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        for record in found:
            print(
                f"{record['jtbd_id']}\t{record['persona_id']}"
                f"\t{record['platform_lifecycle']}\t{record['job_name']}"
            )

    # stderr, never stdout — putting this on stdout is how --json broke before.
    print(f"# matches={len(found)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
