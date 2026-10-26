// Package artifacts is the byte backend behind an Artifact: one interface, a
// content-addressed local-filesystem backend for the dev/lab topology, and an
// S3-compatible backend for deployments whose API replicas do not share a
// directory (ADR-0020, communication-spec/02-system-architecture.md
// "Data / infrastructure plan", 09-api-events-data.md "artifacts").
//
// What lives here and what does not:
//
//   - Bytes live here; rows live in PostgreSQL. An artifact row (migration
//     00004, table `artifacts`) is the index into this package and never holds
//     content — 02 forbids multi-MB payloads in database rows.
//   - Keys are built here, from server-side ids only (project id, kind,
//     digest). Nothing in this package accepts a client-supplied path or
//     storage key, which is what makes a path-traversal bug structurally
//     impossible rather than filtered (ADR-0020 Security).
//   - Authorization does NOT live here. This package answers "give me the
//     bytes for this key", never "may this user have them" — that is a project
//     predicate in SQL (internal/store/postgres/artifact*.go) plus the role
//     table in ADR-0020 D3, applied by internal/api.
//   - Publication does not live here either: Put writes bytes, and a `ready`
//     row plus its `artifact.created` event are a separate, turn-fenced
//     database transaction (ADR-0016 § 9.2). A Put with no row behind it is an
//     orphan for the sweep, not a published artifact.
//
// Content addressing is the property everything else here leans on: the key
// contains the SHA-256 of the bytes, so a second Put of the same content is a
// no-op, a retry cannot double-count bytes (the table's owner-scoped dedupe
// indexes from migration 00019 mirror it per run/turn — and since identical
// bytes owned by different runs are different rows over ONE key, a byte
// delete must first prove no non-deleted row still references it, which is
// postgres.BytesStillReferenced's job), and Stat can detect a file changed
// under its own key — the check that makes "immutable" an observable fact
// instead of a claim.
//
// No SDK types appear here, and no type in internal/domain depends on this
// package's error values beyond the sentinels below (AGENTS.md dependency rule).
package artifacts
