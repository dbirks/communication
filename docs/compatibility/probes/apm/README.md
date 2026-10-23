# M0 APM staging probe

Reproducible experiment for D-017 (APM profile layout and preparation
staging — **Spike required**). It answers three questions from
`communication-spec/04-agent-runtime.md` §"Profile → environment →
instance":

1. What does `apm` generate per harness target (`claude`, `codex`)?
2. Does `apm.lock.yaml` + `apm install --frozen` reproduce installs byte-for-byte?
3. Do two prepared sessions stay isolated, and does APM write outside the
   staging directory (into `$HOME`)?

Findings live in [`../../APM.md`](../../APM.md); raw observed output is
[`results.txt`](results.txt).

## Prerequisite: install pinned APM

Never install "latest". Pin v0.34.0 and verify the published digest:

```bash
V=v0.34.0; BASE=https://github.com/microsoft/apm/releases/download/$V
D=$HOME/.cache/communication-lab/m0-apm/download; mkdir -p "$D"; cd "$D"
curl -sLO "$BASE/apm-linux-x86_64.tar.gz" -L -O "$BASE/apm-linux-x86_64.tar.gz.sha256"
sha256sum -c apm-linux-x86_64.tar.gz.sha256   # expect: OK
# published sha256 for this run: 4487af55604b4fa6f4587f3ee6e833b44ce99c491f11069790e4e13e297cde8c
DEST=$HOME/.local/share/communication-lab/apm/0.34.0; mkdir -p "$DEST"
tar -xzf apm-linux-x86_64.tar.gz -C "$DEST" --strip-components=1
ln -sf "$DEST/apm" "$HOME/.local/bin/apm"
apm --version   # Agent Package Manager (APM) CLI version 0.34.0 (65b3b9f)
```

The tarball contains `apm` plus an `_internal/` directory (PyInstaller
layout) — keep them together.

## Fixtures

Local-only packages so no network registry or git host is needed:

- `fixtures/pkg-alpha` — skill `alpha-skill` + instruction, both containing
  the literal token `ALPHA-MARKER`; `fixtures/pkg-beta` — same for
  `BETA-MARKER`.
- `fixtures/consumer-a` depends only on `../pkg-alpha`;
  `fixtures/consumer-b` only on `../pkg-beta` (APM local-path dependencies,
  string form `- ../pkg-alpha`, supported by v0.34.0).

## Run

```bash
bash docs/compatibility/probes/apm/run.sh > docs/compatibility/probes/apm/results.txt 2>&1
```

The script works entirely under `$HOME/.cache/communication-lab/m0-apm/`
(`work/` = staged copies of the fixtures, `fakehome/` = fresh isolated HOME
per target, `logs/` = raw install and harness logs). Every `apm` invocation
runs with `HOME=$fakehome`.

## Checks (one `CHECK <target> <T#> <PASS|FAIL|GAP> <obs>` line each)

| ID | Question |
|----|----------|
| T1 | `apm install --target X` on `consumer-a`: which files appear in the project tree? |
| T2 | Delete generated files, `apm install --frozen --target X`: are lockfile + every generated file byte-identical? |
| T3 | Install `consumer-b` separately: does `ALPHA-MARKER` leak into it, or `BETA-MARKER` into `consumer-a`? |
| T4 | Did APM write anything into the isolated HOME? (shared HOME would leak between sessions) |
| T5 | `sha256sum apm.lock.yaml` — the value Communication would store as `apm_lock_digest`. |
| T6 | Does the real harness (`claude -p` / `codex exec`) report the staged skill when run with cwd = staged project? |

T6 calls the real CLIs once per target (uses your local subscription/auth;
skip by removing those blocks if the CLIs are absent — they then record GAP).
