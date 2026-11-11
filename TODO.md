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
- [x] When a thread opens in the sidebar, its top bar is flush with the top.
      Evidence: 7f2de80 (the dock is fixed at y=0 even on a scrolled page; every head is 48px), ~/.cache/pi-orch/communication/evidence/asst-fullpage/c-dock-pinned-top-scrolled300.png, AssistantPanel.test.tsx.
- [x] No-decision-model state: remove "fixed table decides" and write copy
      that makes sense. Evidence: f0a14e3 ("built-in rules flag risky changes"), SetupChecklist.test.tsx.
- [x] "don't ask" uses the same capitalization as its sibling controls. Evidence: f0a14e3
      (pills read "Ask every change / Ask when risky / Don't ask"), types.test.ts.
- [x] Full screen collapses the far-left nav by default, and leaving full
      screen restores it. Evidence: 7f2de80, Shell.test.tsx (rail on /assistant, pref not written,
      overlay plus Esc), ~/.cache/pi-orch/communication/evidence/asst-fullpage/a-assistant-fullpage.png.

## 3. Search (CommandPalette)
- [x] The box is vertically centered. Evidence: e9624ea.
- [x] Clicking outside the box closes it. Evidence: e9624ea, CommandPalette.test.tsx
      "closes on a press on the dimmed backdrop…".
- [x] Escape closes it wherever focus is. Evidence: e9624ea, same test (Esc on body).

## 4. Catch-up
- [x] Interrogate the prompt and the tool set, then rewrite them so the output
      (Audit: docs/research/2026-11-catch-up-audit.md. Design: ADR-0081 c549320.)
      is what someone needs to get back up to speed.
      Evidence: audit (docs/research/2026-11-catch-up-audit.md), ADR-0081, brief assembler 0cc463f, headline prompt
      5f94289 (catchup_brief_test.go), chat tools ab16ee4 (tools_test.go).
- [x] Seed realistic fixtures (runs, conversations, approvals, failures and
      merges) for four windows: a few minutes, an hour, a day and several
      days. Add a 7-day window too. Evidence: 15ca227 (catch_up_seed*_test.go, TestCatchUpSeed{15m,1h,1d,3d,7d}).
- [x] (Progress) Brief assembler and route: 0cc463f (catch_up_brief_test.go, real-DB
      catch_up_brief_test.go incl. non-member scoping). The seeder (catchup-seed2), headline
      (catchup-headline), chat tools (catchup-tools) and page (catchup-ui) all landed: 15ca227, 5f94289, ab16ee4, 9d82339.
- [x] Add one integration test per window. Evidence: 576a388 TestCatchUpBriefOverSeeded/{15m,1h,1d,3d,7d} with
      goldens in internal/store/postgres/testdata/catch_up_brief/. It found and fixed heads_up being empty.
- [x] Polish (from the 1d golden): running_now step reads "/implement" (leading slash from the instance key), and
      a run that opened a PR also appears as a separate commit row in shipped. Fold the commit into its PR row.
      Done: 1f6d9b9.
- [x] Add an LLM-graded or snapshot eval of usefulness. Evidence: TestCatchUpUsefulnessEval (gated), with the runs in
      docs/testing/catch-up-eval.md. The first runs FAILED (mean 4.12) on recovered failures being called failing;
      fixed in 2a408d5; the final run PASSES with mean 5.00 over 25 scores (qwen3-8-flash-next as model and judge).
- [x] Keep a single depth for now, with no gauge. The Catch up page renders the brief: 9d82339,
      ~/.cache/pi-orch/communication/evidence/catchup-ui/catchup-brief-1440x900.png, CatchUp.test.tsx.

- [x] Finding (deployed): Operations lists 35 dead worker pods above the one live
      worker. Covered by the section 8 redesign (2faa0a0).
- [x] Finding: CI audit failed on GO-2026-6859 (net/http). Bumped Go to 1.27.4 in
      ceafd03; confirm CI is green. CI 43025622975 on 3d564fb succeeded, govulncheck included.

- [x] Finding (deployed): New profile with launcher Pi defaults to permission `ask`, which can
      never run ("permission mode ask needs a prompting mode for launcher pi"). The UI can't
      set `autonomous_within_sandbox`; it is operator SQL only (ADR-0069). Fix: a Pi profile is
      created as autonomous_within_sandbox + required, and the UI explains why. Fixed: 0c60ab7
      (agent_profiles_test.go, NewProfileDialog.test.tsx).
- [x] Finding (deployed): the New profile name suggestion read "Pi · 2" when no Pi profile existed.
      Fixed: 0c60ab7 (profiles.test.ts).

## 5. Assistant end-to-end exercise
- [ ] Run Playwright against the real model and hunt for errors and visual or
      UX nonsense. Log each finding here as a box.
- [ ] Fix every finding and add a regression test for each.

## 6. Workflows page and templates
- [x] Give the Workflows page a visual and UX pass. Evidence: a31da6a, ~/.cache/pi-orch/communication/evidence/workflows-pass/workflows-1440x900.png,
      workflows-390x844.png, Library.test.tsx.
- [x] Template: Matt Pocock's skills preloaded (github.com/mattpocock/skills). Evidence:
      docs/samples/home/matt-pocock-spec-to-pr.yaml (compiles, samples_test.go); collection seeded per ADR-0084.
- [x] Template: poteto's **pstack** packaged through APM. Evidence: 1d69498 (migration 00033 seeds "pstack (Claude
      Code)": per-skill refs into cursor/plugins harness/pstack/claude-code at 63912a91; apm_collections_test.go,
      flatten_test.go) plus the template docs/samples/home/pstack-feature.yaml (a31da6a). Not gstack.
- [x] Template: implement, then review with Codex. Evidence: docs/samples/home/implement-then-codex-review.yaml
      (fails closed without a Codex login).
- [x] Wire the Claude subscription through the existing OAuth token
      (ADR-0040).
      Evidence: deployed thread 01a1cb61-a0a0-7be3-a48e-977724baf370 (Claude Code profile, Sandbox) completed a turn
      (stop_reason end_turn) on the worker's COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE subscription token.
- [ ] Finding: in that thread, Claude's Bash calls came back "Tool use aborted" three times under permission `ask`.
      Either the prompts never reached the controller in the UI, or they timed out. Investigate the permission
      prompt path for claude threads.
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
      Prepared: home-k8s 3d0ecf7 (persistent CODEX_HOME PVC plus OpenAI egress); the command is in docs/home-cluster.md
      "Codex login". BLOCKED ON THE USER: run that command once and approve the device code.

## 7. Identity
- [x] The bottom-left user menu shows the avatar and name from the tsidp OIDC
      claims (picture, name), falling back to initials. Evidence: 1a3fc5b (tsidp serves
      picture only at /userinfo, so there is a UserInfo fallback), UserAvatar.test.tsx,
      UserMenu.test.tsx.
- [x] Confirm the deployed avatar and name after 1a3fc5b deploys (screenshot). Evidence: deployed 3d564fb,
      ~/.cache/pi-orch/communication/evidence/deployed/deployed-profile.png (Tailscale photo, name, issuer, role).
- [x] Add a simple Profile page. Evidence: 1a3fc5b, /profile, Profile.test.tsx.
- [x] Write an ADR for an extensible multi-provider OIDC layer (Tailscale
      tsidp plus Azure Entra). Evidence: ADR-0083, 4985dee.
- [x] Implement the provider abstraction if it's small. Evidence: a04e05c (providers_test.go: entra admit,
      tid/oid subject, state-provider binding; auth_test.go two IdPs; Login.test.tsx).
- [ ] Follow-up: the Operations overview's sign-in row reads "" when a provider list is configured
      (it uses d.Auth.Issuer). It should list the providers.

## 8. Operations
- [x] Redesign Operations (currently a 14-line page) into a useful operations
      and settings page: health, workers, queue, models, secrets status and
      integrations. Evidence: 8e9d604 (overview plus probe API, system_overview_test.go), 2faa0a0 (UI,
      OperationsBody.test.tsx: 35 offline workers collapsed, tiles ok/warn/bad), ~/.cache/pi-orch/communication/evidence/ops-ui/ops-1440-full.png,
      ops-390-full.png. Deployed: ~/.cache/pi-orch/communication/evidence/deployed/deployed-ops.png (3d564fb).
- [x] If the visual language needs it, file a `claude-design-needed` issue per
      the design-heavy rule. Not needed: the orchestrator designed it inside the existing panel, chip and
      token language (spec in ~/.cache/pi-orch/communication/tasks/ops-ui.md).

## 9. Two run modes: single container and Kubernetes native
- [x] Simple mode: one container or Go binary runs serve plus worker, with
      agents in nono sandboxes in-process. Document it and make sure it works. Evidence:
      docs/run-modes.md, compose.single.yml (7e33017); kind single install is ready and nono
      reports Landlock fs+net (docs/testing/kind-run-2026-11-11.md).
- [ ] Kubernetes mode: the worker orchestrates per-attempt agent pods with
      nono inside them, using minimal RBAC and network policy. Check this
      against the research in `docs/` (commit f918881) and write an ADR.
      ADR-0082 ffc7149; research docs/research/2026-11-k8s-run-modes.md.
- [x] (Progress) The acp.Transport seam is in 9d138e1; the pod launcher is in 8436088 (internal/sandbox/k8s tests, -race).
- [x] Ship a deliberately simple Helm chart with minimal boilerplate. Evidence: 7e33017
      (deploy/helm/communication; helm lint and template are clean for ci/single, split-local and split-kubernetes).
- [ ] Test it in kind: install, run a pipeline that spawns an agent pod, and
      check that RBAC least privilege holds. Wire it into CI if that's cheap.

## 10. Pi as an agent in the deployed env
- [x] Register pi as an agent (ACP adapter or launcher), pointed at the
      Collective with `qwen3-8-flash-next`.
      Progress: the `pi` launcher already exists (ADR-0059, pi-acp 0.0.34, in the
      worker image). Worker env and the key file were wired in home-k8s 253c8be.
      Done: Pi profile 01a1c904 in the deployed app, set by operator SQL to
      autonomous_within_sandbox + required (ADR-0069).
- [x] Deploy it to home-k8s and complete one real run with pi (run ID). Evidence: thread
      01a1c958-a99d-7433-a947-a4a5c1c5856b, turn 01a1c958-a99e-73ae-a6c5-6abb91ca3b29 status
      completed (it ran ls and read in the nono sandbox on the deployed worker), screenshot
      /tmp/claude-1000/-home-david-dev-eg-llm-collective/03ca2e2d-7f08-4df0-8426-d927c41b5773/scratchpad/pi-thread-done.png.
- [x] Finding: the completed Pi turn shows tool calls and "Turn completed" but NO agent reply
      text, so the README summary never appears. Find whether pi-acp's agent_message_chunk is
      dropped, or the model ended with no text after "Retrying the model… (3 attempts)".
      Root cause from the journal: Pi's narration ("Let me check the files…", "The file's name
      is not README.md but simply README…") arrived as `conversation.thought` (the collapsed
      AGENT THOUGHT block), and its `conversation.message.agent` chunks were only "\n\n". The
      final answer never came because the model's retries ran out (the Collective was at
      capacity while 4–5 pi workers ran), and the turn still ended `completed`.
- [x] Fix (small UI): don't render a whitespace-only agent message as an empty "Pi · time" block.
      0c60ab7 (transcript.test.ts).
- [x] Fix: when an agent's retries run out with no final message, the turn shows "ended
      without an answer — the model was unavailable", not a silent "Turn completed". 0c60ab7
      (Transcript.test.tsx).

## 11. APM collections attached to agent profiles
User's vision: named APM collections (bundles of skills, instructions and MCP)
that can be attached to different ACP agent setups. Today the spec
(04-agent-runtime.md) gives AgentProfileRevision a single `apm_package_ref`.
- [x] Research how upstream APM (microsoft/apm) handles collections and
      composition: dependencies in apm.yml, collection manifests and lock
      behavior. Note the sources in `14-research-notes.md` or `docs/`. Evidence:
      docs/research/2026-11-apm-collections-and-harnesses.md (APM 0.12 dropped .collection.yml;
      meta-package apm.yml instead).
- [x] Write an ADR with a design for "collections" as a first-class library
      item. A profile references one or more collections; the worker resolves
      them into one APM manifest and lock per attempt and records the digest.
      Cover ordering and conflict rules and per-launcher targeting. Evidence: ADR-0084, 62c7d48.
- [x] (Backend 1d69498, UI cac3525 + 0ba4ecd, evidence ~/.cache/pi-orch/communication/evidence/apm-coll-ui/; spec test 7
      isolation 10503b3 TestTwoCollectionSetsStageIntoIsolatedCheckouts.)
- [x] Implement it: a collections CRUD API, the UI in Library or Agents for
      attaching collections to an agent profile, and worker resolution with
      tests (spec test 7: two different skill sets, isolated between sessions).
      Evidence: 1d69498 (API, worker flatten and lock), cac3525 (UI), 10503b3 (test 7).
- [ ] Real lock of a seeded collection on the deployed worker (apm 0.34.0 in the image): lock "Matt Pocock skills"
      on a profile in the deployed app and record the digest.
- [x] Rebase the section 6 templates (Matt Pocock, poteto) on collections. Their headers name the seeded collections
      (a31da6a), and 00033 seeds them (1d69498).

- [x] Deployed check at 3d564fb (2026-11-11): palette centered over the full-page assistant, nav collapsed to the
      rail, 48px heads, "Don't ask" pill, speech and decision models configured. Evidence:
      ~/.cache/pi-orch/communication/evidence/deployed/deployed-palette.png, deployed-assistant-full.png.
- [x] Finding (deployed): the Operations "Workflow model steps" row reads "no model id · not set up" because serve
      doesn't carry COMMUNICATION_MODEL_CHAT_*. Either give serve those env vars in home-k8s or have the worker
      report its models in its heartbeat. Fixed via GitOps: home-k8s serve env (model and base URL, no key).

- [ ] Finding (8436088): env-mode secret values can ride inside the pods/exec command, which the API server may
      write to audit logs. Fix: an env-file wrapper (k8s-pod2 queued).

## CI and Acceptance notes
- [x] CI `go` failure TestAllowedRoutesMirrorUIRoutes (from 1a3fc5b /profile) fixed in 2971a35.
- [ ] Acceptance 42975520340 (7ddec9d) failed m4 core-a (C1c, C9g, C10c) and github-loop (issue #650 run
      failed) while 4–5 pi workers saturated the Collective (429 "backend at capacity" in worker
      retries). Re-run on the final SHA with no workers running, and investigate if it still fails.

## Done when
- [ ] Every box above is checked with evidence.
- [ ] CI and Acceptance are green on the final SHA.
- [ ] communication.beluga-wyvern.ts.net shows the fixes (screenshots).
