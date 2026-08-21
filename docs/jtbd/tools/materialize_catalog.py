#!/usr/bin/env python3
from __future__ import annotations

import lzma

from catalog_source import ROOT, load_manifest, read_xz, sha256


def main() -> int:
    for item in load_manifest()["sources"]:
        compressed = read_xz(item)
        raw = lzma.decompress(compressed)
        if len(raw) != item["raw_bytes"] or sha256(raw) != item["raw_sha256"]:
            raise SystemExit(f"materialized source integrity failure: {item['materialized_path']}")
        target = ROOT / item["materialized_path"]
        if target.exists():
            existing = target.read_bytes()
            if len(existing) == item["raw_bytes"] and sha256(existing) == item["raw_sha256"]:
                print(f"ok {target.relative_to(ROOT)}")
                continue
            raise SystemExit(f"target exists with different content: {target.relative_to(ROOT)}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        print(f"wrote {target.relative_to(ROOT)} ({len(raw)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
