# ADR-0011 — Apache License 2.0 for the repository

- **Date:** 2026-10-14
- **Status:** Accepted
- **Owners:** project owner
- **Related decisions / contracts:** D-001 (open-source product), ADR-0004 (release and distribution)

## Context

The spec describes Communication as an open-source operating environment (D-001,
`communication-spec/README.md`), but the repository carried no `LICENSE` file.
Under copyright law the absence of a license means no one is granted the right
to use, modify or redistribute the code. It also broke the M0 CI license gate:
`go-licenses check ./...` in `.github/workflows/ci.yml` could not classify the
project's own packages and failed the build. The project owner decided the
license; this ADR records that decision.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Apache-2.0 (chosen)** | Permissive, OSI-approved; explicit patent grant and retaliation clause, important for an AI-agent product touching many toolchains; compatible with the typical dependency licenses in this stack (BSD/MIT, other Apache-2.0) | Longer legal text; requires NOTICE-style attribution preservation; patents are not actually enforced, the grant is a legal posture | Canonical text at https://www.apache.org/licenses/LICENSE-2.0.txt |
| MIT | Extremely short and widely understood, maximally permissive, broad dependency compatibility | No express patent grant or patent-retaliation protection; contributors and users get no patent certainty from the upstream authors | Compared as the minimal permissive baseline |
| AGPL-3.0 | Strong copyleft; anyone offering the software as a network service must share modifications | Network copyleft discourages enterprise adoption of exactly the self-hosted control-plane deployment the spec targets; compatibility friction with Apache-2.0-only dependencies | Rejected by owner as an adoption-limiting constraint |

## Decision

The project owner chose **Apache License 2.0** for all code and documentation
in this repository. The canonical, unmodified license text is committed as
`LICENSE` at the repository root (no copyright-line substitution in the
appendix). SPDX identifier: `Apache-2.0`. Every package under `cmd/`,
`internal/` and the UI falls under the same license.

## Consequences

- The CI `go-licenses` gate now classifies the project's own packages as
  Apache-2.0 and passes; dependencies must remain license-compatible — the
  gate disallows `forbidden,restricted,unknown` license types, so new
  dependencies are checked at PR time.
- Contributions are received under Apache-2.0 (inbound = outbound) as the
  default of contributing under this license; a CLA or DCO process may be
  adopted later and is out of scope here.
- Downstream users may relicense their derivatives under compatible terms;
  patent grant extends to everyone receiving the work under Apache-2.0.

## Security/privacy

No security or privacy implications beyond the legal licensing properties
above. No personal data, secrets or credentials are involved.

## Verification

- `head -3 LICENSE` shows the canonical "Apache License / Version 2.0,
  January 2004" header; `sha256sum LICENSE` recorded in the implementation
  session.
- `go run github.com/google/go-licenses@v1.6.0 check ./...
  --disallowed_types=forbidden,restricted,unknown` exits 0 with the LICENSE
  file present.
- Text source: https://www.apache.org/licenses/LICENSE-2.0.txt (fetched
  2026-10-14).

## Migration/rollback

Relicensing this repository later (e.g. to AGPL or a dual-license) requires
the consent of every contributor whose work remains in the tree, since
Apache-2.0 grants are irrevocable for contributions already merged. Rollback
of this ADR therefore means superseding it prospectively only: remove
`LICENSE`, obtain written consent from all past contributors, and land a new
ADR before the next release (ADR-0004).
