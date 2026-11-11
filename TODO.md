# TODO — 2026-11-10 push

The single source of truth for this push. Check a box only with evidence next
to it: a test name, a screenshot path, a commit SHA, or a CI or Acceptance run
ID. Add new findings as boxes, and never delete one; strike it through with a
reason instead.

Rules:
- home-k8s changes go through GitOps only. That repo is public, so SOPS-encrypt
  every secret and never print one.
- Implementation slices go to pi workers (`--model qwen3-8-flash-next`, pi-orch
  skill). Review and commit their work yourself.
- Commit small and push to main.
- Follow AGENTS.md and the spec, and write an ADR wherever the spec calls for
  one.

## 1. Collective connection (deployed env)
Finding (2026-11-10): the assistant returns 502 `malformed_completion`. The
model `david-birks/qwen3-8-27b` is offline. The key itself exists (48 chars in
`communication-worker-secrets`).
- [x] Set COMMUNICATION_ASSISTANT_MODEL and COMMUNICATION_MODEL_CHAT_MODELS to
      `qwen3-8-flash-next` (online) in `apps/communication/communication.yaml`.
      Evidence: home-k8s d0fcb5d, applied by Flux (apps kustomization at d0fcb5d).
- [x] Verify that the worker key authenticates. If it doesn't, re-encrypt
      LLMC_API_KEY (from ~/.bashrc) into `communication-worker-secrets` without
      printing it. Evidence: 2026-11-11, the cluster key returned HTTP 200 on
      chat/completions for qwen3-8-flash-next (key read into a shell var, never printed).
- [x] An assistant turn succeeds in the deployed app (screenshot).
      Evidence: "How many workers are online right now?" → "1 worker is online right now",
      screenshot /tmp/claude-1000/-home-david-dev-eg-llm-collective/03ca2e2d-7f08-4df0-8426-d927c41b5773/scratchpad/side.png.
- [x] Note for the user: the ASR model is `david-birks/qwen3-asr-1-7b` (alias
      `qwen3-asr-1-7b`). Also wired as COMMUNICATION_SPEECH_MODEL, with a decision model
      (qwen3-8-flash-next): home-k8s eaa77a2.
- [ ] Make the assistant's failure mode clearer: an offline model should
      surface as "model unavailable", not `malformed_completion`.

## 2. Assistant UI
- [ ] When a thread opens in the sidebar, its top bar is flush with the top.
- [x] No-decision-model state: remove "fixed table decides" and write copy
      that makes sense. Evidence: f0a14e3 ("built-in rules flag risky changes"), SetupChecklist.test.tsx.
- [x] "don't ask" uses the same capitalization as its sibling controls. Evidence: f0a14e3
      (pills read "Ask every change / Ask when risky / Don't ask"), types.test.ts.
- [ ] Full screen collapses the far-left nav by default, and leaving full
      screen restores it.

## 3. Search (CommandPalette)
- [x] The box is vertically centered. Evidence: e9624ea.
- [x] Clicking outside the box closes it. Evidence: e9624ea, CommandPalette.test.tsx
      "closes on a press on the dimmed backdrop…".
- [x] Escape closes it wherever focus is. Evidence: e9624ea, same test (Esc on body).

## 4. Catch-up
- [ ] Interrogate the prompt and the tool set, then rewrite them so the output
      is what someone needs to get back up to speed.
- [ ] Seed realistic fixtures (runs, conversations, approvals, failures and
      merges) for four windows: a few minutes, an hour, a day and several
      days. Add a 7-day window too.
- [ ] Add one integration test per window.
- [ ] Add an LLM-graded or snapshot eval of usefulness.
- [ ] Keep a single depth for now, with no gauge.

- [ ] Finding (deployed): Operations lists 35 dead worker pods above the one live
      worker. Covered by the section 8 redesign.
- [ ] Finding: CI audit failed on GO-2026-6859 (net/http). Bumped Go to 1.27.4 in
      ceafd03; confirm CI is green.

## 5. Assistant end-to-end exercise
- [ ] Run Playwright against the real model and hunt for errors and visual or
      UX nonsense. Log each finding here as a box.
- [ ] Fix every finding and add a regression test for each.

## 6. Workflows page and templates
- [ ] Give the Workflows page a visual and UX pass.
- [ ] Template: Matt Pocock's skills preloaded (github.com/mattpocock/skills).
- [ ] Template: poteto's **pstack** packaged through APM. Upstream:
      github.com/cursor/plugins/tree/main/pstack (Lauren Tan / @poteto,
      Cursor). Open Pstack (github.com/ericlitman/open-pstack) is the
      Claude Code/Codex translation to borrow from. Not gstack.
- [ ] Template: implement, then review with Codex.
- [ ] Wire the Claude subscription through the existing OAuth token
      (ADR-0040).
- [ ] Put the Codex subscription's `~/.codex` auth into a SOPS secret (the
      user approved this) and mount it for the worker the way the Claude token
      is mounted.
      Finding 2026-11-11: this machine has NO Codex login (`codex login status` →
      "Not logged in", no ~/.codex/auth.json), so there is nothing to copy. Also, a
      copied ChatGPT login shares one rotating refresh token with wherever else it is
      used, which goes stale like the Claude login did (docs/home-cluster.md). Plan:
      a writable CODEX_HOME on the worker plus a one-time `codex login --device-auth`
      inside the pod that the user approves in a browser. The worker needs the user
      for that step.

## 7. Identity
- [ ] The bottom-left user menu shows the avatar and name from the tsidp OIDC
      claims (picture, name), falling back to initials.
- [ ] Add a simple Profile page.
- [ ] Write an ADR for an extensible multi-provider OIDC layer (Tailscale
      tsidp plus Azure Entra).
- [ ] Implement the provider abstraction if it's small.

## 8. Operations
- [ ] Redesign Operations (currently a 14-line page) into a useful operations
      and settings page: health, workers, queue, models, secrets status and
      integrations.
- [ ] If the visual language needs it, file a `claude-design-needed` issue per
      the design-heavy rule.

## 9. Two run modes: single container and Kubernetes native
- [ ] Simple mode: one container or Go binary runs serve plus worker, with
      agents in nono sandboxes in-process. Document it and make sure it works.
- [ ] Kubernetes mode: the worker orchestrates per-attempt agent pods with
      nono inside them, using minimal RBAC and network policy. Check this
      against the research in `docs/` (commit f918881) and write an ADR.
- [ ] Ship a deliberately simple Helm chart with minimal boilerplate.
- [ ] Test it in kind: install, run a pipeline that spawns an agent pod, and
      check that RBAC least privilege holds. Wire it into CI if that's cheap.

## 10. Pi as an agent in the deployed env
- [ ] Register pi as an agent (ACP adapter or launcher), pointed at the
      Collective with `qwen3-8-flash-next`.
      Progress: the `pi` launcher already exists (ADR-0059, pi-acp 0.0.34, in the
      worker image). Worker env and the key file were wired in home-k8s 253c8be.
      Still to do: a Pi agent profile in the deployed app.
- [ ] Deploy it to home-k8s and complete one real run with pi (run ID).

## 11. APM collections attached to agent profiles
User's vision: named APM collections (bundles of skills, instructions and MCP)
that can be attached to different ACP agent setups. Today the spec
(04-agent-runtime.md) gives AgentProfileRevision a single `apm_package_ref`.
- [ ] Research how upstream APM (microsoft/apm) handles collections and
      composition: dependencies in apm.yml, collection manifests and lock
      behavior. Note the sources in `14-research-notes.md` or `docs/`.
- [ ] Write an ADR with a design for "collections" as a first-class library
      item. A profile references one or more collections; the worker resolves
      them into one APM manifest and lock per attempt and records the digest.
      Cover ordering and conflict rules and per-launcher targeting.
- [ ] Implement it: a collections CRUD API, the UI in Library or Agents for
      attaching collections to an agent profile, and worker resolution with
      tests (spec test 7: two different skill sets, isolated between sessions).
- [ ] Rebase the section 6 templates (Matt Pocock, poteto) on collections.

## Done when
- [ ] Every box above is checked with evidence.
- [ ] CI and Acceptance are green on the final SHA.
- [ ] communication.beluga-wyvern.ts.net shows the fixes (screenshots).
