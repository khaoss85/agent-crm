#!/usr/bin/env bash
# Runs the server's Chromium with --no-sandbox (Ubuntu without unprivileged user namespaces).
# Real binary: CHROMIUM_REAL_BIN, else CHROMIUM_BIN when it is not this wrapper, else chromium on PATH.
# Use: CHROMIUM_REAL_BIN=<headless shell> CHROMIUM_BIN=<this file> npm run bo:shots
set -euo pipefail
self="$(readlink -f "$0")"
real="${CHROMIUM_REAL_BIN:-}"
if [ -z "$real" ] && [ -n "${CHROMIUM_BIN:-}" ] && [ "$(readlink -f "$CHROMIUM_BIN")" != "$self" ]; then real="$CHROMIUM_BIN"; fi
[ -n "$real" ] || real="$(command -v chromium || command -v chromium-browser || true)"
[ -n "$real" ] || { echo "chromium-nosandbox: no Chromium (set CHROMIUM_REAL_BIN or put chromium on PATH)" >&2; exit 127; }
exec "$real" --no-sandbox "$@"
