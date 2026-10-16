# Agent egress: what D-021 would take (spike, 2026-10-16)

Question (D-021 **Provisional**, ADR-0019 D3, `docs/compatibility/SANDBOX.md` row 8): an agent turn
must reach its model API and nothing else. Measured in throwaway `communication-worker:dev` runs
(`nono 0.80.0`, Landlock V6, uid `worker`); nothing installed.

## Measured facts

**nono 0.80.0 is not an on/off switch — it ships a domain-allowlist proxy.** `nono run --help`:

```
      --block-net
          Block outbound network access (allowed by default)
      --allow-domain <DOMAIN_OR_URL>
          Add a domain to the proxy allowlist (repeatable). Use a plain hostname for unrestricted access, or a URL with a path glob to restrict to specific endpoints
      --deny-domain <DOMAIN>
          Block a domain through the proxy. Evaluated before the allowlist. Supports wildcards
```

`nono proxy --help`: "Run the network filtering / credential proxy as a standalone server"
(`--listen 127.0.0.1`, `--port <0 = OS-assigned ephemeral port>`, `--no-auth`, `--pass`, `-p
<NAME_OR_PATH>` "loads its network/credential settings"; `nono run --help` adds `--proxy-port <PORT>
"(default: OS-assigned)"`). `nono profile schema` → `$defs.NetworkConfig`: `block`, `allow_domain`,
`deny_domain`, `network_profile`, `connect_port`, `open_port`, `listen_port`, `upstream_proxy`,
`upstream_bypass`, `no_proxy`, `tls_intercept`, …

**Allowlist and filesystem hold together** — shipped-equivalent profile (bytes of
`worker/sandbox/profiles/communication-command.json`, renamed `communication-agent`, plus
`"network": {"allow_domain": ["example.com", "api.anthropic.com"]}`), in one sandboxed child:

```
SHADOW EACCES     INSIDE ok     OUTSIDE EACCES
NET https://example.com http=200
NET https://example.org ERR Request was cancelled.
NET anthropic http=405            # GET /v1/messages → 405 = the real API answered
```

Identical from CLI `--allow-domain` and from the profile file; `--deny-domain '*.example.com'` beats
the allowlist. **Proxy *and* kernel; hostname entries are tunnels, not MITM:** raw
`net.connect(443,"93.184.216.34")` → `RAWTCP ERR EACCES`; `dns.lookup("example.com")` → `EAI_AGAIN`
(the proxy resolves; `no_proxy="localhost,127.0.0.1"` only). Manual `CONNECT example.com:443` with
the injected `Proxy-Authorization` → `HTTP/1.1 200 Connection Established`, then `ALPN=h2 issuer
CN=Cloudflare TLS Issuing ECC CA 3` — real upstream cert, HTTP/2 end to end; `CONNECT
example.org:443` → `HTTP/1.1 403 Forbidden: host example.org:443 is not in the allowlist`. **A
hostname allowlist needs no CA.** Only glob entries intercept: `--allow-domain
'https://example.com/allowed/**'` sets `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` to a generated
intercept CA under `…/sessions/intercept-*/`, `/allowed/x` → `http=404` (upstream), and `/secret` →
`http=403` (proxy). Injected env: `HTTP(S)_PROXY=http://nono:<token>@127.0.0.1:<port>`,
`NONO_PROXY_TOKEN`, `NODE_USE_ENV_PROXY=1`.

**Fail-closed + observability.** `--block-net` + allowlist aborts (`Configuration parse error:
--block-net and --allow-domain are contradictory: domain filtering requires proxy mode`); a grant
overlapping nono's state root aborts the child (`Sandbox initialization failed: Refusing to grant
'/tmp/w' … overlaps protected nono state root`), so nono's `$HOME/.local/state/nono` must stay
outside every grant (ADR-0019's launcher HOME). Denials are journalled by `nono audit show <id>
--json` (`network_events`, `count=3`): `{"mode":"connect","decision":"deny",
"denial_category":"host_denied","target":"example.org","port":443,"reason":"host example.org:443 is
not in the allowlist"}`, alongside `{"decision":"allow","target":"example.com","port":443,
"method":"CONNECT"}`; `--diagnostics-json` on the same run records `denials: []`, so diagnostics is
*not* the surface. N-c/N-d surfaces: `nono profile show <path>` prints `Linux AF_UNIX mediation:
Pathname` + `allow_domain: example.com, api.anthropic.com`; `nono run -v --dry-run` prints `net
proxy`; `nono profile validate <FILE>` (positional) → `Result: valid`. No other proxy binary in the
image (`ls /usr/local/bin /usr/bin | grep -i 'proxy|squid|mitm|envoy|caddy'` → empty). **Not
measured:** a real `claude-agent-acp` turn under an allowlist — no harness credentials in a
throwaway container, so the host set Claude Code actually needs is unproven.

## Designs

**A. Allowlist in the Communication profile** — give `profileSource`
(`internal/sandbox/nono/profile.go`, no `network` field today) `allow_domain`/`deny_domain` and make
`Profile.NetworkEnforced` a tri-state `open|allowlisted|denied`, so the digest commits to the host
set. Cost: schema change + `launchplan.go`'s `BlockNet` exclusion guard +
`SandboxCapabilities.network="allowlisted:…"` + an ADR amending D3. Proves: all of the above in one
process, argv shape unchanged, policy auditable per run. Risk: the host list is a product decision
(D-025) and a missing host degrades a turn silently.

**B. Worker-owned sidecar** — one `nono proxy --port 0 --allow-domain …` per worker, agent runs
`--block-net --open-port <proxy>` with `HTTPS_PROXY`/`NODE_USE_ENV_PROXY=1` injected by the worker.
Measured: `SIDECAR-ALLOW http=200`, `SIDECAR-DENY ERR Request was cancelled.`, `SIDECAR-BYPASS ERR
EACCES`. Cost: a supervised long-lived process, port+token handoff, a `--no-auth`/`--pass` decision,
and every client convention (`git`/`npm` proxy env) becomes ours. Buys: one policy across turns,
denials in one log, works for launchers nono cannot wrap.

**C. Per-profile seeding** — the allowlist travels with the AgentProfileRevision
(`…-egress-model-only` vs `…-egress-model-plus-packages`); enforcement identical, cost is profile
proliferation and a host-list admin surface; preferred once a second host set is real.

**Lab test that flips row 8** (rerun the SANDBOX.md 2026-10-16 evaluation verbatim in
`communication-m4-worker-a-1` under A, same `sandbox.verified` assertions): rows 1, 2, 3, 6, 7 stay
`PASS`; row 8 splits into **8a** `fetch('https://api.anthropic.com/v1/messages')` → `http=405` and
**8b** `fetch('https://example.com')` → denial, with that run's `network_events`
`{"decision":"deny","denial_category":"host_denied"}` line captured; plus a real `claude-agent-acp`
turn completing end-to-end (the list is sufficient) and `network: "allowlisted"`. Then D-021 may
move Provisional → lab-accepted; until 8b is observed, `network_enforced: false` stays the honest
label.

**Recommendation: A.** Never a config default: a run may say `allowlisted` only with an observed 8b
denial in the same run. Choose B only if a second launcher needs one shared policy.
`communication-agent-egress-denied`/`communication-command` (`--block-net`) stay untouched — case
13's denial row rests on them.
