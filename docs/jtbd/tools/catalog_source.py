#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def find_source(materialized_path: str) -> dict:
    for item in load_manifest()["sources"]:
        if item["materialized_path"] == materialized_path:
            return item
    raise KeyError(materialized_path)


def read_xz(item: dict) -> bytes:
    if item.get("transport") == "base64-xz-parts":
        encoded = b"".join(
            (ROOT / part).read_bytes().strip()
            for part in item["source_parts_b64"]
        )
        try:
            compressed = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise ValueError(f"invalid base64 source for {item['materialized_path']}") from exc
    else:
        source = ROOT / item["source_path"]
        stored = source.read_bytes()
        if item.get("transport") == "base64-xz" or source.suffix == ".b64":
            compressed = base64.b64decode(stored, validate=False)
        else:
            compressed = stored

    if len(compressed) != item["xz_bytes"]:
        raise ValueError(
            f"compressed size mismatch for {item['materialized_path']}: "
            f"{len(compressed)} != {item['xz_bytes']}"
        )
    digest = sha256(compressed)
    if digest != item["xz_sha256"]:
        raise ValueError(
            f"compressed checksum mismatch for {item['materialized_path']}: "
            f"{digest} != {item['xz_sha256']}"
        )
    return compressed
