#!/usr/bin/env bash
# fetch-release-assets.sh — pre-download the GitHub release tarballs that
# worker/Dockerfile fetches in its `executionbin` stage into .release-assets/,
# so image builds use a local copy instead of the release-asset CDN — which
# intermittently returns multi-minute 504s and has red the acceptance runs
# (observed on the nono tarball URL alternating 200/504; curl retries are
# already in place and stay in place, they just don't survive a long outage).
#
# ONE SOURCE OF TRUTH: versions, digests, asset URLs and the curl retry flags
# are all PARSED FROM worker/Dockerfile (its `ARG <NAME>=…` lines and the
# "https://github.com/…" release URLs in the fetch stage). Bumping a pin in
# the Dockerfile changes what this script fetches and, through
# hashFiles('worker/Dockerfile'), the CI cache key — no second list to drift.
#
# Verification is never weaker than the Dockerfile's: every downloaded file
# is checked with `sha256sum -c` against the pinned digest and DELETED on
# mismatch. The Dockerfile re-verifies whatever it consumes from the build
# context with the same digest, so a tampered cache file fails the build.
#
# Idempotent: a file that already exists with the right digest is left alone
# (a CI cache hit makes this script a pure no-op). Safe to re-run.
#
# Outage survival: a single curl attempt set (even the Dockerfile's --retry 8 /
# --retry-max-time 600) does not outlast a long CDN 504 window, so each asset
# is retried in an OUTER loop with backoff (15 s, doubling, capped at 60 s)
# for up to FETCH_RELEASE_MAX_SECONDS (default 1200 = 20 min) before the
# script gives up. A sha256 mismatch is NOT retried — the content arrived and
# did not match the pin, which is a deterministic drift, not an outage — the
# file is deleted and the script fails immediately, exactly as before.
#
# Usage:
#   scripts/fetch-release-assets.sh                     # -> <repo>/.release-assets/
#   RELEASE_ASSETS_DIR=/tmp/x scripts/fetch-release-assets.sh
#   FETCH_RELEASE_MAX_SECONDS=120 scripts/fetch-release-assets.sh   # shorter retry budget
#
# Exit codes: 0 all assets present and verified; 1 download/verification
# failure (after the retry budget) or a malformed Dockerfile (missing ARG,
# unparsed URL).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="${RELEASE_ASSETS_DOCKERFILE:-$REPO_ROOT/worker/Dockerfile}"
OUT_DIR="${RELEASE_ASSETS_DIR:-$REPO_ROOT/.release-assets}"

[ -r "$DOCKERFILE" ] || { echo "fetch-release-assets: cannot read $DOCKERFILE" >&2; exit 1; }
mkdir -p "$OUT_DIR"
touch "$OUT_DIR/.keep"   # keeps the dir committable so the Dockerfile COPY never fails

get_arg() {  # get_arg NAME -> value of `ARG NAME=value` in the Dockerfile
    sed -n "s/^ARG $1=//p" "$DOCKERFILE" | head -n1 | tr -d '[:space:]'
}

# Retry flags come from the Dockerfile too (same --retry set on every fetch
# there); fall back loudly if its wording ever changes out from under us.
flags_str="$(grep -m1 -oE -- '--retry [0-9]+ --retry-all-errors --retry-delay [0-9]+ --retry-max-time [0-9]+ --connect-timeout [0-9]+' "$DOCKERFILE" || true)"
if [ -n "$flags_str" ]; then
    # shellcheck disable=SC2206  # word-splitting is the point: it is a flag list
    CURL_FLAGS=($flags_str)
else
    echo "fetch-release-assets: WARNING: retry flags not found in $DOCKERFILE, using the known-good set" >&2
    CURL_FLAGS=(--retry 8 --retry-all-errors --retry-delay 15 --retry-max-time 600 --connect-timeout 20)
fi

fail() { echo "fetch-release-assets: $*" >&2; exit 1; }

# Per-asset outer retry budget (survives a multi-minute release-CDN 504
# window that curl's own --retry set cannot outlast). Backoff: 15 s, 30 s,
# then 60 s capped, until the deadline.
MAX_SECONDS="${FETCH_RELEASE_MAX_SECONDS:-1200}"
case "$MAX_SECONDS" in ('' | *[!0-9]*) fail "FETCH_RELEASE_MAX_SECONDS must be a non-negative integer, got: $MAX_SECONDS" ;; esac

# fetch_with_backoff DEST URL — retry the download until MAX_SECONDS elapses.
# Returns 0 on success; 1 only after the budget is exhausted.
fetch_with_backoff() {
    local dest="$1" url="$2"
    local deadline=$(( $(date +%s) + MAX_SECONDS ))
    local backoff=15 attempt=0 now left
    while :; do
        attempt=$((attempt + 1))
        if curl -fsSL "${CURL_FLAGS[@]}" -o "$dest" "$url"; then
            if [ "$attempt" -gt 1 ]; then
                echo "fetch-release-assets: recovered after $attempt attempt(s)"
            fi
            return 0
        fi
        rm -f "$dest"
        now="$(date +%s)"; left=$(( deadline - now ))
        if [ "$left" -le 0 ]; then
            echo "fetch-release-assets: download still failing after $attempt attempt(s) / ${MAX_SECONDS}s: $url" >&2
            return 1
        fi
        if [ "$backoff" -gt "$left" ]; then backoff="$left"; fi
        echo "fetch-release-assets: attempt $attempt failed for ${dest##*/} (CDN 504?), retrying in ${backoff}s (${left}s of budget left)" >&2
        sleep "$backoff"
        backoff=$(( backoff * 2 < 60 ? backoff * 2 : 60 ))
    done
}

# The release URLs are the quoted https://github.com/… strings in the
# Dockerfile (exactly three today, one per asset). Each names a ${X_VERSION}
# ARG; its digest is the ${X_SHA256} ARG of the same prefix.
count=0
while IFS= read -r tpl; do
    tpl="${tpl%\"}"; tpl="${tpl#\"}"
    var="$(printf '%s' "$tpl" | grep -oE '\$\{[A-Z0-9_]+_VERSION\}' | head -n1 || true)"
    [ -n "$var" ] || fail "release URL has no \${X_VERSION} ARG to resolve it: $tpl"
    name="${var#\$\{}"; name="${name%_VERSION\}}"
    version="$(get_arg "${name}_VERSION")"; [ -n "$version" ] || fail "ARG ${name}_VERSION missing"
    sha="$(get_arg "${name}_SHA256")";       [ -n "$sha" ]       || fail "ARG ${name}_SHA256 missing"
    url="${tpl//"\${${name}_VERSION}"/$version}"
    case "$url" in *'${'*) fail "unresolved ARG placeholder in $url" ;; esac
    asset="${url##*/}"

    if [ -s "$OUT_DIR/$asset" ]; then
        if printf '%s  %s\n' "$sha" "$asset" | (cd "$OUT_DIR" && sha256sum -c - >/dev/null); then
            echo "fetch-release-assets: $asset already cached and verified — skipped"
            count=$((count + 1)); continue
        fi
        echo "fetch-release-assets: $asset present but WRONG sha256 — refetching" >&2
        rm -f "$OUT_DIR/$asset"
    fi

    echo "fetch-release-assets: downloading $asset (retry budget ${MAX_SECONDS}s)"
    fetch_with_backoff "$OUT_DIR/$asset.tmp" "$url" \
        || { rm -f "$OUT_DIR/$asset.tmp"; fail "download failed after ${MAX_SECONDS}s of retries: $url"; }
    # Mismatch is deterministic (content arrived, differs from the pin): do NOT
    # burn the retry budget on it — delete and fail, same as before.
    if printf '%s  %s\n' "$sha" "$asset.tmp" | (cd "$OUT_DIR" && sha256sum -c -); then
        mv "$OUT_DIR/$asset.tmp" "$OUT_DIR/$asset"
    else
        rm -f "$OUT_DIR/$asset.tmp"
        fail "sha256 MISMATCH for $asset (pinned ${name}_SHA256) — deleted, refusing to cache it"
    fi
    count=$((count + 1))
done < <(grep -Eo '"https://github\.com/[^"]+"' "$DOCKERFILE")

[ "$count" -gt 0 ] || fail "no release URLs parsed from $DOCKERFILE — the fetch stage changed shape?"
echo "fetch-release-assets: $count asset(s) present and verified in $OUT_DIR"
