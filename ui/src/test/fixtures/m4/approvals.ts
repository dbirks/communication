/**
 * Approval fixtures shaped like contract route 35, covering the three arms the
 * run inspector renders: a gate waiting for you, a gate you cannot decide, and
 * a gate already closed.
 */
import type { ApprovalDetail } from "../../../lib/pipeline/contract";
import { decidedRun, gateRun } from "./runs";

/** W3: alice is a maintainer, so the decision form is hers. */
export const pendingApproval: ApprovalDetail = {
  id: "01J8APPROVAL0000000000A",
  project_id: "prj_01J8ACME",
  run_id: gateRun.id,
  node_execution_id: "01J8NODE000001",
  node_instance_key: "/approve",
  kind: "pipeline_gate",
  summary:
    "Plan for “Add tenant-scoped audit retention”: four files, one migration, no new dependency. The loop will start as soon as this gate is approved.",
  artifact_refs: [
    {
      id: "art_01J8PLAN",
      name: "plan.md",
      kind: "markdown",
      sha256: "sha256:2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b",
      size_bytes: 2048,
      sensitivity: "standard",
    },
    {
      id: "art_01J8DIFF",
      name: "touch-list.json",
      kind: "json",
      sha256: "sha256:3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c",
      size_bytes: 512,
      sensitivity: "restricted",
    },
  ],
  approver_roles: ["maintainer"],
  approver_user_ids: ["usr_alice"],
  deadline_at: "2026-08-01T10:44:02Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  decision: null,
  comments: null,
  decided_by: null,
  decided_at: null,
  version: 1,
  created_at: "2026-07-31T10:44:02Z",
};

/** A closed gate: rejected, with the decision maker and the comments. */
export const rejectedApproval: ApprovalDetail = {
  ...pendingApproval,
  id: "01J8APPROVAL0000000000B",
  // The gate that was rejected belongs to the run that rejection failed, not to
  // the run still waiting at its own gate.
  run_id: decidedRun.id,
  state: "decided",
  decision: "rejected",
  comments: "The plan changes the digest scope; that needs an ADR first.",
  decided_by: "usr_alice",
  decided_at: "2026-07-31T14:02:19Z",
  version: 2,
};

/** W3's second arm: bob can read the card and must not be able to decide it. */
export const notApproverView = {
  viewer: "usr_bob",
  canDecide: false,
  /** 403's copy, verbatim from `docs/m4-contract.md` § 7.2 W3. */
  copy: "you are not a designated approver for this gate",
  conflictError: "someone decided this gate first — the version you posted is stale",
};
