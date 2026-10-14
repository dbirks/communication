# ADR-0005 — Frontend toolchain: Vite + React + TypeScript, Tailwind, pnpm, oxlint/oxfmt

- **Date:** 2026-10-14
- **Status:** Proposed
- **Owners:** project owner
- **Related decisions / contracts:** D-012 (REST + SSE for browser APIs), `communication-spec/10-ui-design-handoff.md`,
  ADR-0004 (CI that builds the UI), ADR-0007 (repository layout — where `ui/` lives)

## Context

`communication-spec/02-system-architecture.md` shows a "React SPA / Browser" as the client, and
`communication-spec/10-ui-design-handoff.md` briefs a separate design agent for information
architecture, states and design tokens. The spec mandates the *framework family* (React) and nothing
else: no bundler, styling approach, package manager or linter is fixed by any D-xxx entry.

Two constraints shape the choice. First, 10-ui-design-handoff is explicit that visual design is the
design agent's job and that backend contracts must not be invented in the UI — so the toolchain
should keep visual decisions in a theme/token layer rather than smeared through components. Second,
ADR-0004's CI must be able to install, lint, typecheck and build the UI from a committed lockfile
without network drift. `ui/` does not exist yet, so every claim below is a preference to be proven by
the first build.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Vite + React + TypeScript + Tailwind + pnpm + oxlint/oxfmt (chosen)** | Vite is the smallest dev-server/build story for an SPA that talks to a separate Go API; Tailwind keeps design tokens in config, which matches a design-agent-owned visual system; pnpm's lockfile + `--frozen-lockfile` gives a deterministic CI install; oxlint/oxfmt are fast single-binary tools | Two relatively young tools (oxlint, oxfmt) with smaller plugin ecosystems than ESLint; Tailwind class strings are hard to review as "design system" evidence; the whole stack is unpinned until CI runs | Not yet exercised — the first `pnpm --dir ui install --frozen-lockfile && pnpm --dir ui build` in CI will prove it |
| ESLint + Prettier instead of oxlint + oxfmt | Mature, plugin-rich, the ecosystem default; far more rule coverage (a11y, react-hooks) | An order of magnitude slower on large trees; config/plugin dependency sprawl; Prettier and ESLint fix overlap | Compared as the incumbent default; no UI code exists to migrate |
| npm or yarn instead of pnpm | npm ships with Node; yarn workspaces are familiar | No content-addressed store, slower and chattier installs in CI; yarn 1 vs berry is its own decision | Owner preference; install-time difference to be observed on first CI run |
| CSS Modules or hand-written CSS instead of Tailwind | No build-time dependency, styles colocated and explicit | Design tokens become a hand-maintained convention; the design agent's token system has no natural home; more CSS to review | 10-ui-design-handoff asks for tokens/typography/layout as a proposed design system |
| Next.js (or another meta-framework) | SSR/routing conventions, rich feature set | The SPA here is a client of a separate Go API behind one origin; SSR adds a Node runtime the deployment model (ADR-0004 images) does not need | 02-system-architecture shows a static browser client, not a server-rendered app |

## Decision

The project owner chooses, as preference:

1. **Vite** building a **React + TypeScript** SPA in `ui/`, talking to the API over the REST + SSE
   contract in D-012. No server-rendered runtime.
2. **Tailwind CSS** for styling, with all visual decisions expressed as design tokens in the
   Tailwind config so the design agent owns one layer.
3. **pnpm** as package manager; `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`.
4. **oxlint** for linting and **oxfmt** for formatting, replacing ESLint and Prettier; CI runs
   `pnpm --dir ui exec oxlint` and `pnpm --dir ui exec oxfmt --check`.

All four are pinned to exact versions in `ui/package.json` (no caret ranges for the toolchain itself).

## Consequences

Positive: fast local and CI loop, one place for visual decisions, reproducible installs, and the UI
build stays independent of Go release jobs. Limitations and risks: `communication-spec/10-ui-design-handoff.md`
requires visual decisions to stay out of the core engine, and a utility-first CSS approach can leak
that discipline if classes are hardcoded in engine-owned components — mitigated by keeping components
thin and tokens central. **oxfmt is younger than Prettier**: formatting output can change between
patch releases, so formatting churn on upgrade is a real risk; exact version pinning plus a
format-only commit convention is the mitigation, and the fallback is a one-time switch back to
Prettier with no source-layout change. oxlint's rule set is narrower than ESLint's; missing rules are
covered by `tsc --noEmit` and Playwright checks (ADR-0006).

## Security/privacy

The UI is a browser-side client of an authenticated API: no secrets in the bundle, no tokens in
`localStorage` where an HttpOnly session cookie (02 §identity) suffices, and build-time env
interpolation limited to non-secret base URLs. `pnpm install --frozen-lockfile` prevents a CI build
from silently accepting a changed dependency graph; lockfile diffs are reviewable. pnpm's store must
not be populated from an unregistered registry — the registry is pinned in `.npmrc`. oxfmt/oxlint
never see secrets because they run on source, not configuration.

## Verification

No commands have been run against a UI that does not yet exist. The following will prove the choices:
CI run of `pnpm --dir ui install --frozen-lockfile`, `pnpm --dir ui test`, `pnpm --dir ui exec oxlint`,
`pnpm --dir ui exec oxfmt --check`, `pnpm --dir ui exec tsc --noEmit` and `pnpm --dir ui build`
green on one commit; a deliberately edited `ui/package.json` without a matching lockfile update
confirming CI fails closed on `--frozen-lockfile`; a built bundle scanned for the absence of any
secret or `.env` value; and an upgrade commit that bumps oxfmt, showing whether formatting churn is
confined to a single reviewable diff.

## Migration/rollback

All four choices are reversible inside `ui/` with no effect on the Go engine. ESLint/Prettier returns
by adding devDependencies and configs and deleting the oxlint/oxfmt invocations from CI — oxlint and
oxfmt do not encode information that Prettier cannot reproduce. npm or yarn returns via `pnpm
import`. Tailwind can be unwound incrementally because it introduces only class strings plus a token
config; a CSS Modules migration is a per-component change. Vite to another bundler is a config swap;
moving to Next.js would need a new ADR because it changes the deployment model in ADR-0004.
