// THE app-shell + IA redesign acceptance journey: one continuous pass through
// the shipped UI with real agents and no top bar —
//   a. Studio: insert a NEW agent step after plan, created with a brand-new
//      profile through the New-profile dialog (contract C6), with the step's
//      retry policy authored in the same pass (one real retry after the
//      takeover hand-back — see authorStepRetryPolicy);
//   b. Validate + Publish, and the published revision number increments;
//   c. start a run of the new revision from the project's new-run form;
//   d. approve the run's human gate from the project overview's Needs-You fan
//      at PHONE width (390x844), through the shared DecisionBar (finding 05);
//   e. the Run Workbench: a live agent step, Take control (confirm card with
//      its truthful copy, ADR-0043), one prompt, hand back — a new attempt of
//      the step is queued (ADR-0043/ADR-0055 semantics, asserted via API);
//   f. the assistant via ⌘J: add a human approval step to a draft of
//      feature-development, then undo all.
//
// EXECUTION ORDER: e runs before d. journey_step's deterministic long turn
// (its instruction, STEP_INSTRUCTION) settles before the approve gate can
// open, so the takeover must land during that turn — the gate is then
// approved (d) after the hand-back's re-queued attempt has run. That attempt,
// and the ONE retry step a's policy allows it, are both inside the gate window
// GATE_TIMEOUT_MS sizes for: on run 42157903826 the hand-back's attempt gave
// one bad answer, nothing retried it, and the gate never opened.
//
// Runs ONLY against the app-shell lab when COMMUNICATION_E2E_SHELL_JOURNEY=1:
//   cd e2e && COMMUNICATION_E2E_SHELL_JOURNEY=1 E2E_BASE_URL=http://localhost:15173 \
//     E2E_EVIDENCE_DIR=$HOME/.cache/pi-orch/communication/logs/e2e-journey/ev \
//     E2E_SHELL_STAMP=j$RANDOM pnpm exec playwright test tests/shell-journey.spec.ts \
//     --reporter=line --workers=1
// Serial tests share one page and a module-level state object (the
// issue2-workbench idiom). Every step calls evidence() (screenshot + one
// `EVIDENCE <name>: <what it proves>` line) and checkShellScreen() (axe via
// tests/a11y.ts, no sideways scroll, no uncaught page errors).
//
// If a step fails only because another worker's piece is not wired yet
// (assistant popover p7-wire, decision callouts p8-wire, assistant tool loop
// be-as-loop), the failing message names that piece — the assertions stay
// honest and are never weakened.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { BASE_URL, AGENT_TURN_TIMEOUT_MS } from "./env.js";
import {
  decideGate,
  expectNoLegacyAppBar,
  gotoApp,
  repinAssignment,
  signIn,
  testidOf,
} from "./helpers.js";
import {
  IS_PI_LAUNCHER,
  LAB_LAUNCHER,
  newProfileCardTestid,
  seedLabPiProfile,
} from "./lab-launcher.js";
import {
  apiPipelines,
  apiProjects,
  checkShellScreen,
  evidence,
  watchPageErrors,
  type PipelineRow,
} from "./shell-helpers.js";

/** The shared gate for this journey only. */
const JOURNEY_ENABLED = process.env.COMMUNICATION_E2E_SHELL_JOURNEY === "1";
const JOURNEY_GATE =
  "requires the app-shell journey lab (COMMUNICATION_E2E_SHELL_JOURNEY=1, E2E_BASE_URL=http://localhost:15173)";

/** E2E_SHELL_STAMP is the runner's per-run tag (j$RANDOM); time is the fallback. */
const STAMP = process.env.E2E_SHELL_STAMP ?? Date.now().toString(36);
/** The seeded pipeline the journey mutates: plan → approve → implement… */
const PIPELINE_SLUG = "feature-development";
const PROFILE_NAME = `journey-${STAMP}`;
/** The draft instruction for the new Agent step (harmless: read-only).
 *
 * A DETERMINISTIC long turn — the step e takeover must land WHILE
 * journey_step is in flight, and a turn that settles in a few seconds is
 * already over by the time Take control is confirmed (issue2 A5 had the
 * exact race and solved it with a shell wait — impossible here: the dialog
 * profile is always permission_mode=ask, which the ACP harness treats as
 * deny, internal/agent/acp/permission.go, so any shell wait is rejected).
 * (Under COMMUNICATION_LAB_LAUNCHER=pi the step's profile runs
 * autonomous_within_sandbox instead — ADR-0069 — so its tools really run
 * inside the sandbox; the essay keeps that long turn open just the same.)
 * A long generation keeps the turn open instead: at the lab model's
 * ~80 tok/s, a 2500–4000 word essay stays in flight for well over the
 * ~30 s the workbench UI needs between the API catch and the confirm click.
 *
 * The reply must still extract to a JSON object (§ 4 step 6 / 01 invariant
 * 4): the essay is brace-free prose (the extractor falls back to the reply's
 * first `{` … last `}`), and the listing travels as the final fenced json
 * block, which extractStructuredOutput prefers over the brace span.
 */
const STEP_INSTRUCTION =
  "Do not modify anything in the repository. Write a long essay of at least " +
  "2500 words and at most 4000 words about the history of programming " +
  "languages, from early assembly languages and FORTRAN to modern languages " +
  "such as Go and Rust, with a separate section for each major language and " +
  "concrete historical examples. Strict formatting rules: plain prose only — " +
  "do not use any curly brace characters and do not use any fenced code " +
  "blocks anywhere in the essay. After the essay, on a final separate line, " +
  'reply with the result as a fenced json code block: a JSON object {"files": ...} ' +
  "where files is the array of the file and directory names at the repository " +
  "root (you may read the root listing to answer this).";
/** The node id the new step is renamed to (renamed LAST — the rename commit
 * drops the node selection, so no other field may follow it). */
const NEW_NODE_ID = "journey_step";
/** journey_step's retry ceiling — how many attempts the step may spend.
 *
 * 3, not 2, because the step e hand-back's re-queued attempt is NOT a retry and
 * still spends one of the node's attempts:
 *   · internal/pipelines/runtime/retry.go:580 numbers it `n.AttemptCount + 1`
 *     and retry.go:589 bumps `n.AttemptCount` — queueTakeoverAttempt takes “the
 *     same accounting queueAttempt does” (retry.go:572-574), so after the
 *     hand-back the node's ledger reads 2;
 *   · internal/pipelines/runtime/advancer.go:357 gives the node
 *     `AttemptLimit: max1(pn.Retry.MaxAttempts)`, and the retry gate at
 *     advancer.go:628 is `row.AttemptCount < row.AttemptLimit` (mirrored by
 *     internal/store/postgres/attempts.go:275-278, where the claim deliberately
 *     does not bump the count “because the advancer gates the retry on
 *     attempt_count < attempt_limit”).
 * A ceiling of 2 therefore fails the node the moment the hand-back attempt
 * fails — the run-42157903826 death that lost the approve gate — and a ceiling
 * of 3 queues ONE real retry (attempt 3) after it, still taking the node
 * terminal if the model answers badly twice in a row.
 *
 * That is ADR-0043 § 4's rule read literally: “a worker-declared failure on the
 * hand-back attempt follows the node's retry policy as normal. If that attempt
 * exhausts the policy, the node fails”
 * (docs/adr/ADR-0043-run-workbench-graph-first.md:126-129). ADR-0055 § 4's
 * “Hand-back queueing is NOT a retry and must not consume the node's attempt
 * budget” (docs/adr/ADR-0055-pause-before-next-step.md:209-213) is about the
 * hand-back's QUEUEING bypassing the gate — the resume re-queues explicitly
 * rather than consulting the retry decision (retry.go:501-506) — not about the
 * ledger the gate reads afterwards, which is why the ceiling needs the seat.
 */
const RETRY_MAX_ATTEMPTS = 3;
/** The retriable half of ADR-0023 § 7's classes, exactly as $defs/retryPolicy
 * admits them (internal/pipelines/schema/assets/
 * pipeline-v1alpha1.schema.json:152-167). workspace_lost, predicate_error,
 * approval_expired and cancelled are never retriable and stay out. */
const RETRY_RETRIABLE_ERRORS = [
  "infra",
  "interrupted",
  "timeout",
  "agent_error",
  "invalid_output",
] as const;
/** No backoff block is authored: nothing in $defs/retryPolicy is required (same
 * schema file, lines 118-171), and an authored block without one defaults to
 * 30 s × 2 with jitter (internal/pipelines/compiler/policy.go:106-118) — about
 * two minutes before attempt 3, well inside the widened GATE_TIMEOUT_MS below. */
/** The assistant's change target (step f), asserted through the draft YAML. */
const ASSISTANT_STEP_NAME = "journey_check";
/** One node step is worker polls plus sleep inputs, not milliseconds. */
const NODE_STEP_TIMEOUT_MS = Number(process.env.E2E_NODE_STEP_TIMEOUT_MS ?? 420_000);
/** Two real agent turns (plan, then the new journey step) precede the gate, plus
 * the ONE retry the step's own policy now allows: the hand-back's attempt and
 * its retry are both in flight before approve can open (execution order note at
 * the top of this file), so the window carries three node steps. */
const GATE_TIMEOUT_MS = 3 * NODE_STEP_TIMEOUT_MS;

/** Shared across the serial steps of this one-page journey. */
interface JourneyState {
  pipeline: PipelineRow;
  revisionBefore: number;
  revisionDigest: string;
  draftId: string;
  draftUrl: string;
  projectId: string;
  runId: string;
  approvalId: string;
  agentNodeId: string;
}
const state: JourneyState = {
  pipeline: undefined as unknown as PipelineRow,
  revisionBefore: 0,
  revisionDigest: "",
  draftId: "",
  draftUrl: "",
  projectId: "",
  runId: "",
  approvalId: "",
  agentNodeId: "",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Find the seeded pipeline row by slug; it must already be published once. */
async function seededPipeline(request: APIRequestContext): Promise<PipelineRow> {
  const rows = await apiPipelines(request);
  const row = rows.find((p) => p.slug === PIPELINE_SLUG);
  if (!row) throw new Error(`the seeded pipeline ${PIPELINE_SLUG} is not in GET /pipelines`);
  if (!row.latest_revision_number)
    throw new Error(`pipeline ${PIPELINE_SLUG} has no published revision yet`);
  state.pipeline = row;
  state.revisionBefore = row.latest_revision_number;
  return row;
}

/** GET /pipelines/{id}/revisions, newest first; the head carries the digest. */
async function newestRevisionDigest(
  request: APIRequestContext,
  pipelineId: string,
): Promise<string> {
  const res = await request.get(`${BASE_URL}/api/v1/pipelines/${pipelineId}/revisions`);
  if (!res.ok()) throw new Error(`GET /pipelines revisions -> ${res.status()}`);
  const body = (await res.json()) as { revisions?: { revision_digest: string }[] };
  const head = (body.revisions ?? [])[0];
  if (!head?.revision_digest) throw new Error(`no revision with a digest for ${pipelineId}`);
  return head.revision_digest;
}

/** The first project holding an assignment for the pipeline (run start needs one). */
async function projectWithAssignment(
  request: APIRequestContext,
  pipelineId: string,
): Promise<string> {
  const projects = await apiProjects(request);
  for (const project of projects) {
    const res = await request.get(`${BASE_URL}/api/v1/projects/${project.id}/assignments`);
    if (!res.ok()) throw new Error(`GET /projects/${project.id}/assignments -> ${res.status()}`);
    const body = (await res.json()) as { assignments?: { pipeline_id: string }[] };
    if ((body.assignments ?? []).some((a) => a.pipeline_id === pipelineId)) return project.id;
  }
  throw new Error(
    `no project assignment for pipeline ${PIPELINE_SLUG} — the lab seed is missing it`,
  );
}

/** The newest drafts of a pipeline with their document YAML. */
async function recentDrafts(
  request: APIRequestContext,
  pipelineId: string,
): Promise<{ id: string; yaml: string }[]> {
  const res = await request.get(`${BASE_URL}/api/v1/pipelines/${pipelineId}/drafts`);
  if (!res.ok()) throw new Error(`GET /pipelines drafts -> ${res.status()}`);
  const body = (await res.json()) as { drafts?: { id: string; updated_at: string }[] };
  const drafts = [...(body.drafts ?? [])]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6);
  const out: { id: string; yaml: string }[] = [];
  for (const draft of drafts) {
    const d = await request.get(`${BASE_URL}/api/v1/drafts/${draft.id}`);
    if (!d.ok()) throw new Error(`GET /drafts/${draft.id} -> ${d.status()}`);
    const row = (await d.json()) as { document_yaml: string };
    out.push({ id: draft.id, yaml: row.document_yaml });
  }
  return out;
}

/** The newest drafts of the pipeline whose YAML contains the marker. */
async function draftsContaining(
  request: APIRequestContext,
  marker: string,
): Promise<{ id: string; yaml: string }[]> {
  return (await recentDrafts(request, state.pipeline.id)).filter((d) => d.yaml.includes(marker));
}

/** True when the draft YAML carries a list item (a node) whose own `id`
 * is this id AND whose own `kind` is this kind, in any key order — the two
 * keys must sit at the same item's key indent (on the dash line or below
 * it), so an id inside a prompt or another node's nested block never
 * counts. Run 41762538136 (72c1829) showed the earlier "kind on the line
 * right after id" regex missing a node the assistant had really inserted
 * (`journey_check`, human.approval), because a key sorted between them. */
function yamlHasNodeOfKind(yaml: string, id: string, kind: string): boolean {
  const lines = yaml.split("\n");
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`^id:\\s*["']?${esc(id)}["']?\\s*$`);
  const kindRe = new RegExp(`^kind:\\s*["']?${esc(kind)}["']?\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const dash = lines[i].match(/^(\s*)- (.*)$/);
    if (!dash) continue;
    const keyIndent = dash[1].length + 2;
    const keys: string[] = [dash[2].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue;
      const indent = line.match(/^(\s*)/)![1].length;
      if (indent < keyIndent) break;
      if (indent === keyIndent) keys.push(line.trim());
    }
    if (keys.some((k) => idRe.test(k)) && keys.some((k) => kindRe.test(k))) return true;
  }
  return false;
}

/** The newest drafts of the pipeline carrying a node with this id AND this
 * kind — the leg-f "landed" gate: the draft must contain a step named
 * journey_check of the approval kind, wherever a follow-up landed it. */
async function draftsContainingStep(
  request: APIRequestContext,
  id: string,
  kind: string,
): Promise<{ id: string; yaml: string }[]> {
  return (await recentDrafts(request, state.pipeline.id)).filter((d) =>
    yamlHasNodeOfKind(d.yaml, id, kind),
  );
}

/** The raw YAML of one open draft, via the same API the journey already
 * uses for its draft reads. */
async function draftYaml(request: APIRequestContext, draftId: string): Promise<string> {
  const d = await request.get(`${BASE_URL}/api/v1/drafts/${draftId}`);
  if (!d.ok()) throw new Error(`GET /drafts/${draftId} -> ${d.status()}`);
  return ((await d.json()) as { document_yaml: string }).document_yaml;
}

/** The top-level structure of a marshaled draft: every top-level node's id
 * and its dependsOn, in document order — "the draft returned to its
 * original content" means this structure is back. */
function topNodeSignature(yaml: string): string {
  return parseTopLevelNodes(yaml)
    .map((n) => `${n.id}=[${n.dependsOn.join(",")}]`)
    .join(" ");
}

interface DocNode {
  id: string;
  dependsOn: string[];
  block: string;
}

/** Line-level read of a document YAML: the top-level node list (the one
 * holding `plan`), each node's dependsOn and its raw block. The server
 * marshals documents with alphabetized keys and 4-space indents (a node
 * item starts `- config:` and its `id:` sorts later), so the node list is
 * found structurally: the first `nodes:` key, then the first sequence dash
 * below it. Enough to see which successors bind a node's outputs — the
 * guarded-edge rule. */
function parseTopLevelNodes(yaml: string): DocNode[] {
  const lines = yaml.split("\n");
  const ni = lines.findIndex((l) => /^\s*nodes:\s*$/.test(l));
  if (ni < 0) return [];
  let dash = -1;
  for (let i = ni + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- /);
    if (m) {
      dash = m[1].length;
      break;
    }
  }
  if (dash < 0) return [];
  const starts: number[] = [];
  for (let i = ni + 1; i < lines.length; i++) {
    if (/^\s*\S/.test(lines[i]) && lines[i].match(/^(\s*)/)![1].length < dash) break;
    if (lines[i].startsWith(" ".repeat(dash) + "- ")) starts.push(i);
  }
  return starts
    .map((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
      const block = lines.slice(s, end).join("\n");
      const id = block.match(new RegExp(`^ {${dash + 2}}id: ([A-Za-z0-9_.-]+)$`, "m"))?.[1];
      if (!id) return null;
      const dependsOn: string[] = [];
      const flow = block.match(new RegExp(`^ {${dash + 2}}dependsOn:\s*\\[([^\\]]*)\\]`, "m"));
      if (flow) {
        flow[1].split(",").forEach((s) => {
          const v = s.trim().replace(/^['"]|['"]$/g, "");
          if (v) dependsOn.push(v);
        });
      } else {
        const dl = lines.slice(s, end);
        const bi = dl.findIndex((l) => l === " ".repeat(dash + 2) + "dependsOn:");
        for (let i = bi + 1; bi >= 0 && i < dl.length; i++) {
          const dm = dl[i].match(new RegExp(`^ {${dash + 4}}- ([A-Za-z0-9_.-]+)\s*$`));
          if (dm) dependsOn.push(dm[1]);
          else if (dl[i].trim() !== "") break;
        }
      }
      return { id, dependsOn, block } satisfies DocNode;
    })
    .filter((n): n is DocNode => n !== null);
}

/** The step-f anchor: a node with an outgoing edge no successor guards —
 * the successor's config binds no `nodes.<x>.*` output of the node and the
 * edge carries no `when` guard naming it. The journey's own journey_step
 * is preferred when its journey_step→approve edge is open (approve binds
 * nodes.plan.*, not journey_step's outputs). */
function unguardedAnchor(nodes: DocNode[]): { anchor: string; successor: string } | null {
  const edgesOf = (id: string) => nodes.filter((n) => n.dependsOn.includes(id));
  const openOf = (x: DocNode) =>
    edgesOf(x.id).filter(
      (s) => !s.block.includes(`nodes.${x.id}.`) && !/when[^\n]*\b${x.id}\b/.test(s.block),
    );
  const pick = (x: DocNode) => {
    const open = openOf(x);
    return open.length ? { anchor: x.id, successor: open[0].id } : null;
  };
  const journey = nodes.find((n) => n.id === NEW_NODE_ID);
  if (journey) {
    const p = pick(journey);
    if (p) return p;
  }
  for (const n of nodes) {
    const p = pick(n);
    if (p) return p;
  }
  return null;
}

/** Raw YAML of a revision's document (the Studio's own fetch). */
async function revisionDocument(page: Page, digestOrId: string): Promise<string> {
  const res = await page.request.get(`/api/v1/revisions/${digestOrId}/document?format=yaml`);
  expect(res.status()).toBe(200);
  return res.text();
}

/**
 * Take a FRESH draft of `pipelineId` through the workflow page's History tab
 * and land on the Studio route, returning the draft id.
 *
 * Design 1e (commit a5b3f64) moved the clone control off the Overview: the
 * header now has ONE primary verb, `Edit workflow` (`pipeline-customize`),
 * and that button reopens the newest OPEN draft when one exists (it only
 * creates when none does). This journey must edit a draft cloned from the
 * newest PUBLISHED revision — a previous run's abandoned draft would carry
 * the journey's own node and poison steps b/c — so it takes the History
 * tab's `pipeline-new-draft`, which still always clones the newest revision
 * (house style: issue2-studio.spec.ts `openNewDraft`, shell-p4-library.spec.ts,
 * home-cluster.spec.ts). Called with the page on the workflow page.
 *
 * Every wait is explicit: a control that moved or never renders must fail in
 * seconds, not at this file's 30-minute test timeout.
 */
async function openFreshDraft(page: Page, pipelineId: string): Promise<string> {
  const historyTab = page.getByTestId("workflow-tab-history");
  await expect(historyTab, "the workflow page has a History tab route").toBeVisible({
    timeout: 30_000,
  });
  await historyTab.click({ timeout: 30_000 });
  await expect(page.getByTestId("workflow-history")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/workflows/${pipelineId}/history`), {
    timeout: 30_000,
  });
  const newDraft = page.getByTestId("pipeline-new-draft");
  await expect(
    newDraft,
    "the History tab's New draft clones the newest published revision",
  ).toBeVisible({ timeout: 30_000 });
  await newDraft.click({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/workflows/${pipelineId}/drafts/`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").pop() as string;
}

interface NodeRow {
  id: string;
  node_id: string;
  kind: string;
  status: string;
  attempt_count: number;
}

/** One row of NodeExecutionDetail.attempts — the append-only history the node
 * detail route serves (GET /api/v1/runs/{runId}/nodes/{nodeExecutionId},
 * internal/api/runs.go:870, with the detail type at internal/api/runs.go:452
 * and the attempt's error_class / detail / output_errors at :405-410). The
 * other e2e reads of attempt rows use the same members
 * (e2e/tests/issue2-workbench.spec.ts:414-417, e2e/tests/home-cluster.spec.ts:1135).
 */
interface AttemptDetailRow {
  attempt_number: number;
  status: string;
  error_class?: string | null;
  detail?: string | null;
  output_errors?: unknown;
}

/** One node execution's latest attempt, by the detail route above. */
async function latestAttempt(
  request: APIRequestContext,
  runId: string,
  nodeExecutionId: string,
): Promise<AttemptDetailRow | null> {
  const res = await request.get(`${BASE_URL}/api/v1/runs/${runId}/nodes/${nodeExecutionId}`);
  if (!res.ok()) throw new Error(`GET /runs/${runId}/nodes/${nodeExecutionId} -> ${res.status()}`);
  const body = (await res.json()) as { attempts?: AttemptDetailRow[] };
  const rows = body.attempts ?? [];
  if (rows.length === 0) return null;
  return rows.reduce((newest, row) => (row.attempt_number > newest.attempt_number ? row : newest));
}

/** A diagnostic never prints an unbounded blob. */
function clipText(value: unknown, max = 400): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/** WHY the failed nodes failed, for the messages that already say THAT they
 * failed. Acceptance run 42157903826 ended with `journey_step:failed` and no
 * reason: the class, the worker's detail line and the output errors are what
 * told the reader a single bad model answer had exhausted a policy-less node.
 *
 * Printed, never asserted — a diagnostic must not quietly become a contract. */
async function failedNodeReasons(
  request: APIRequestContext,
  runId: string,
  nodes: NodeRow[],
): Promise<string> {
  const parts: string[] = [];
  for (const node of nodes.filter((row) => row.status === "failed")) {
    try {
      const attempt = await latestAttempt(request, runId, node.id);
      parts.push(
        attempt === null
          ? `${node.node_id}: failed with no attempt row`
          : `${node.node_id} attempt n${attempt.attempt_number} [${attempt.status}] ` +
            `error_class=${attempt.error_class ?? "none"} ` +
            `detail=${clipText(attempt.detail ?? "")} ` +
            `output_errors=${clipText(attempt.output_errors ?? null)}`,
      );
    } catch (err) {
      parts.push(`${node.node_id}: attempt history unreadable (${String(err)})`);
    }
  }
  return parts.join(" ; ") || "no node failed";
}

/** GET /runs/{id}/nodes — every node execution of the run. */
async function runNodes(request: APIRequestContext, runId: string): Promise<NodeRow[]> {
  const res = await request.get(`${BASE_URL}/api/v1/runs/${runId}/nodes`);
  if (!res.ok()) throw new Error(`GET /runs/${runId}/nodes -> ${res.status()}`);
  const body = (await res.json()) as { node_executions?: NodeRow[] };
  return body.node_executions ?? [];
}

/** Project-scoped gate list — the lab's core surface (the C3 cross-project
 * list is built in parallel; this one exists since M4). */
interface ApprovalRow {
  id: string;
  run_id: string;
  state: string;
  decision?: string | null;
}
async function pendingProjectApprovals(request: APIRequestContext): Promise<ApprovalRow[]> {
  const res = await request.get(`${BASE_URL}/api/v1/projects/${state.projectId}/approvals`);
  if (!res.ok()) throw new Error(`GET /projects/${state.projectId}/approvals -> ${res.status()}`);
  const body = (await res.json()) as { approvals?: ApprovalRow[] };
  return (body.approvals ?? []).filter((a) => a.state === "pending");
}

/** The run's status as the project's own run list reports it. */
async function projectRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string | undefined> {
  const res = await request.get(`${BASE_URL}/api/v1/projects/${state.projectId}/runs`);
  if (!res.ok()) throw new Error(`GET /projects/${state.projectId}/runs -> ${res.status()}`);
  const body = (await res.json()) as { runs?: { id: string; status: string }[] };
  return (body.runs ?? []).find((r) => r.id === runId)?.status;
}

/** Poll until a pending approval exists for the run (plan + journey step first). */
async function waitForApproval(request: APIRequestContext, runId: string): Promise<string> {
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  for (;;) {
    const approvals = await pendingProjectApprovals(request);
    const row = approvals.find((a) => a.run_id === runId);
    if (row) return row.id;
    if (Date.now() > deadline) {
      const nodes = await runNodes(request, runId);
      const reasons = await failedNodeReasons(request, runId, nodes);
      throw new Error(
        `no pending approval for run ${runId} after the gate window (nodes: ${
          nodes.map((n) => `${n.node_id}:${n.status}`).join(" ") || "none"
        }; why: ${reasons})`,
      );
    }
    await sleep(3_000);
  }
}

/**
 * Poll until the gate is decided approved, then until the run moves on:
 * the approve step is succeeded (the C3 cross-project `steps` field, when
 * this API build carries it) or — the core truth — the run's own status left
 * `waiting_human` and did not fail.
 */
async function waitForApprovalDecided(request: APIRequestContext, runId: string): Promise<void> {
  const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
  for (;;) {
    const res = await request.get(`${BASE_URL}/api/v1/approvals/${state.approvalId}`);
    if (res.ok()) {
      const row = (await res.json()) as ApprovalRow;
      if (row.state === "decided") {
        if (row.decision && row.decision !== "approved")
          throw new Error(`the gate was decided ${row.decision}, not approved`);
        break;
      }
    }
    if (Date.now() > deadline)
      throw new Error(`approval …${state.approvalId.slice(-8)} never reached decided`);
    await sleep(3_000);
  }
  const movesOnDeadline = Date.now() + 120_000;
  for (;;) {
    const runs = await crossRunRow(request, runId).catch(() => undefined);
    if (runs?.steps?.some((s) => s.node_id === "approve" && s.state === "succeeded")) return;
    const status = await projectRunStatus(request, runId);
    if (status !== undefined && status !== "waiting_human") {
      if (status === "failed" || status === "cancelled")
        throw new Error(`the run went ${status} instead of moving on past the gate`);
      return;
    }
    if (Date.now() > movesOnDeadline)
      throw new Error(
        `the run never left waiting_human (status: ${status ?? "unreadable"}) — is the cross-project run list (C3) wired in this lab?`,
      );
    await sleep(3_000);
  }
}

/** The cross-project run row (C3) — used only for its top-level `steps`. */
async function crossRunRow(
  request: APIRequestContext,
  runId: string,
): Promise<{ steps?: { node_id: string; state: string }[] } | undefined> {
  const res = await request.get(`${BASE_URL}/api/v1/runs?limit=100`);
  if (!res.ok()) throw new Error(`GET /runs -> ${res.status()}`);
  const body = (await res.json()) as {
    runs?: { id: string; steps?: { node_id: string; state: string }[] }[];
  };
  return (body.runs ?? []).find((r) => r.id === runId);
}

/** One node's own lines in a YAML document: from its item line to the first
 * line at or left of that item's key indent — so a journey_step named inside a
 * prompt, or another node's nested block, never counts as this node's. Same
 * scan yamlHasNodeOfKind (above) does. */
function yamlNodeLines(yaml: string, nodeId: string): string[] {
  const lines = yaml.split("\n");
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`^id:\\s*["']?${esc(nodeId)}["']?\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const dash = lines[i].match(/^(\s*)- (.*)$/);
    if (!dash) continue;
    const keyIndent = dash[1].length + 2;
    const keys: string[] = [dash[2].trim()];
    let end = i + 1;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (line.trim() === "") continue;
      const indent = line.match(/^(\s*)/)![1].length;
      if (indent < keyIndent) break;
      if (indent === keyIndent) keys.push(line.trim());
    }
    if (keys.some((key) => idRe.test(key))) return lines.slice(i, end);
  }
  return [];
}

/** The retry block one node carries, as ONE space-collapsed line — "" when the
 * node declares none. Block and flow spellings collapse to the same text, so
 * the assertion says what was authored rather than how the editor indented it. */
function yamlNodeRetryBlock(yaml: string, nodeId: string): string {
  const block = yamlNodeLines(yaml, nodeId);
  const at = block.findIndex((line) => /^\s*retry:/.test(line));
  if (at < 0) return "";
  const indent = block[at].match(/^(\s*)/)![1].length;
  const out = [block[at].trim()];
  if (out[0] !== "retry:") return out[0].replace(/\s+/g, " "); // flow style on one line
  for (const line of block.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (line.match(/^(\s*)/)![1].length <= indent) break;
    out.push(line.trim());
  }
  return out.join(" ").replace(/\s+/g, " ");
}

/**
 * Author the new step's retry policy through the Studio inspector's generated
 * retry fields, and return the surface that wrote it.
 *
 * The field table comes from $defs/retryPolicy (inspectorSchema's
 * commonSections), so the widgets are `insp-retry-maxAttempts` (a
 * range-checked NumberField that commits on blur or Enter) and
 * `insp-retry-retriableErrors` (an add/remove ListField: `-add` arms a blank
 * row, `-row-<index>` is its input, and every keystroke commits the whole
 * array). Each commit is a nested write merged into the node's existing
 * `retry:` map — the inspector is the only author, and the read-back below
 * fails this journey if any of its writes is dropped.
 */
/** The retry fields live inside the design's collapsed “Retries, timeout and
 * outputs” disclosure (1g pass 2 #2) — open it when the build has it closed, so
 * nothing in this journey depends on which fields the design chose to collapse. */
async function openRetryFields(page: Page): Promise<void> {
  if (await page.getByTestId("insp-retry-maxAttempts").isVisible().catch(() => false)) return;
  await page
    .getByTestId("insp-advanced-disclosure")
    .locator("summary")
    .click({ timeout: 30_000 });
  await expect(page.getByTestId("insp-retry-maxAttempts")).toBeVisible({ timeout: 30_000 });
}

async function authorStepRetryPolicy(page: Page): Promise<string> {
  await openRetryFields(page);

  // maxAttempts: the NumberField commits on blur or Enter.
  const maxAttempts = page.getByTestId("insp-retry-maxAttempts");
  await maxAttempts.fill(String(RETRY_MAX_ATTEMPTS), { timeout: 30_000 });
  await maxAttempts.press("Enter", { timeout: 30_000 });

  // retriableErrors: the ListField arms one blank row per Add click and commits
  // the whole array on every keystroke, so the rows are filled in order.
  const errorList = page.getByTestId("insp-retry-retriableErrors");
  await expect(errorList).toBeVisible({ timeout: 30_000 });
  for (const [index, kind] of RETRY_RETRIABLE_ERRORS.entries()) {
    await page.getByTestId("insp-retry-retriableErrors-add").click({ timeout: 30_000 });
    await page
      .getByTestId(`insp-retry-retriableErrors-row-${index}`)
      .fill(kind, { timeout: 30_000 });
  }

  // The widgets read their values from the draft document itself: a write the
  // inspector dropped leaves them empty and fails here, before the rename.
  await expect(maxAttempts).toHaveValue(String(RETRY_MAX_ATTEMPTS), { timeout: 30_000 });
  for (const [index, kind] of RETRY_RETRIABLE_ERRORS.entries()) {
    await expect(page.getByTestId(`insp-retry-retriableErrors-row-${index}`)).toHaveValue(kind, {
      timeout: 30_000,
    });
  }
  return "the inspector's retry fields";
}

/** Poll until the run's journey_step agent.acp node execution is in flight.
 *
 * The node's own status is the live signal: a worker-leased agent step sits
 * at `leased` for its ENTIRE turn (BeginTurn flips only the conversation turn
 * to `running`, never the node execution — ADR-0023 § 3's two-path node
 * machine), and only the terminal write moves it on. `running` is kept as an
 * accepted in-flight state so the poll cannot miss a build where the node does
 * carry it.
 *
 * The node is targeted BY ID, not "any agent step": plan and implement are
 * short turns (a few seconds) — catching one of them is the very race that
 * made the pre-fix step e flaky (its turn settled before the confirm click).
 * journey_step's instruction holds the lab model for about a minute or more,
 * so that window is deterministic. Poll fast: one second between reads.
 */
const IN_FLIGHT = new Set(["leased", "running"]);
async function waitForAgentRunning(request: APIRequestContext, runId: string): Promise<NodeRow> {
  const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
  for (;;) {
    const nodes = await runNodes(request, runId);
    const live = nodes.find(
      (n) => n.node_id === NEW_NODE_ID && n.kind === "agent.acp" && IN_FLIGHT.has(n.status),
    );
    if (live) return live;
    if (Date.now() > deadline) {
      const reasons = await failedNodeReasons(request, runId, nodes);
      throw new Error(
        `journey_step (${NEW_NODE_ID}) never went in-flight (leased/running) in run ${runId} within the window (nodes: ${
          nodes.map((n) => `${n.node_id}:${n.status}`).join(" ") || "none"
        }; why: ${reasons})`,
      );
    }
    await sleep(1_000);
  }
}

/**
 * Wait for an assistant turn to reach its own completion: the popover's
 * in-flight indicator (`assistant-thinking`) clears, or a new assistant
 * message appears — whichever the turn's state settles in — with a ceiling
 * of 240 s (the lab's per-completion deadline is COMMUNICATION_ASSISTANT_TIMEOUT=180s;
 * this bound is generous but finite). Every wait for an assistant turn in
 * this journey goes through here instead of a fixed window.
 */
async function waitForAssistantTurn(page: Page, timeoutMs = 240_000): Promise<void> {
  const thinking = page.getByTestId("assistant-thinking");
  const assistantMsg = page.getByTestId("assistant-msg-assistant");
  await expect
    .poll(
      async () => {
        const inFlight = await thinking.isVisible().catch(() => false);
        const messages = await assistantMsg.count();
        const latest = messages > 0 ? ((await assistantMsg.last().textContent()) ?? "").trim() : "";
        const settled = !inFlight && (messages > 0 ? latest.length > 0 : true);
        return settled;
      },
      { timeout: timeoutMs, intervals: [1_000] },
    )
    .toBe(true);
}

test.describe.serial("shell journey — the app-shell acceptance journey end to end", () => {
  test.skip(!JOURNEY_ENABLED, JOURNEY_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(40 * 60_000); // covers the widened gate window in d (see GATE_TIMEOUT_MS)

  let stopWatching: (() => void) | null = null;

  test.afterAll(async () => {
    stopWatching?.();
  });

  test("a — Studio: add an Agent step after plan with a brand-new profile", async ({ page }) => {
    // Step 0 (the serial journey shares one page; the first test owns setup):
    // sign in, and the shell is a sidebar app — no top bar anywhere.
    await signIn(page, "admin");
    stopWatching = watchPageErrors(page);
    await gotoApp(page, "/");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expectNoLegacyAppBar(page);
    await evidence(
      page,
      `journey-0-shell-${STAMP}`,
      "signed in; the sidebar exists and no header[aria-label=Primary] top bar is present",
    );

    await seededPipeline(page.request);
    console.log(`journey a: pipeline ${PIPELINE_SLUG} at revision ${state.revisionBefore}`);

    // Re-run safety: a previous run of this journey published a revision that
    // carries journey_step, so restore the seeded twin first (the oldest
    // revision's document plus ONE stamped metadata line for a fresh digest)
    // through the Studio's YAML editor — the node graph stays pristine and
    // the new digest makes the restoration publishable.
    const revRes = await page.request.get(`/api/v1/pipelines/${state.pipeline.id}/revisions`);
    expect(revRes.status()).toBe(200);
    const revBody = (await revRes.json()) as { revisions?: { revision_digest: string }[] };
    const revisions = revBody.revisions ?? [];
    const newestDoc = await revisionDocument(page, revisions[0]?.revision_digest ?? "");
    if (newestDoc.includes(`id: ${NEW_NODE_ID}`)) {
      const seedDoc = await revisionDocument(
        page,
        revisions[revisions.length - 1]?.revision_digest ?? "",
      );
      const restored = seedDoc.replace(
        /^([ \t]*description: .*)$/m,
        (line) => `${line} (re-stored ${STAMP})`,
      );
      expect(restored, "the stamp must land on the description line").not.toBe(seedDoc);
      await page.goto(BASE_URL + `/workflows/${state.pipeline.id}`, { timeout: 30_000 });
      await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });
      // Design 1e: the clone control is on the History tab (see openFreshDraft)
      // — and it must be that one: a fresh clone of the newest revision, not
      // the header's Edit workflow, which would reopen a stale open draft.
      await openFreshDraft(page, state.pipeline.id);
      await page.getByTestId("studio-view-yaml").click({ timeout: 30_000 });
      await page.getByTestId("studio-yaml").fill(restored, { timeout: 30_000 });
      await page.getByTestId("studio-save").click({ timeout: 30_000 });
      await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId("studio-validate").click({ timeout: 30_000 });
      const verdict = page.getByTestId("studio-validate-verdict");
      await expect(verdict).toBeVisible({ timeout: 60_000 });
      expect((await verdict.textContent()) ?? "").toMatch(/^valid/i);
      await page.getByTestId("studio-publish").click({ timeout: 30_000 });
      await expect(page.getByTestId("studio-published")).toBeVisible({ timeout: 60_000 });
      await evidence(
        page,
        `journey-a-rerun-restored-${STAMP}`,
        `a previous journey run had published a revision carrying ${NEW_NODE_ID} — the seeded twin (oldest revision's document, description stamped “re-stored ${STAMP}” for a fresh digest) was restored through the Studio and republished`,
      );
      // The latest revision moved; re-read the baseline for step b's increment check.
      await seededPipeline(page.request);
    }

    await gotoApp(page, "/workflows");
    console.log("journey a: /workflows answered");
    await expect(page.getByTestId("workflows-list")).toBeVisible({ timeout: 30_000 });
    await gotoApp(page, `/workflows/${state.pipeline.id}`);
    console.log("journey a: pipeline page answered");
    await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pipeline-header-meta")).toContainText(PIPELINE_SLUG, {
      timeout: 30_000,
    });

    // New draft: the History tab's clone control (built from the newest revision).
    state.draftId = await openFreshDraft(page, state.pipeline.id);
    state.draftUrl = page.url();
    console.log(`journey a: new draft ${state.draftId}`);
    await checkShellScreen(page, "studio", stopWatching ?? undefined);
    console.log("journey a: studio a11y pass done");

    // The `+` on the plan → approve edge (revealed on hover) starts a new step.
    const edgeAdd = page.getByTestId("edge-add-plan-approve");
    await expect(edgeAdd).toBeVisible({ timeout: 30_000 });
    await edgeAdd.hover({ timeout: 30_000 });
    await edgeAdd.click({ timeout: 30_000 });
    console.log("journey a: edge + clicked");
    await expect(page.getByTestId("step-picker")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("step-picker-item-agent.acp").click({ timeout: 30_000 });

    // §4 ambiguity rule (issue #2 A3): the approve step is guarded (it reads
    // nodes.plan.*), so the insert op refuses to rewire silently — the dialog
    // names the reasons verbatim. Assert them, then accept.
    const ambiguity = page.getByTestId("studio-ambiguity-dialog");
    await expect(ambiguity)
      .toBeVisible({ timeout: 5_000 })
      .catch(() => undefined);
    if (await ambiguity.isVisible()) {
      await expect(page.getByTestId("studio-ambiguity-title")).toHaveText(
        /insert a step between plan and approve/i,
        { timeout: 30_000 },
      );
      const reasons = page.locator('[data-testid^="studio-ambiguity-reason-"]');
      const reasonCount = await reasons.count();
      expect(reasonCount, "the guarded-edge dialog names at least one reason").toBeGreaterThan(0);
      const reasonText = (
        await Promise.all(
          Array.from({ length: reasonCount }, (_, i) => reasons.nth(i).textContent()),
        )
      ).join(" | ");
      await checkShellScreen(page, "ambiguity-dialog", stopWatching ?? undefined);
      await evidence(
        page,
        `journey-a-ambiguity-${STAMP}`,
        `guarded-edge dialog before the insert: “${reasonText}” — the insert is accepted with the target's guard kept (issue #2 A3)`,
      );
      await page.getByTestId("studio-ambiguity-insert").click({ timeout: 30_000 });
      await expect(ambiguity).toBeHidden({ timeout: 30_000 });
    }

    // The new node is selected: the inspector names it — the id field lives
    // inside the design's collapsed "Retries, timeout and outputs"
    // disclosure (1g pass 2 #2), so open it first.
    await page
      .getByTestId("insp-advanced-disclosure")
      .locator("summary")
      .click({ timeout: 30_000 });
    await expect(page.getByTestId("insp-node-id")).toBeVisible({ timeout: 30_000 });
    console.log("journey a: agent step inserted, inspector open");

    // Profile select → “+ New profile…”: the New-profile dialog (contract C6).
    await page
      .getByTestId("insp-profile")
      .selectOption({ label: "+ New profile…" }, { timeout: 30_000 });
    const dialog = page.getByTestId("new-profile-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    console.log("journey a: new-profile dialog open — a11y pass");
    await checkShellScreen(page, "new-profile-dialog", stopWatching ?? undefined);
    console.log("journey a: dialog a11y pass done");
    // The dialog's launcher card is the lab's launcher (COMMUNICATION_LAB_LAUNCHER;
    // unset keeps the historical claude card).
    await page.getByTestId(newProfileCardTestid()).click({ timeout: 30_000 });
    await page.getByTestId("agents-new-name-input").fill(PROFILE_NAME, { timeout: 30_000 });
    await expect(page.getByTestId("agents-new-submit")).toContainText("Create and use in", {
      timeout: 30_000,
    });
    await evidence(
      page,
      `journey-a-dialog-${STAMP}`,
      `New-profile dialog open: the ${LAB_LAUNCHER} card, name ${PROFILE_NAME}, and the footer reads “Create and use in <step>” (contract C6)`,
    );
    await page.getByTestId("agents-new-submit").click({ timeout: 30_000 });
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("insp-profile")).toHaveValue(PROFILE_NAME, { timeout: 30_000 });
    if (IS_PI_LAUNCHER) {
      // The dialog can only write `ask` (ADR-0030) and pi never asks: the
      // mode this run's step needs — autonomous_within_sandbox beside sandbox
      // `required` — arrives the seed.sh way, through the stack's own
      // postgres (ADR-0069). Without it the worker fail-closes the attempt
      // before launch (ADR-0019 D6) and step e has no live turn to catch.
      seedLabPiProfile(PROFILE_NAME);
    }
    console.log(`journey a: profile ${PROFILE_NAME} created and selected`);

    // “What should it do?” — a short, harmless instruction.
    await page.getByTestId("insp-config-prompt").fill(STEP_INSTRUCTION, { timeout: 30_000 });
    await page.getByTestId("insp-config-prompt").blur();

    // The step's retry policy, BEFORE the rename. Without it one bad model
    // answer anywhere in this node's life fails it with nothing to try again:
    // acceptance run 42157903826 lost step d exactly there (nodes:
    // journey_step:failed, approve:cancelled) when the hand-back's re-queued
    // attempt answered without the json block.
    const retryAuthoredBy = await authorStepRetryPolicy(page);

    // The id rename LAST: the rename commit drops the node selection.
    const nodeIdField = page.getByTestId("insp-node-id");
    await nodeIdField.fill(NEW_NODE_ID, { timeout: 30_000 });
    await nodeIdField.press("Enter", { timeout: 30_000 });

    // Save so the insertion persists (the Studio keeps edits in memory until saved).
    await page.getByTestId("studio-save").click({ timeout: 30_000 });
    await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });

    // The policy is asserted through the saved draft's own bytes, not the form:
    // journey_step's node block carries retry.maxAttempts 3 over the five
    // retriable classes.
    const savedDraftYaml = await draftYaml(page.request, state.draftId);
    const retryBlock = yamlNodeRetryBlock(savedDraftYaml, NEW_NODE_ID);
    expect(
      retryBlock,
      `the saved draft carries ${NEW_NODE_ID}'s retry block (authored by ${retryAuthoredBy})`,
    ).toMatch(new RegExp(`maxAttempts:\\s*${RETRY_MAX_ATTEMPTS}`));
    for (const kind of RETRY_RETRIABLE_ERRORS) {
      expect(retryBlock, `retriableErrors must admit ${kind} (${retryBlock})`).toContain(kind);
    }
    await evidence(
      page,
      `journey-a-step-${STAMP}`,
      `agent.acp step ${NEW_NODE_ID} inserted after plan, profile ${PROFILE_NAME} created through the dialog and now selected, instruction set, retry policy maxAttempts ${RETRY_MAX_ATTEMPTS} over [${RETRY_RETRIABLE_ERRORS.join(", ")}] authored by ${retryAuthoredBy}, draft saved`,
    );
  });

  test("b — publish: Validate then Publish, and the revision number increments", async ({
    page,
  }) => {
    // Every serial step gets a fresh browser context (a fresh cookie jar),
    // so the session must be re-established with the SAME subject before
    // touching the state the previous step created (house style, like
    // issue2-workbench.spec.ts re-signing per step).
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("studio-validate").click();
    const verdict = page.getByTestId("studio-validate-verdict");
    await expect(verdict).toBeVisible({ timeout: 60_000 });
    const verdictText = ((await verdict.textContent()) ?? "").trim();
    expect(verdictText, "the draft must validate before publishing").toMatch(/^valid/i);

    await page.getByTestId("studio-publish").click();
    const published = page.getByTestId("studio-published");
    await expect(published).toBeVisible({ timeout: 60_000 });

    // The published revision number increments (asserted through the API).
    const rows = await apiPipelines(page.request);
    const row = rows.find((p) => p.id === state.pipeline.id);
    expect(row?.latest_revision_number, "the published revision number must increment").toBe(
      state.revisionBefore + 1,
    );
    expect(row?.revision_count, "the revision count must increment").toBe(
      (state.pipeline.revision_count ?? 0) + 1,
    );
    state.revisionDigest = await newestRevisionDigest(page.request, state.pipeline.id);
    // And it is the PUBLISHED bytes that carry the policy — the run in step c
    // pins this revision, so this is the retry gate the engine will read.
    const publishedRetry = yamlNodeRetryBlock(
      await revisionDocument(page, state.revisionDigest),
      NEW_NODE_ID,
    );
    expect(
      publishedRetry,
      `the published revision carries ${NEW_NODE_ID}'s retry block`,
    ).toMatch(new RegExp(`maxAttempts:\\s*${RETRY_MAX_ATTEMPTS}`));
    for (const kind of RETRY_RETRIABLE_ERRORS) {
      expect(publishedRetry, `retriableErrors must admit ${kind} (${publishedRetry})`).toContain(
        kind,
      );
    }
    await evidence(
      page,
      `journey-b-published-${STAMP}`,
      `draft validated (“${verdictText}”) and published — revision ${state.revisionBefore} → ${row?.latest_revision_number} (${state.revisionDigest.slice(0, 19)}…), asserted via the API, and the revision document carries ${NEW_NODE_ID}'s retry policy`,
    );
  });

  test("c — start a run of the new revision and land on it", async ({ page }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    // Setup via API: the run must start from the NEW revision, so the project's
    // assignment is repinned to it (re-pinning is effective at new-run creation
    // only; the run itself starts through the UI, per the journey).
    state.projectId = await projectWithAssignment(page.request, state.pipeline.id);
    await repinAssignment(page, state.projectId, state.pipeline.id, state.revisionDigest);

    // The project's new-run form (where the Board's “Start run” lands too).
    // Design 1b: the RUNS panel carries no "New run" button of its own — the
    // header band's `Start run` is the page's one door, landing here with
    // ?new=1, which opens the form above the list.
    await gotoApp(page, `/p/${state.projectId}/runs`);
    await page.getByTestId("project-start-run").click();
    await expect(page).toHaveURL(/[?&]new=1/);
    await expect(page.getByTestId("new-run-form")).toBeVisible();
    const select = page.getByTestId("new-run-assignment");
    await expect(select).toBeAttached();
    const optionRows = await Promise.all(
      (await select.locator("option").all()).map(
        async (option) =>
          `value=${await option.getAttribute("value")} text=${JSON.stringify(
            (await option.textContent()) ?? "",
          )}`,
      ),
    );
    const target = optionRows.find((row) => row.includes(`text="${PIPELINE_SLUG} · `));
    if (!target)
      throw new Error(
        `the new-run form has no assignment for ${PIPELINE_SLUG} (options: ${optionRows.join(" | ")})`,
      );
    await select.selectOption({ value: target.match(/^value=(.+) text=/)?.[1] ?? "" });

    await page.getByTestId("new-run-input-goal").fill(`shell journey ${STAMP}`);
    const repo = page.getByTestId("new-run-input-repository");
    if ((await repo.count()) > 0) {
      if ((await repo.evaluate((el) => el.tagName)) === "SELECT") {
        // index 0 is the empty “— choose —” placeholder; pick the first real
        // option by its value (selecting the placeholder leaves the required
        // field empty and the submit stays disabled forever).
        const options = await repo.locator("option").all();
        const value = await Promise.all(
          options.map(async (option) => await option.getAttribute("value")),
        ).then((values) => values.find((v) => v !== null && v !== ""));
        if (!value)
          throw new Error("the new-run form offers no selectable repository for the project");
        await repo.selectOption({ value });
      } else {
        const res = await page.request.get(`${BASE_URL}/api/v1/projects/${state.projectId}/repos`);
        if (res.ok()) {
          const body = (await res.json()) as { items?: { name: string }[] };
          const first = (body.items ?? [])[0]?.name;
          if (first) await repo.fill(first);
        }
      }
    }

    await page.getByTestId("new-run-submit").click();
    await page.waitForURL(/\/runs\/[0-9a-fA-F-]+/);
    state.runId = new URL(page.url()).pathname.split("/").pop() as string;
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    // The run is pinned to the revision just published. The redesigned header
    // (finding 11) splits that pin into two facts of the labeled row:
    // `run-pinned-revision` holds only `rev {number}` (the number the page's
    // revision read names for the pin) and the Pinned digest fact holds
    // `shortDigest(digest)`'s full 12 hex chars (shortDigest strips the
    // `sha256:` prefix). Assert both — the same facts the old
    // `revision r{n} {digest} (pinned)` sentence spelled in one line.
    const expectedPin = `rev ${state.revisionBefore + 1}`;
    const expectedDigest12 = state.revisionDigest.replace(/^sha256:/, "").slice(0, 12);
    await expect(page.getByTestId("run-pinned-revision")).toHaveText(expectedPin);
    await expect(page.getByTestId("run-fact-digest").locator("dd")).toHaveText(expectedDigest12);
    await evidence(
      page,
      `journey-c-run-${STAMP}`,
      `run ${state.runId} started from the new revision ${expectedPin} (${expectedDigest12} / ${state.revisionDigest.slice(0, 19)}…) and the workbench opened on it`,
    );
  });

  test("e — workbench: watch a live agent step, take control, prompt, hand back", async ({
    page,
  }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    // This test deliberately runs BEFORE step d: journey_step's long turn
    // settles before the approve gate can open, so the deterministic takeover
    // window is its attempt 1 — right after the run's short plan turn.
    // Poll the API until journey_step is in flight, then load the workbench
    // deep-linked to it (below) — the catch lands seconds after the lease,
    // inside the ~2-minute long turn.
    const agentPromise = waitForAgentRunning(page.request, state.runId);

    // A live agent step (leased = the worker holds it and the agent is
    // working; running = the turn is open) — its live status is what the
    // workbench shows.
    const node = await agentPromise;
    state.agentNodeId = node.node_id;

    // Load the workbench DEEP-LINKED to journey_step's node execution.
    // `?node=<execution id>` is the workbench's own deep-link form: it is
    // remapped to the definition node + instance on the first data, and a
    // `?node=` present on page load suppresses the dock's attention
    // auto-select for the life of the page. That suppression is what makes
    // the takeover deterministic: without it the dock parks on the plan's
    // just-finished conversation (whose completed attempt still offers a
    // Take control button — the pre-fix run took over that WRONG step), and
    // when the run then parked at the approval gate the auto-select moved
    // the dock to the gate, the confirm card unmounted, and the confirm
    // click waited out the 30-minute test timeout. With the deep link the
    // dock shows journey_step from first paint and never moves (ADR-0043
    // decision 4: the reader's pick wins).
    await gotoApp(page, `/runs/${state.runId}?node=${node.id}`);
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });

    // The dock shows journey_step's live conversation (its attempt's
    // conversation is stamped at claim, so the dock shows it as soon as the
    // worker's ACP session opens) and its Take control button.
    const dockControl = page.getByTestId("dock-take-control");
    await expect(dockControl).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(page.getByTestId("dock-conversation")).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "workbench", stopWatching ?? undefined);
    await evidence(
      page,
      `journey-e-live-${STAMP}`,
      `the workbench is pinned to agent step ${node.node_id} (status ${node.status} via the API) with its live conversation in the dock`,
    );

    // Take control: the first click opens the confirm card with its truthful
    // copy — and the card names journey_step itself (the heading carries the
    // step's instance key), so a card for any other step cannot pass.
    await dockControl.click();
    const takeCard = page.getByTestId("take-control-card");
    await expect(takeCard).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("take-control-card-heading")).toContainText(NEW_NODE_ID);
    const copy = (await takeCard.textContent()) ?? "";
    expect(copy, "the card states what a takeover does").toMatch(/stops and the run pauses/);
    expect(copy, "the card states what a hand-back does").toMatch(/new attempt/i);
    await evidence(
      page,
      `journey-e-confirm-${STAMP}`,
      `the take-control confirm card names ${node.node_id} and says the attempt stops, the run pauses, and the hand-back re-runs the step as a new attempt (ADR-0043)`,
    );
    // Bounded: the card is transient in-DOM state. A missed click must fail
    // fast (and re-open it), not ride the 30-minute test timeout — the exact
    // pre-fix failure mode.
    for (let round = 0; ; round += 1) {
      try {
        await page.getByTestId("take-control-confirm").click({ timeout: 20_000 });
        break;
      } catch (err) {
        const badge =
          (await page
            .getByTestId("dock-controller")
            .textContent()
            .catch(() => "")) ?? "";
        // ce8cfda renamed the pill to lower-case `you're in control`; either
        // wording proves the takeover landed, which is what this guard asks.
        if (/you(?:'re| are) in control/i.test(badge)) break; // the click landed after all
        if (round >= 1)
          throw new Error(
            `the take-control confirm click for ${NEW_NODE_ID} missed twice (the card closed?) — ${String(
              err,
            )}`,
          );
        await dockControl.click({ timeout: 20_000 });
        await expect(takeCard).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("take-control-card-heading")).toContainText(NEW_NODE_ID);
      }
    }

    // The controller line names you.
    await expect
      .poll(async () => (await page.getByTestId("dock-controller").textContent()) ?? "", {
        timeout: 60_000,
      })
      .toMatch(/you're in control/);

    // One prompt in the composer; the agent replies.
    const before = await page.getByTestId("transcript-item").count();
    await page
      .getByTestId("dock-composer-input")
      .fill("Say hello to acknowledge, then carry on with your original task.");
    await page.getByTestId("dock-composer-send").click();
    await expect
      .poll(async () => page.getByTestId("transcript-item").count(), {
        timeout: AGENT_TURN_TIMEOUT_MS,
      })
      .toBeGreaterThan(before);
    await expect
      .poll(async () => (await page.getByTestId("transcript-item").last().textContent()) ?? "", {
        timeout: AGENT_TURN_TIMEOUT_MS,
      })
      .toMatch(/hello/i);
    await evidence(
      page,
      `journey-e-prompt-${STAMP}`,
      `admin is in control of ${node.node_id}: one prompt (“Say hello to acknowledge, then carry on with your original task.”) got a live agent reply in the dock`,
    );

    // Hand back: the accepted takeover semantics — a new attempt of the step is
    // queued (ADR-0043/ADR-0055), asserted through the API.
    await page.getByTestId("dock-return-control").click();
    const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
    for (;;) {
      const rows = await runNodes(page.request, state.runId);
      const row = rows.find((n) => n.node_id === state.agentNodeId);
      if (row && row.attempt_count >= 2) break;
      if (Date.now() > deadline)
        throw new Error(
          `no new attempt of ${state.agentNodeId} after the hand-back (attempt_count: ${
            row?.attempt_count ?? "absent"
          }; why: ${await failedNodeReasons(page.request, state.runId, rows)}) — ADR-0043/ADR-0055 semantics unmet`,
        );
      await sleep(3_000);
    }
    await evidence(
      page,
      `journey-e-handed-back-${STAMP}`,
      `control returned to the factory: a new attempt of ${state.agentNodeId} is queued (attempt_count ≥ 2 via the API; the step's own ceiling is ${RETRY_MAX_ATTEMPTS}, so a bad answer on this hand-back attempt is retried once before the gate in step d) — the accepted takeover semantics (ADR-0043/ADR-0055)`,
    );
    await checkShellScreen(page, "workbench-after-takeover", stopWatching ?? undefined);
  });

  test("d — approve the run's human gate from the project overview at 390x844", async ({ page }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    // The run's plan step and journey_step's re-queued attempt 2 (the step e
    // hand-back runs it again) precede the gate, so the approval may take the
    // whole gate window.
    state.approvalId = await waitForApproval(page.request, state.runId);

    // PHONE width: 390x844, as the journey demands.
    await page.setViewportSize({ width: 390, height: 844 });
    // Finding 03 retired the Inbox page; the decision surface that carries a
    // gate to a person is the project overview's Needs-You fan (same
    // attention read, still one callout per pending gate row).
    await gotoApp(page, `/p/${state.projectId}`);
    await expect(page.getByTestId("project-attention")).toBeVisible({ timeout: 30_000 });
    const tid = testidOf(state.approvalId);
    const card = page.getByTestId(`project-attention-decision-${tid}`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The card decides through the ONE decision path (finding 04/05: the
    // project overview carries the shared `DecisionBar`, not its own
    // Approve→Confirm callout). The helper is the proof: the click holds ~5s
    // behind Undo instead of POSTing, the decide POST rides the wire once with
    // `{decision: "approved"}` and the row's CAS version, and no second POST
    // follows.
    await expect(
      card.getByTestId("decision-bar"),
      "finding 05: the project overview's gate card decides through the shared DecisionBar",
    ).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "overview-phone-approval", stopWatching ?? undefined);
    await evidence(
      page,
      `journey-d-decision-${STAMP}`,
      `at 390x844 the project overview decision callout for the run's gate shows the shared decision bar with its fixed verbs (approval …${state.approvalId.slice(-8)})`,
    );

    // Approve through the bar — the same decision the old Inbox card's Confirm
    // approve made.
    await decideGate(card, "approve", undefined, { timeoutMs: 60_000 });

    // Asserted via the API: the approval is decided and the run moves on.
    await waitForApprovalDecided(page.request, state.runId);
    await expect(card).toBeHidden({ timeout: 60_000 });
    await evidence(
      page,
      `journey-d-decided-${STAMP}`,
      `the gate was approved from the phone-width project overview; the run's approve step is succeeded via the API and the callout left the Needs-You fan`,
    );
    await page.setViewportSize({ width: 1500, height: 950 });
  });

  test("f — assistant via ⌘J: add a step to the draft, then undo all", async ({ page }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    await gotoApp(page, `/workflows/${state.pipeline.id}`);
    await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });

    // The assistant edits the pipeline's NEWEST open draft (the
    // workflow.draft lookup takes the newest non-published draft), and the
    // lab is shared: a previous run's abandoned draft (cloned from an older
    // revision, with no journey_step in it) shadows the ask — the assistant
    // honestly asks where the step should go instead of editing, and the
    // marker never lands. Open THIS run's own fresh draft from the newest
    // published revision (the History tab's clone control — step b made
    // step a's draft a revision, so it is no longer open), so the anchor
    // node computed below exists in the draft the assistant finds, then go
    // back to the workflow page for the ⌘J popover.
    await openFreshDraft(page, state.pipeline.id);
    const freshDraftId = new URL(page.url()).pathname.split("/").pop() as string;
    console.log(`journey f: this run's fresh draft of r${state.revisionBefore + 1} is open`);
    // The undo-all gate's baseline: the draft's content BEFORE the ask, so
    // "returns to its original content" is proven, not guessed.
    const originalDraftYaml = await draftYaml(page.request, freshDraftId);
    await gotoApp(page, `/workflows/${state.pipeline.id}`);
    await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });

    // ⌘J opens the assistant popover (finding 08 gave Ask its own chord;
    // Ctrl-J on a headless browser where Meta is not delivered).
    await page.keyboard.press("Meta+j");
    const popover = page.getByTestId("assistant-popover");
    if (!(await popover.isVisible().catch(() => false))) await page.keyboard.press("Control+j");
    await expect(popover).toBeVisible({ timeout: 10_000 });

    // Fresh context: the popover auto-loads the user's LATEST conversation —
    // the run shared with earlier specs (the lab's 78-message conversation)
    // confuses the model. The header's New-conversation control clears it
    // (p7-wire); with an empty conversation the body is also not scrollable,
    // so the a11y pass that follows stays meaningful.
    const fresh = page.getByTestId("assistant-new-conversation");
    if (!(await fresh.isVisible().catch(() => false)))
      throw new Error(
        "the popover header has no New-conversation control (assistant-new-conversation) — the lab build predates the p7-wire fix; the reused conversation would poison the ask",
      );
    await fresh.click();
    await checkShellScreen(page, "assistant-popover", stopWatching ?? undefined);

    // The marker must not predate the ask (a crashed earlier journey run).
    const stale = await draftsContainingStep(page.request, ASSISTANT_STEP_NAME, "human.approval");
    if (stale.length > 0)
      throw new Error(
        `pre-existing lab state: draft(s) ${stale
          .map((d) => d.id)
          .join(
            ", ",
          )} already contain ${ASSISTANT_STEP_NAME} — the marker would not be this ask's proof`,
      );

    // Compute the anchor from the NEWEST published document (the draft the
    // assistant edits is built from it): a node whose outgoing edge no
    // successor guards — no `nodes.<x>.*` binding in the successor's config,
    // no `when` guard naming it. (plan→approve is guarded: approve reads
    // nodes.plan.*)
    const doc = await revisionDocument(page, state.revisionDigest);
    const anchor = unguardedAnchor(parseTopLevelNodes(doc));
    if (!anchor)
      throw new Error(
        `no unguarded outgoing edge among the newest revision's nodes: ${
          parseTopLevelNodes(doc)
            .map((n) => n.id)
            .join(", ") || "none parsed"
        } — cannot pick a safe insert position`,
      );
    console.log(`journey f: anchor ${anchor.anchor} → ${anchor.successor} (unguarded)`);
    const ask = `Add a human approval step named ${ASSISTANT_STEP_NAME} after ${anchor.anchor} in ${PIPELINE_SLUG}'s draft`;
    const composer = page.getByTestId("assistant-composer-input");
    /** What the last turn carried: a retry re-sends those SAME words. */
    let lastSend: { via: "composer" | "approval"; text: string } = { via: "composer", text: ask };
    /** The journey's only ask path: type it in the composer, press Send. */
    const sendThroughComposer = async (text: string): Promise<void> => {
      await composer.fill(text);
      await page.getByTestId("assistant-send").click();
      lastSend = { via: "composer", text };
    };
    await sendThroughComposer(ask);

    // Follow the assistant's bounded loop, at most 3 assistant turns: the ask
    // is turn 1 and every follow-up (a plain “make that change now”, the
    // re-send of an ask whose turn failed, an answered question, a retried
    // approval) is the
    // next turn. A question card is answered by clicking the model-written
    // option that best matches the ask (preferring the anchor's name) — and
    // the next user message must carry the option's label VERBATIM as plain
    // text (spec 08 / ADR-0050). An approval card gets Retry: at trust
    // ask_risky a draft edit should not be approval-gated. The loop breaks
    // only when the change is REAL — a draft's YAML carries journey_check
    // (via API). The change chip is asserted afterwards, not as the gate: a
    // previous run's chip would otherwise look like success. e2e-jf2: a turn
    // that ends WITHOUT acting (no error, no question card, no approval card,
    // draft lacks the marker) gets ONE plain user follow-up — “Please make that
    // change now.” — a real user would.
    let followUps = 0;
    /** Error kinds already retried — assistant-lost-ask allows one each. */
    const retriedErrors = new Set<string>();
    const deadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
    /**
     * EVIDENCE: the popover's last assistant reply, truncated to 400 chars.
     * The assistant's replies never reach any server log, so when a
     * follow-up turn does not land the step the reply text is the only
     * way to see WHY it did not — log it on every such turn.
     */
    const lastAssistantReply = async (): Promise<string> => {
      const replies = page.getByTestId("assistant-msg-assistant");
      const n = await replies.count();
      if (n === 0) return "(no assistant reply rendered)";
      const text = (((await replies.nth(n - 1).textContent()) ?? "").trim() || "(empty)").replace(
        /\s+/g,
        " ",
      );
      return text.slice(0, 400);
    };
    for (;;) {
      // The draft itself is the gate: a step that IS in the draft — named
      // journey_check, of the approval kind — counts as landed, whatever
      // follow-up landed it (the journey must not fail because the step
      // arrived on a follow-up turn while the loop was counting turns).
      const landed =
        (await draftsContainingStep(page.request, ASSISTANT_STEP_NAME, "human.approval")).length > 0;
      if (landed) {
        console.log(`journey f: the assistant landed ${ASSISTANT_STEP_NAME} — loop done`);
        break;
      }
      const error = page.getByTestId("assistant-error");
      if (await error.isVisible().catch(() => false)) {
        const errorText = ((await error.textContent()) ?? "(no text)").trim();
        // assistant-lost-ask (acceptance 30): a failed turn stores nothing
        // (ADR-0034), so the UI puts the ask BACK in the composer and says the
        // question was not sent. A user whose send failed sends the SAME words
        // again — never a context-less “please continue” into a conversation
        // that never received the ask. ONE retry per error kind, and it counts
        // against the same 3-turn budget (never more than 3 follow-up assistant
        // turns total).
        const kind = /step limit|completion cap/i.test(errorText)
          ? "step-limit"
          : /isn't configured/i.test(errorText)
            ? "not-configured"
            : errorText.replace(/\d+/g, "#").slice(0, 120).toLowerCase();
        if (!retriedErrors.has(kind) && followUps < 3) {
          retriedErrors.add(kind);
          followUps += 1;
          if (lastSend.via === "approval") {
            // A failed Retry stored nothing either, so its card is still
            // pending — Retry again is the same action, not a new message.
            const retry = page.getByTestId("assistant-approval-confirm");
            await expect(
              retry,
              `a failed approval Retry leaves the card pending (error: ${errorText})`,
            ).toBeVisible();
            console.log(
              `journey f: approval Retry failed (${kind}) — retried once (turn ${followUps}/3)`,
            );
            await retry.click();
          } else {
            // The composer holds the only copy of the ask left: assert the UI
            // really returned it, then re-send it verbatim.
            await expect
              .poll(async () => (await composer.inputValue()).trim(), {
                message: `a failed send must return the ask to the composer (error: ${errorText})`,
                timeout: 15_000,
              })
              .toBe(lastSend.text.trim());
            console.log(
              `journey f: turn failed (${kind}) — the ask is back in the composer, sending it again (turn ${followUps}/3)`,
            );
            await page.getByTestId("assistant-send").click();
          }
          // The retry is a NEW turn — bound the wait on its own completion.
          await waitForAssistantTurn(page);
          continue;
        }
        throw new Error(
          `the assistant errored: ${errorText} — is the assistant tool loop (be-as-loop) / popover wiring (p7-wire) live in this lab? (no ${kind} retry left after ${followUps} follow-up turn(s))`,
        );
      }
      if (followUps >= 3) {
        console.log(`EVIDENCE leg-f-followup-${followUps}: ${await lastAssistantReply()}`);
        throw new Error(
          `the assistant still has not landed ${ASSISTANT_STEP_NAME} after 3 follow-up turns`,
        );
      }
      if (
        await page
          .getByTestId("assistant-question")
          .isVisible()
          .catch(() => false)
      ) {
        const options = page.getByTestId("assistant-question-option");
        const count = await options.count();
        if (count === 0) throw new Error("the question card rendered no options to click");
        const labels = await Promise.all(
          Array.from({ length: count }, async (_, i) =>
            ((await options.nth(i).textContent()) ?? "").trim(),
          ),
        );
        const idx = labels.findIndex((l) => l.toLowerCase().includes(anchor.anchor.toLowerCase()));
        const best = idx >= 0 ? idx : 0;
        const label = labels[best];
        const userBefore = await page.getByTestId("assistant-msg-user").count();
        // A failed answer-turn comes back as this same label in the composer
        // (assistant-lost-ask), so the retry re-sends the label verbatim.
        lastSend = { via: "composer", text: label };
        await options.nth(best).click();
        // Issue #63 moved this assertion EARLIER: the reply travels as a
        // plain-text user message equal to the label, and the click shows
        // it as the person's own transcript row immediately (an optimistic
        // row the server's echo later replaces) — not only when the answer
        // turn completes. Assert it verbatim at once, then bound the wait
        // on the turn's own completion.
        await expect
          .poll(
            async () => {
              const msgs = page.getByTestId("assistant-msg-user");
              return (await msgs.count()) === userBefore + 1
                ? ((await msgs.nth(userBefore).textContent()) ?? "").trim()
                : "";
            },
            {
              timeout: 15_000,
              message: `the option click shows "${label}" as the person's message at once`,
            },
          )
          .toBe(label);
        await waitForAssistantTurn(page);
        followUps += 1;
        console.log(`journey f: question answered with "${label}" (turn ${followUps}/3)`);
        console.log(`EVIDENCE leg-f-followup-${followUps}: ${await lastAssistantReply()}`);
        continue;
      }
      if (
        await page
          .getByTestId("assistant-approval")
          .isVisible()
          .catch(() => false)
      ) {
        lastSend = { via: "approval", text: "" };
        await page.getByTestId("assistant-approval-confirm").click(); // Retry
        // The Retry re-runs the turn — bound the wait on its own completion.
        await waitForAssistantTurn(page);
        followUps += 1;
        console.log(`journey f: approval card retried (turn ${followUps}/3)`);
        continue;
      }
      // e2e-jf2: the turn ended WITHOUT acting — no error, no question card and
      // no approval card (all handled above) and the draft still lacks the
      // marker. Lab evidence (model flint): a turn can end by describing what
      // it found WITHOUT changing anything and without a question/approval
      // card. A real user would simply say “please make that change now”: send
      // ONE plain user follow-up.
      // The turn that produced this state has settled (no error / card above):
      // wait for the turn's own completion — the popover's in-flight indicator
      // clears / a new assistant message appears — before following up.
      await waitForAssistantTurn(page);
      // The turn may have landed while we waited; the draft is the gate.
      if (
        (await draftsContainingStep(page.request, ASSISTANT_STEP_NAME, "human.approval")).length > 0
      )
        break;
      // assistant-lost-ask: the failure can surface only during that wait. The
      // error branch above re-sends the SAME ask, so hand it over — a plain
      // follow-up here would reach a conversation that never got the ask.
      if (await error.isVisible().catch(() => false)) continue;
      followUps += 1;
      console.log(
        `journey f: turn ended without acting — one plain follow-up (turn ${followUps}/3)`,
      );
      console.log(`EVIDENCE leg-f-followup-${followUps}: ${await lastAssistantReply()}`);
      await sendThroughComposer("Please make that change now.");
      if (Date.now() > deadline) {
        console.log(`EVIDENCE leg-f-followup-${followUps}: ${await lastAssistantReply()}`);
        throw new Error(
          `no draft of ${PIPELINE_SLUG} carries ${ASSISTANT_STEP_NAME} after the ask — the assistant never landed the change (assistant tool loop be-as-loop?)`,
        );
      }
      await waitForAssistantTurn(page);
    }

    // The change chip counts its change(s) — expanded, so its rows show
    // (the chip collapses by default and renders no rows closed).
    const chip = page.getByTestId("assistant-change-chip");
    await expect(chip).toBeVisible();
    expect((await chip.textContent()) ?? "", "the change chip counts its changes").toMatch(
      /\d+\s+changes?/,
    );
    const chipRow = page.getByTestId("assistant-change-row").first();
    if (!(await chipRow.isVisible().catch(() => false)))
      await page.getByTestId("assistant-change-chip-toggle").click();
    await expect(chipRow).toBeVisible();

    const withStep = await draftsContainingStep(page.request, ASSISTANT_STEP_NAME, "human.approval");
    await evidence(
      page,
      `journey-f-changed-${STAMP}`,
      `the assistant's change chip counts its change(s), and the draft …${withStep[0].id.slice(-8)} now carries a step named ${ASSISTANT_STEP_NAME} of the human.approval kind (via the API)`,
    );

    // Undo all — the draft no longer contains the step, and its content is
    // back to the original captured before the ask (via the API).
    await page.getByTestId("assistant-change-undo-all").click();
    await expect
      .poll(async () => (
        (await draftsContainingStep(page.request, ASSISTANT_STEP_NAME, "human.approval")).length
      ), {
        timeout: 60_000,
      })
      .toBe(0);
    const restoredYaml = await draftYaml(page.request, freshDraftId);
    expect(
      topNodeSignature(restoredYaml),
      "undo all: the draft returned to its original content",
    ).toBe(topNodeSignature(originalDraftYaml));
    await evidence(
      page,
      `journey-f-undone-${STAMP}`,
      `undo all: no draft of ${PIPELINE_SLUG} carries a step named ${ASSISTANT_STEP_NAME} of the approval kind any more, and the draft …${freshDraftId.slice(-8)} is back to its original content (via the API)`,
    );
  });
});
