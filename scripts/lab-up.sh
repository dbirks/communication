#!/usr/bin/env bash
# lab-up.sh — bring the communication-m4 lab up FROM THIS CHECKOUT.
#
# The repo-tracked, portable sibling of the orchestrator's host-side
# lab_reset.sh. On a GitHub Actions runner the checkout IS the clean export
# of the pinned revision, so the worktree juggling lab_reset.sh does (a
# detached clean worktree at LAB_REF so workers' in-progress edits never
# reach the images) has no meaning here; everything else is the same script:
#
#   1. create the .harness bind dirs and regenerate the M4 fixture repo,
#   2. `docker compose -p communication-m4 -f compose.yml -f compose.harness.yml
#      -f compose.m4.yml -f compose.real.yml up -d --build`,
#   3. wait for the three readiness URLs (18091 through the LB, 18092/18093
#      direct — the ports compose.m4.yml publishes for this project),
#   4. on failure: print `ps` and a logs tail before exiting non-zero.
#
# Usage (from anywhere; it cd's to its own repo root):
#   COMMUNICATION_LLM_API_KEY_HOST_FILE=/path/to/key-file bash scripts/lab-up.sh
#
# Environment:
#   HOST_UID / HOST_GID        default to `id -u` / `id -g` (compose.harness
#                              requires them to match the file owners).
#   COMMUNICATION_LLM_API_KEY_HOST_FILE
#                              REQUIRED by compose.real.yml: a readable host
#                              file holding the model-gateway key, mode 0600.
#                              Falls back to $HOME/.config/communication/
#                              llmc-api-key when present (the documented host
#                              location, same fallback as e2e/tests/helpers.ts).
#   LLMC_API_KEY               compose.real.yml interpolates the key VALUE
#                              too; when unset it is read from the host file
#                              (never printed, never placed on a command line).
#   KEEP=1                     skip the project-scoped `down -v` (never prune).
#   DOCKER                     docker invocation (default `docker`; set it to
#                              e.g. `sudo docker` on hosts whose user is not
#                              in the docker group).
#
# Exit codes: 0 lab ready; 1 lab failed to come up; 2 precondition missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKER="${DOCKER:-docker}"
export HOST_UID="${HOST_UID:-$(id -u)}" HOST_GID="${HOST_GID:-$(id -g)}"

# ---- key file (§ compose.real.yml's required host variables) -----------------
key_file="${COMMUNICATION_LLM_API_KEY_HOST_FILE:-}"
if [ -z "$key_file" ] && [ -r "$HOME/.config/communication/llmc-api-key" ]; then
    key_file="$HOME/.config/communication/llmc-api-key"
    export COMMUNICATION_LLM_API_KEY_HOST_FILE="$key_file"
fi
if [ -z "$key_file" ] || [ ! -r "$key_file" ]; then
    echo "lab-up: COMMUNICATION_LLM_API_KEY_HOST_FILE must name a readable file" \
        "holding the model-gateway key (compose.real.yml refuses to render" \
        "without it). On CI the acceptance workflow writes it under \$RUNNER_TEMP." >&2
    exit 2
fi
# compose.real.yml marks LLMC_API_KEY required (:?) as well — the value must
# equal the file's contents. Fill it from the file when the caller did not
# export it: a shell variable assignment, so the key never becomes an argv
# word of any process and nothing here prints it.
if [ -z "${LLMC_API_KEY:-}" ]; then
    LLMC_API_KEY="$(cat "$key_file")"
    export LLMC_API_KEY
fi

# ---- host preparation (compose.harness.yml / compose.m4.yml's bind roots) ----
# Docker creates a missing bind source root-owned; these must be ours, exactly
# as e2e_m4_exit.py's prepare_host_dirs() says. The agent-login trees the
# harness overlay binds (${HOME}/.claude, ${HOME}/.codex) are created empty on
# machines that have none (a fresh CI runner) so the bind resolves; a worker
# then honestly fails closed on the missing login rather than the lab failing
# on a missing directory.
mkdir -p .harness/workspaces .harness/home-a .harness/home-b .harness/remotes \
    .harness/apm-upstream .harness/m4-fixtures/bin "$HOME/.claude" "$HOME/.codex"
bash e2e/m4/make_fixture_repo.sh .harness/m4-fixtures >/dev/null

C=("$DOCKER" compose -p communication-m4 -f compose.yml -f compose.harness.yml
   -f compose.m4.yml -f compose.real.yml)

# Fresh stack by default (this is the "reset" half of lab_reset.sh); KEEP=1 is
# the only way to bring lab state forward. Project-scoped only — never prune.
if [ "${KEEP:-}" != 1 ]; then
    "${C[@]}" down -v --remove-orphans
fi
"${C[@]}" up -d --build

# ---- readiness ----------------------------------------------------------------
# lab_reset.sh's wait: 120 tries × 3 s, both replicas direct AND the LB.
for _ in $(seq 120); do
    if curl -sf -o /dev/null http://127.0.0.1:18092/api/v1/system/readiness \
        && curl -sf -o /dev/null http://127.0.0.1:18093/api/v1/system/readiness \
        && curl -sf -o /dev/null http://127.0.0.1:18091/api/v1/system/readiness; then
        echo "lab ready ($(git rev-parse --short HEAD 2>/dev/null || echo unknown-rev))"
        exit 0
    fi
    sleep 3
done

echo "lab NOT ready"
"${C[@]}" ps -a || true
"${C[@]}" logs --no-color --tail=200 || true
exit 1
