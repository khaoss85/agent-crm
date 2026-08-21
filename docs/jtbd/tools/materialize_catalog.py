#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "manifest.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize the checked-in lossless JTBD sources.")
    parser.add_argument("--force", action="store_true", help="replace existing materialized files")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for item in manifest["sources"]:
        source = ROOT / item["source_path"]
        target = ROOT / item["materialized_path"]
        compressed = source.read_bytes()
        if len(compressed) != item["xz_bytes"] or sha256(compressed) != item["xz_sha256"]:
            raise SystemExit(f"compressed source integrity failure: {source.relative_to(ROOT)}")
        raw = lzma.decompress(compressed)
        if len(raw) != item["raw_bytes"] or sha256(raw) != item["raw_sha256"]:
            raise SystemExit(f"materialized source integrity failure: {source.relative_to(ROOT)}")
        if target.exists() and not args.force:
            existing = target.read_bytes()
            if sha256(existing) == item["raw_sha256"]:
                print(f"ok {target.relative_to(ROOT)}")
                continue
            raise SystemExit(f"target exists with different content: {target.relative_to(ROOT)}; use --force")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        print(f"wrote {target.relative_to(ROOT)} ({len(raw)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
