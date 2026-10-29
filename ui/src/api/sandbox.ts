/**
 * Sandbox honesty: the words this app is allowed to use about enforcement.
 *
 * `05-workspaces-security-secrets.md`'s first acceptance gate is honest
 * reporting, not success, and `api/openapi.yaml` says the same about
 * `GET /api/v1/system/sandbox`: "a green check next to `required` on a worker
 * that never verified would be a false guarantee". Everything here is a
 * *decision about wording*, so it lives in one module and every screen quotes
 * the same sentence — an alert on `/ops` and a chip on a conversation must not
 * disagree about what `verified: false` means.
 *
 * What no string here claims: tenant isolation (one Unix uid; D-025 **Open**),
 * enforced egress for a real model turn (the `agent-turn` profile runs with
 * egress unenforced; D-021 stays **Proposed**), or cross-host workspace
 * rehydration (D-024 stays **Open**).
 */
import type { SandboxEnforcement, SystemSandbox, TurnSandbox, WorkerSandboxStatus } from "./types";
import type { StateName } from "../components/ds/states";

/** How loudly each configured enforcement mode must be labelled. */
export const ENFORCEMENT_COPY: Record<SandboxEnforcement, { word: string; note: string }> = {
  required: {
    word: "required",
    note: "a unit is never launched unless the sandbox verifies first",
  },
  "permissive-dev": {
    word: "permissive-dev",
    note: "NOT a security boundary: this worker launches agents with the sandbox configured permissively",
  },
  disabled: {
    word: "disabled",
    note: "NO sandbox: agents run with the worker's own filesystem access",
  },
};

/** Enforcement mode → state set (`disabled` is a finding, never neutral). */
export const ENFORCEMENT_STATE: Record<SandboxEnforcement, StateName> = {
  required: "done",
  "permissive-dev": "waiting",
  disabled: "failed",
};

/** State set for one worker's sandbox row: mode *and* verdict together, never mode alone. */
export function workerSandboxState(worker: WorkerSandboxStatus): StateName {
  // `disabled` is a finding whatever the verdict: there is no sandbox to verify.
  if (worker.enforcement === "disabled") return "failed";
  // A `required` worker that has never verified promised something it has not
  // shown, which is worse than a worker openly configured permissively.
  if (!worker.verified) return worker.enforcement === "required" ? "failed" : "waiting";
  return ENFORCEMENT_STATE[worker.enforcement] ?? "queued";
}

/** One honest sentence about a worker's sandbox capability. */
export function workerSandboxCopy(worker: WorkerSandboxStatus): string {
  const mode = modeCopy(worker);
  if (!worker.verified) {
    return `${mode.word} · no verified launch yet — this worker has not been observed running a unit under its sandbox, so it is not a capability · ${mode.note}`;
  }
  return `${mode.word} · verified · ${mode.note}`;
}

function modeCopy(worker: Pick<WorkerSandboxStatus, "enforcement">): {
  word: string;
  note: string;
} {
  return (
    ENFORCEMENT_COPY[worker.enforcement as SandboxEnforcement] ?? {
      word: worker.enforcement,
      note: "unknown enforcement mode — reported verbatim because this build has no words for it",
    }
  );
}

/** Where the ADR-0019 chain stopped, in the words the enum actually means. */
export const SANDBOX_STAGE_COPY: Record<string, string> = {
  none: "the chain completed",
  probe: "the kernel/backend probe failed",
  profile: "the pinned profile was rejected",
  policy_assert: "the assembled policy did not match the pinned digest",
  grant_assert: "the grants the policy promised could not be asserted",
  exec: "the launch itself was refused",
  runtime: "the sandbox reported a failure while the unit ran",
};

/** ADR-0019 D6 reasons — quoted, never paraphrased into "an error occurred". */
export const SANDBOX_REASON_COPY: Record<string, string> = {
  binary_missing: "the sandbox binary is missing",
  landlock_unavailable: "the kernel offers no Landlock",
  fs_unverified: "filesystem rule mediation could not be verified",
  tcp_unverified: "TCP rule mediation could not be verified",
  af_unix_not_mediated: "AF_UNIX sockets are not mediated by this backend",
  profile_invalid: "the profile was rejected by the backend",
  grant_mismatch: "the requested grants did not match the policy",
  temp_path_grant: "a grant pointed at a temp path",
  cwd_not_granted: "the working directory was not inside a grant",
  policy_delegation_refused: "the backend refused to enforce the pinned policy",
  deny_unsupported: "a required deny rule is unsupported here",
  egress_check_failed: "the egress check failed",
};

/** Words for a stage/reason pair, degrading to the raw enum, never to "error". */
export function sandboxFailureCopy(stage: string, reason: string | null): string {
  const stageCopy = SANDBOX_STAGE_COPY[stage] ?? `stopped at stage ${stage}`;
  const reasonCopy = reason ? (SANDBOX_REASON_COPY[reason] ?? `reason ${reason}`) : null;
  return reasonCopy ? `${stageCopy}: ${reasonCopy}` : stageCopy;
}

/**
 * The enforcement verdict sentence for one launched unit. `child_started` is
 * the fact `12-test-strategy` case 13 asks about — was a process ever exec'd —
 * so it is always stated, in both directions.
 */
export function turnSandboxCopy(record: TurnSandbox): string {
  if (record.stage !== "none") {
    return `Nothing ran: ${sandboxFailureCopy(record.stage, record.reason ?? null)}${
      record.child_started ? "" : " — no process was ever started"
    }`;
  }
  const mode = record.enforcement
    ? (ENFORCEMENT_COPY[record.enforcement]?.word ?? record.enforcement)
    : "unknown enforcement";
  return record.verified
    ? `Ran under ${mode} with the pinned policy verified${
        record.network_enforced ? " and enforced egress" : ", egress NOT enforced"
      }`
    : `Ran under ${mode} WITHOUT a verified sandbox — treat this unit as unsandboxed`;
}

/** Volume identity shorter than a digest, still distinguishable. */
export function shortVolume(volumeId: string | null | undefined): string {
  if (!volumeId) return "unknown";
  const hex = volumeId.replace(/^sha256:/, "");
  return hex ? `vol-${hex.slice(0, 6)}` : "unknown";
}

/** The warning for ADR-0017 D2's `unknown volume` refusal, in plain words. */
export const UNKNOWN_VOLUME_WARNING = "This volume isn't known, so no workspace can use it.";

/**
 * The `isolation="none"` label `05` requires on every event from a launch that
 * is not `required`. Null for a verified-by-configuration unit; a sentence for
 * the rest, so a screen cannot render a permissive launch without saying so.
 */
export function isolationWarning(
  enforcement: SandboxEnforcement | null | undefined,
): string | null {
  if (!enforcement || enforcement === "required") return null;
  const mode = ENFORCEMENT_COPY[enforcement] ?? {
    word: enforcement,
    note: "unknown enforcement mode",
  };
  return `isolation=none (${mode.word}: ${mode.note})`;
}

/**
 * Fleet-integrity findings from `GET /api/v1/system/sandbox`: a worker whose
 * backend version or policy digest disagrees with the fleet pin, or a fleet of
 * one. Empty means "nothing to warn about", never "the system is secure".
 */
export function systemIntegrity(
  system: Pick<SystemSandbox, "workers" | "pinned_backend_version" | "policy_digest">,
): string[] {
  const findings: string[] = [];
  if (system.workers.length < 2) {
    findings.push(
      "one worker reports, so this is not a fleet: version and policy agreement cannot be observed across replicas",
    );
  }
  const versions = new Set(system.workers.map((worker) => worker.backend_version ?? "unknown"));
  if (versions.size > 1) {
    findings.push(
      `backend version drift: ${[...versions].sort().join(", ")} against the pinned ${system.pinned_backend_version ?? "(no pin)"}`,
    );
  }
  const digests = new Set(system.workers.map((worker) => worker.backend));
  if (digests.size > 1) {
    findings.push(`backends differ across the fleet: ${[...digests].sort().join(", ")}`);
  }
  return findings;
}
