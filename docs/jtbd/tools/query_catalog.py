#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import lzma

from catalog_source import ROOT, find_source, read_xz

RAW = ROOT / "catalog" / "jtbd.jsonl"


def lines():
    if RAW.exists():
        with RAW.open(encoding="utf-8") as fh:
            yield from fh
        return
    item = find_source("catalog/jtbd.jsonl")
    raw = lzma.decompress(read_xz(item)).decode("utf-8")
    yield from raw.splitlines(keepends=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--persona")
    p.add_argument("--role")
    p.add_argument("--capability")
    p.add_argument("--phase", choices=["ADOPT", "RUN", "OPTIMIZE", "MAINTAIN", "GOVERN", "EVOLVE"])
    p.add_argument("--risk", choices=["LOW", "MEDIUM", "HIGH"])
    p.add_argument("--id")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    result = []
    for line in lines():
        if not line.strip():
            continue
        j = json.loads(line)
        caps = j["capabilities"]["core"] + j["capabilities"]["supporting"]
        if args.persona and args.persona not in {j["persona_id"], j["role"]}:
            continue
        if args.role and args.role.lower() not in j["role"].lower():
            continue
        if args.capability and args.capability not in caps:
            continue
        if args.phase and args.phase != j["platform_lifecycle"]:
            continue
        if args.risk and args.risk != j["risk_and_governance"]["risk_level"]:
            continue
        if args.id and args.id != j["jtbd_id"]:
            continue
        result.append(j)
    for j in result:
        if args.json:
            print(json.dumps(j, ensure_ascii=False, indent=2))
        else:
            print(f"{j['jtbd_id']}\t{j['persona_id']}\t{j['platform_lifecycle']}\t{j['job_name']}")
    print(f"# matches={len(result)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
