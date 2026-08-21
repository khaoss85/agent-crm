#!/usr/bin/env python3
from __future__ import annotations

import collections
import json
import lzma

from catalog_source import find_source, load_manifest, read_xz, sha256


def main() -> int:
    manifest = load_manifest()
    for item in manifest["sources"]:
        compressed = read_xz(item)
        raw = lzma.decompress(compressed)
        if len(raw) != item["raw_bytes"]:
            raise SystemExit(f"raw size mismatch for {item['materialized_path']}: {len(raw)} != {item['raw_bytes']}")
        digest = sha256(raw)
        if digest != item["raw_sha256"]:
            raise SystemExit(f"raw checksum mismatch for {item['materialized_path']}: {digest} != {item['raw_sha256']}")

    jtbd_raw = lzma.decompress(read_xz(find_source("catalog/jtbd.jsonl"))).decode("utf-8")
    records = [json.loads(line) for line in jtbd_raw.splitlines() if line.strip()]
    if len(records) != manifest["counts"]["jtbd"] or len(records) != 600:
        raise SystemExit(f"unexpected JTBD count: {len(records)}")
    ids = [r["jtbd_id"] for r in records]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate JTBD IDs")
    by_persona = collections.Counter(r["persona_id"] for r in records)
    if len(by_persona) != manifest["counts"]["personas"] or set(by_persona.values()) != {20}:
        raise SystemExit(f"unexpected persona distribution: {dict(by_persona)}")
    phase_counts = collections.Counter(r["platform_lifecycle"] for r in records)
    risk_counts = collections.Counter(r["risk_and_governance"]["risk_level"] for r in records)
    all_caps = {cap for r in records for cap in r["capabilities"]["core"] + r["capabilities"]["supporting"]}
    capabilities = json.loads(lzma.decompress(read_xz(find_source("catalog/capabilities.json"))))
    capability_ids = {c["capability_id"] for c in capabilities}
    unknown = sorted(all_caps - capability_ids)
    if unknown:
        raise SystemExit(f"unknown capability references: {unknown[:10]}")
    if len(capability_ids) != manifest["counts"]["capabilities"] or len(capability_ids) != 225:
        raise SystemExit(f"unexpected capability count: {len(capability_ids)}")
    scenarios = json.loads(lzma.decompress(read_xz(find_source("catalog/e2e_scenarios.json"))))
    if len(scenarios) != manifest["counts"]["e2e_scenarios"] or len(scenarios) != 10:
        raise SystemExit(f"unexpected scenario count: {len(scenarios)}")
    if any(r["coverage"]["status"] != "NOT_ASSESSED" for r in records):
        raise SystemExit("portable catalog contains a pre-assessed coverage row")
    print(f"personas={len(by_persona)} capabilities={len(capability_ids)} jtbd={len(records)}")
    print("phase_counts=", dict(phase_counts))
    print("risk_counts=", dict(risk_counts))
    print(f"e2e_scenarios={len(scenarios)}")
    print("VALIDATION_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
