// Package git is the worker's workspace machinery: per-project mirrors,
// per-scope linked worktrees, the sandbox-facing directory layout, and worker
// volume identity (ADR-0010, ADR-0017 as corrected by
// docs/compatibility/M3-PROBES.md).
//
// Everything here runs in the worker process, unsandboxed (05: the worker is
// never restricted). What this package produces is an *input* to a security
// boundary: the paths it returns become nono grants, so the rules it enforces
// on itself are the rules the sandbox would otherwise have to catch —
// absolute `..`-free paths only, no temp-dir paths at all, one mirror per
// project (never shared across projects, ADR-0010 D3), and worktree admin
// directories read back from git rather than constructed.
//
// The probe suite is the authority for the details that look arbitrary:
//
//   - G1b/G1c  the admin directory is read back with
//     `git rev-parse --absolute-git-dir` (`git worktree list --porcelain`
//     emits no `gitdir:` line for an auto-suffixed worktree).
//   - G10/G10b `git worktree add -b` against one mirror is serialized per
//     mirror: on git 2.39.5 (the worker image's git) six parallel adds
//     succeeded 1–3 times out of 6.
//   - C-META   the layout is <root>/{meta,work}: `nono --allow` is recursive,
//     so worker-only state must be a *sibling* of the granted tree.
//   - V3/V5b   volume identity is (st_dev, st_ino, root path) measured per
//     storage root — st_dev alone calls a replaced named volume the same one.
//   - X1/X2/X4 exclusions live in <mirror>/info/exclude, which the agent
//     cannot write because the mirror is granted read-only.
package git
