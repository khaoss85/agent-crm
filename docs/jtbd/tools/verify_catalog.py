#!/usr/bin/env python3
from __future__ import annotations

import collections
import hashlib
import json
import lzma
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


for item in MANIFEST["sources"]:
    path = ROOT / item["source_path"]
    compressed = path.read_bytes()
    assert len(compressed) == item["xz_bytes"], path
    assert sha256(compressed) == item["xz_sha256"], path
    raw = lzma.decompress(compressed)
    assert len(raw) == item["raw_bytes"], path
    assert sha256(raw) == item["raw_sha256"], path

raw = lzma.decompress((ROOT / "source/jtbd.jsonl.xz").read_bytes()).decode("utf-8")
records = [json.loads(line) for line in raw.splitlines() if line.strip()]
assert len(records) == MANIFEST["counts"]["jtbd"] == 600
ids = [r["jtbd_id"] for r in records]
assert len(ids) == len(set(ids))
by_persona = collections.Counter(r["persona_id"] for r in records)
assert len(by_persona) == MANIFEST["counts"]["personas"] == 30
assert set(by_persona.values()) == {20}
phase_counts = collections.Counter(r["platform_lifecycle"] for r in records)
risk_counts = collections.Counter(r["risk_and_governance"]["risk_level"] for r in records)
all_caps = {c for r in records for c in r["capabilities"]["core"] + r["capabilities"]["supporting"]}
capabilities = json.loads(lzma.decompress((ROOT / "source/capabilities.json.xz").read_bytes()))
capability_ids = {c["capability_id"] for c in capabilities}
assert all_caps <= capability_ids, sorted(all_caps - capability_ids)[:10]
assert len(capability_ids) == MANIFEST["counts"]["capabilities"] == 225
print(f"personas={len(by_persona)} capabilities={len(capability_ids)} jtbd={len(records)}")
print("phase_counts=", dict(phase_counts))
print("risk_counts=", dict(risk_counts))
print("VALIDATION_OK")
