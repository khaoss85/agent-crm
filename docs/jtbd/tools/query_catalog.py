#!/usr/bin/env python3
"""Slice the Accordo JTBD portfolio without loading it.

The catalogue is 4.6 MB of JSONL. Every read here is a streamed pass, so answering
"which jobs does the commercial pillar own" costs one line at a time and never 600
records in memory.

Three layers, joined by ``jtbd_id`` and never merged into one vocabulary:

* ``catalog/jtbd.jsonl``                    -- the desired job. Says nothing about support.
* ``coverage/coverage.overlay.jsonl``       -- the four statuses in docs/QUALITY_GATES.md.
* ``roadmap/roadmap.overlay.jsonl``         -- who owns it and where it is planned.

The overlays are optional: with neither present this behaves exactly as it did before,
as a catalogue filter. ``--write`` them with ``node scripts/jtbd-gate.js --write``.

Examples::

    python docs/jtbd/tools/query_catalog.py --id ACC-JTBD-CRO-001 --json
    python docs/jtbd/tools/query_catalog.py --pillar commercial --coverage-status "partially supported"
    python docs/jtbd/tools/query_catalog.py --milestone M9 --fields
    python docs/jtbd/tools/query_catalog.py --dependency production-spine --count
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "catalog" / "jtbd.jsonl"
COVERAGE = ROOT / "coverage" / "coverage.overlay.jsonl"
ROADMAP = ROOT / "roadmap" / "roadmap.overlay.jsonl"

# Fields the catalogue keeps that are commercial judgement rather than a desired job.
# They are never printed, on any flag: docs/editions/REPOSITORY_BOUNDARY.md section 3.
PRIVATE_FIELDS = ("roadmap", "competitive_benchmark")


def stream_records(path: Path):
    """Yield JSON objects one line at a time without materialising the corpus."""
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def load_overlay(path: Path) -> dict[str, dict]:
    """Read one overlay into an id-keyed dict, streaming, or return {} if absent."""
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            out[row["jtbdId"]] = row
    return out


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="query_catalog.py",
        description="Slice the Accordo JTBD portfolio (catalogue + coverage + roadmap overlays).",
    )
    catalog = parser.add_argument_group("catalogue filters")
    catalog.add_argument("--persona", help="persona id")
    catalog.add_argument("--role", help="exact role name")
    catalog.add_argument("--capability", help="a capability id in core or supporting")
    catalog.add_argument("--phase", choices=["ADOPT", "RUN", "OPTIMIZE", "MAINTAIN", "GOVERN", "EVOLVE"])
    catalog.add_argument("--risk", choices=["LOW", "MEDIUM", "HIGH"])
    catalog.add_argument("--id", help="one jtbd_id")

    overlay = parser.add_argument_group("overlay filters (need the overlays to exist)")
    overlay.add_argument("--pillar", help="owning Accordo pillar, e.g. commercial")
    overlay.add_argument("--package", help="owning package, e.g. signature")
    overlay.add_argument("--edition", help="public-oss | private-managed-cloud")
    overlay.add_argument("--coverage-status", dest="coverage_status",
                         choices=["not supported", "partially supported",
                                  "technically supported", "validated end to end"])
    overlay.add_argument("--roadmap-status", dest="roadmap_status",
                         choices=["implemented", "in progress", "planned",
                                  "deferred", "unassigned", "out of scope"])
    overlay.add_argument("--milestone", help="a milestone name, e.g. M9")
    overlay.add_argument("--dependency", help="a pillar this job's owner depends on")

    output = parser.add_argument_group("output")
    output.add_argument("--json", action="store_true", help="a single JSON array on stdout")
    output.add_argument("--fields", action="store_true",
                        help="one block per match: job, coverage, owner, evidence, limitations")
    output.add_argument("--count", action="store_true", help="print only the number of matches")
    output.add_argument("--limit", type=int, default=0, help="stop after N matches (0 = no limit)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    coverage = load_overlay(COVERAGE)
    roadmap = load_overlay(ROADMAP)

    overlay_flags = (args.pillar, args.package, args.edition, args.coverage_status,
                     args.roadmap_status, args.milestone, args.dependency)
    if any(overlay_flags) and not (coverage and roadmap):
        print("the overlays are not present; run: node scripts/jtbd-gate.js --write", file=sys.stderr)
        return 2

    matches: list[dict] = []
    for record in stream_records(CATALOG):
        jtbd_id = record["jtbd_id"]
        caps = record["capabilities"]["core"] + record["capabilities"]["supporting"]
        if args.persona and args.persona != record["persona_id"]:
            continue
        if args.role and args.role != record["role"]:
            continue
        if args.capability and args.capability not in caps:
            continue
        if args.phase and args.phase != record["platform_lifecycle"]:
            continue
        if args.risk and args.risk != record["risk_and_governance"]["risk_level"]:
            continue
        if args.id and args.id != jtbd_id:
            continue

        cov = coverage.get(jtbd_id, {})
        own = roadmap.get(jtbd_id, {})
        if args.pillar and own.get("pillar") != args.pillar:
            continue
        if args.package and own.get("package") != args.package:
            continue
        if args.edition and own.get("edition") != args.edition:
            continue
        if args.coverage_status and cov.get("coverageStatus") != args.coverage_status:
            continue
        if args.roadmap_status and own.get("ownerStatus") != args.roadmap_status:
            continue
        if args.milestone and own.get("milestone") != args.milestone:
            continue
        if args.dependency and args.dependency not in (own.get("dependencies") or []):
            continue

        matches.append(project(record, cov, own))
        if args.limit and len(matches) >= args.limit:
            break
    if args.count:
        print(len(matches))
        return 0

    if args.json:
        # One array, not a stream of concatenated objects: `--json | jq` used to fail with
        # `Extra data` on every query that matched more than one record, and the trailing
        # `# matches=` line on stdout made even a single-match query unparseable.
        json.dump(matches, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    elif args.fields:
        for match in matches:
            print_block(match)
    else:
        for match in matches:
            print("\t".join([
                match["jtbd_id"], match["persona_id"], match["platform_lifecycle"],
                match["coverage"]["status"], match["owner"]["pillar"] or "-",
                match["job_name"],
            ]))

    # stderr, always: a count is a note to the operator, never part of the payload.
    print(f"# matches={len(matches)}", file=sys.stderr)
    return 0


def project(record: dict, coverage: dict, owner: dict) -> dict:
    """The catalogue record joined to its overlays, minus the commercial fields."""
    job = {key: value for key, value in record.items() if key not in PRIVATE_FIELDS}
    job["coverage"] = {
        "status": coverage.get("coverageStatus", "not assessed in this checkout"),
        "assessed": coverage.get("assessed", False),
        "evidence": coverage.get("evidence", []),
        "limitations": coverage.get("limitations", []),
        "verifiedAtSha": coverage.get("verifiedAtSha"),
        "factIds": coverage.get("factIds", []),
    }
    job["owner"] = {
        "resolution": owner.get("ownershipResolution"),
        "pillar": owner.get("pillar"),
        "package": owner.get("package"),
        "edition": owner.get("edition"),
        "roadmapTrack": owner.get("roadmapTrack"),
        "milestone": owner.get("milestone"),
        "dependencies": owner.get("dependencies", []),
        "ownerStatus": owner.get("ownerStatus"),
        "matrixRows": owner.get("matrixRows", []),
    }
    return job


def print_block(match: dict) -> None:
    coverage, owner = match["coverage"], match["owner"]
    print(f"{match['jtbd_id']}  {match['job_name']}")
    print(f"  desired    {match['job_statement']['canonical']}")
    print(f"  coverage   {coverage['status']} (assessed: {coverage['assessed']})")
    for item in coverage["evidence"]:
        print(f"    evidence   {item['kind']} {item['path']} — {item['claim']}")
    for limitation in coverage["limitations"]:
        print(f"    limitation {limitation}")
    print(f"  owner      {owner['pillar'] or '(no pillar)'} · {owner['ownerStatus']} · "
          f"{owner['edition'] or '-'} · milestone {owner['milestone'] or '(none)'}")
    print()


if __name__ == "__main__":
    raise SystemExit(main())
