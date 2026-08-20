# syntax=docker/dockerfile:1.7
#
# Accordo Docs MCP — the read-only documentation server (packages/docs-mcp).
#
# This image runs ONE thing: the stdio MCP server that answers questions about
# the Accordo framework's own documentation, its claims ledger and its jobs
# index. It is the scannable form: a scanner can start it, speak JSON-RPC over
# stdin/stdout, enumerate every tool and resource, and observe that it opens no
# socket and touches no state.
#
# It is NOT the CRM. It does not host packages/mcp, opens no database, holds no
# customer record, exposes no write tool, and carries no secret or credential.
#
# Why it lives here rather than at the repository root: a root Dockerfile would
# read as "deploy this application", and L-01 says plainly that you must not —
# there is no authentication, tenancy or RBAC. Scoping it to the one package it
# builds keeps that unambiguous. Glama stores its own copy out of tree and does
# not need this file; it is checked in so the image a directory scans is
# reproducible from source and reviewable in a diff.

# ---------------------------------------------------------------------------
# Stage 1 — assemble the runtime corpus
# ---------------------------------------------------------------------------
# Pinned by digest AND by exact version so the build is reproducible and the
# tag is readable. node:22.23.2-alpine, resolved 2026-08-19; Node 22 is
# Maintenance LTS until 2027-04-30 and satisfies the repository's
# engines.node ">=22.16.0".
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS corpus

WORKDIR /src

# No `npm install` anywhere in this file, on purpose rather than by omission.
# The repository declares zero third-party runtime dependencies and its
# package-lock.json contains only the root entry, so there is nothing to
# install, no dev dependencies to prune and no registry to reach. Every line of
# JavaScript in the final image comes from this repository or from the pinned
# Node base image.

# Only what the corpus assembler and the server itself need. Copying narrowly
# rather than `COPY . .` keeps the build independent of a .dockerignore that
# this Dockerfile cannot rely on (Glama stores the Dockerfile out of tree).
COPY package.json ./
COPY scripts/assemble-docs-mcp-runtime.js ./scripts/
COPY packages/core/src/errors.js ./packages/core/src/
COPY packages/docs-mcp ./packages/docs-mcp
COPY site/claims.json ./site/
COPY docs ./docs
COPY *.md ./

# Assemble the deterministic read-only corpus: every root *.md, every docs/**.md,
# site/claims.json and docs/benchmarks/jobs.json, plus a manifest carrying a
# SHA-256 fingerprint of the whole set. The exclusion of docs/plans/ (ExecPlans
# describe intended work, not capability) is applied here by the same code that
# applies it in the server — not by a second list at the packaging layer — so
# docs/plans/ never reaches the runtime stage. The manifest is printed to the
# build log as build-time evidence.
RUN node scripts/assemble-docs-mcp-runtime.js

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

LABEL org.opencontainers.image.title="Accordo Docs MCP" \
      org.opencontainers.image.description="Read-only MCP server for the Accordo CRM framework's documentation, claims ledger and jobs index. Opens no database and holds no customer data." \
      org.opencontainers.image.source="https://github.com/khaoss85/agent-crm" \
      org.opencontainers.image.url="https://accordo.dev" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0"

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# package.json is copied for exactly one reason: it declares "type": "module",
# without which Node would load this ESM import graph as CommonJS. It also
# carries engines.node. It declares no dependencies, so nothing is installed.
COPY --from=corpus /src/package.json ./

# The server and the single core module it imports (errors.js) — nothing else
# from packages/. packages/mcp (the CRM server, which does open a database) and
# packages/cli are deliberately absent, so this image could not start them even
# if something asked it to.
COPY --from=corpus /src/packages/core/src/errors.js ./packages/core/src/
COPY --from=corpus /src/packages/docs-mcp/bin ./packages/docs-mcp/bin
COPY --from=corpus /src/packages/docs-mcp/src ./packages/docs-mcp/src

# The assembled corpus lands at /app, which is exactly the documentation root
# the server derives from its own location
# (packages/docs-mcp/src/server.js: DEFAULT_ROOT = ../../../). No environment
# variable, no path argument, no runtime discovery.
COPY --from=corpus /src/packages/docs-mcp/runtime-corpus/ ./

# Everything above is owned by root and copied with default (read-only for
# others) permissions. Dropping to the unprivileged user therefore also makes
# the application unable to modify its own code or its corpus: the server is
# read-only by filesystem permission as well as by design.
#
# Numeric rather than the `node` name the base image gives uid 1000, so a host
# that enforces runAsNonRoot can resolve it without reading /etc/passwd.
USER 1000:1000

# Build-time self-test, run AS THE UNPRIVILEGED USER, so a broken image fails
# here rather than failing a directory's introspection. It performs the same
# exchange a scanner performs — initialize, then tools/list — over stdio, and
# asserts that all three tools are announced. stdin closes, so the server
# exits 0. Written without a pipe so the build does not depend on pipefail.
RUN set -eu; \
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"build-self-test","version":"0"}}}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
      > /tmp/self-test-request.jsonl; \
    node packages/docs-mcp/bin/server.js \
      < /tmp/self-test-request.jsonl \
      > /tmp/self-test-response.jsonl; \
    grep -q '"search_docs"'    /tmp/self-test-response.jsonl; \
    grep -q '"get_capability"' /tmp/self-test-response.jsonl; \
    grep -q '"check_job"'      /tmp/self-test-response.jsonl; \
    rm -f /tmp/self-test-request.jsonl /tmp/self-test-response.jsonl

# No EXPOSE: this is a stdio server. It binds no port and listens on no socket.
# No network access is required at build time beyond pulling the base image,
# and none at all at runtime — the container can be run with `--network none`.

# No HEALTHCHECK is possible for a stdio server: liveness is the process itself
# and the JSON-RPC exchange on its own stdin/stdout. Declared explicitly so the
# absence reads as a decision rather than an oversight.
HEALTHCHECK NONE

# Exec form, no shell of our own, so signals reach Node directly. The server
# installs its own SIGINT/SIGTERM handlers and spawns no child processes, so
# running as PID 1 needs no init shim.
#
# CMD rather than ENTRYPOINT, and the base image's inherited
# ENTRYPOINT ["docker-entrypoint.sh"] is kept rather than reset — deliberately,
# not by oversight. That script ends in `exec "$@"`, so Node still becomes PID 1
# and still receives signals directly; keeping it means a host that supplies a
# bare script path instead of a full command still starts the server. A host
# that supplies a full command replaces this CMD cleanly.
CMD ["node", "packages/docs-mcp/bin/server.js"]
