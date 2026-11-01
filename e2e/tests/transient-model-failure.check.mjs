// Unit check for the transient live-model failure (deadline or provider 5xx)
// signatures. Plain node, no test framework, no lab, no network:
//   node e2e/tests/transient-model-failure.check.mjs
import assert from "node:assert/strict";
import { classifyTransientModelFailure } from "./transient-model-failure.ts";

const cases = [
  {
    name: "provider 503 (the observed home-cluster plan failure)",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      "model.chat: llm-collective.e-gineering.com returned http 503: <html><head><title>503 Service Temporarily Unavailable</title></head><body>…503 Service Temporarily Unavailable…</body></html>",
    want: "provider-unavailable",
  },
  {
    name: "provider 502",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      "model.chat: llm-collective.e-gineering.com returned http 502: <html>…Bad Gateway…</html>",
    want: "provider-unavailable",
  },
  {
    name: "provider 504",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      "model.chat: llm-collective.e-gineering.com returned http 504: <html>…Gateway Timeout…</html>",
    want: "provider-unavailable",
  },
  {
    name: "provider refused the connection",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      'model.chat: request to llm-collective.e-gineering.com failed: Post "https://llm-collective.e-gineering.com/v1/chat/completions": dial tcp 10.0.0.7:443: connect: connection refused',
    want: "provider-unavailable",
  },
  {
    name: "provider reset the connection",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      "model.chat: request to llm-collective.e-gineering.com failed: read tcp 10.0.0.9:51234->10.0.0.7:443: read: connection reset by peer",
    want: "provider-unavailable",
  },
  {
    name: "attempt deadline (the pre-existing transient shape)",
    kind: "model.chat",
    errorClass: "timeout",
    detail:
      "model.chat: no completion from llm-collective.e-gineering.com within 2m0s (the attempt's deadline arm, § 4 step 8)",
    want: "deadline",
  },
  {
    name: "deadline text with the old spacing (old contract kept: superset)",
    kind: "model.chat",
    errorClass: "timeout",
    detail:
      "model.chat: no completion from llm-collective.e-gineering.com within 2m0s the attempt's deadline arm",
    want: "deadline",
  },
  {
    name: "http 401 (auth) must NOT match",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      'model.chat: llm-collective.e-gineering.com rejected the completion request (http 401): {"error":{"message":"returned http 401: invalid_api_key"}}',
    want: null,
  },
  {
    name: "http 400 must NOT match",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      "model.chat: llm-collective.e-gineering.com rejected the completion request (http 400): returned http 400 bad request",
    want: null,
  },
  {
    name: "http 500 (not in the 502/503/504 band) must NOT match",
    kind: "model.chat",
    errorClass: "infra",
    detail: "model.chat: llm-collective.e-gineering.com returned http 500: internal error",
    want: null,
  },
  {
    name: "rate limit (distinct arm, retry policy owns it) must NOT match",
    kind: "model.chat",
    errorClass: "infra",
    detail:
      "model.chat: llm-collective.e-gineering.com rate-limited the completion (http 429, Retry-After: not offered); the advancer's retry policy owns the next attempt",
    want: null,
  },
  {
    name: "schema failure (invalid_output) must NOT match",
    kind: "model.chat",
    errorClass: "invalid_output",
    detail:
      "model.chat: llm-collective.e-gineering.com sent a response over 262144 bytes; a completion is one json object",
    want: null,
  },
  {
    name: "process.exec infra failure quoting a gateway 503 must NOT match",
    kind: "process.exec",
    errorClass: "infra",
    detail:
      "process.exec: verify exited 1; stderr: curl failed, model.chat: gateway returned http 503: <html>…503 Service Temporarily Unavailable…</html>",
    want: null,
  },
  {
    name: "missing detail must NOT match",
    kind: "model.chat",
    errorClass: "infra",
    detail: null,
    want: null,
  },
];

for (const c of cases) {
  const got = classifyTransientModelFailure(c.kind, c.errorClass, c.detail);
  assert.equal(
    got,
    c.want,
    `${c.name}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`,
  );
  console.log(`PASS ${c.name} -> ${JSON.stringify(got)}`);
}
console.log(
  `\n${cases.length}/${cases.length} transient live-model failure (deadline or provider 5xx) classification cases passed`,
);
