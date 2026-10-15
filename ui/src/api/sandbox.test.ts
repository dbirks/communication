/**
 * Enforcement copy has to stay honest: a worker that never verified, or that
 * runs `permissive-dev`, must not be able to render as healthy, and a unit that
 * ran without a verified sandbox must never read as "sandboxed".
 */
import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_COPY,
  SANDBOX_REASON_COPY,
  SANDBOX_STAGE_COPY,
  UNKNOWN_VOLUME_WARNING,
  isolationWarning,
  sandboxFailureCopy,
  shortVolume,
  systemIntegrity,
  turnSandboxCopy,
  workerSandboxCopy,
  workerSandboxState,
} from "./sandbox";
import { systemSandboxFixture, turnSandboxFixture, workspaceFixture } from "../test/fakes";
import type { SystemSandbox, TurnSandbox, WorkerSandboxStatus } from "./types";

const requiredWorker = systemSandboxFixture.workers[0];
const permissiveWorker = systemSandboxFixture.workers[1];

describe("workerSandboxCopy + state", () => {
  it("calls an unverified `required` worker a failed capability, not a healthy one", () => {
    const row = { ...requiredWorker, verified: false } as WorkerSandboxStatus;
    expect(workerSandboxState(row)).toBe("failed");
    expect(workerSandboxCopy(row)).toContain("no verified launch yet");
    expect(workerSandboxCopy(row)).toContain("not a capability");
  });

  it("labels permissive-dev as not a boundary in the strongest words available", () => {
    expect(workerSandboxCopy(permissiveWorker)).toContain("NOT a security boundary");
    expect(workerSandboxState(permissiveWorker)).toBe("waiting");
  });

  it("treats `disabled` as a finding", () => {
    const disabled = { ...permissiveWorker, enforcement: "disabled" } as WorkerSandboxStatus;
    expect(workerSandboxState(disabled)).toBe("failed");
    expect(workerSandboxCopy(disabled)).toContain("NO sandbox");
  });

  it("passes only a verified launch under required", () => {
    expect(workerSandboxState(requiredWorker)).toBe("done");
    expect(workerSandboxCopy(requiredWorker)).toContain("verified");
  });

  it("keeps an unlisted enforcement value visible instead of inventing one", () => {
    const odd = { ...permissiveWorker, enforcement: "yolo" } as unknown as WorkerSandboxStatus;
    expect(workerSandboxCopy(odd)).toContain("yolo");
  });
});

describe("isolationWarning", () => {
  it("says isolation=none for every mode that is not required", () => {
    expect(isolationWarning("permissive-dev")).toContain("isolation=none");
    expect(isolationWarning("disabled")).toContain("isolation=none");
  });

  it("stays silent for required and for a record that reported no mode", () => {
    expect(isolationWarning("required")).toBeNull();
    expect(isolationWarning(null)).toBeNull();
    expect(isolationWarning(undefined)).toBeNull();
  });
});

describe("turnSandboxCopy", () => {
  it("states a completed chain, and states egress honestly", () => {
    const copy = turnSandboxCopy(turnSandboxFixture);
    expect(copy).toContain("verified");
    // `network_enforced: false` on the agent-turn profile is reported, not hidden.
    expect(copy).toContain("egress NOT enforced");
  });

  it("says nothing ran, quoting stage and reason, when the chain stopped", () => {
    const stopped = {
      ...turnSandboxFixture,
      stage: "grant_assert",
      reason: "temp_path_grant",
      child_started: false,
      verified: false,
    } as TurnSandbox;
    const copy = turnSandboxCopy(stopped);
    expect(copy).toContain("Nothing ran");
    expect(copy).toContain("the grants the policy promised could not be asserted");
    expect(copy).toContain("a grant pointed at a temp path");
    expect(copy).toContain("no process was ever started");
  });

  it("calls an unverified run under a real backend unsandboxed", () => {
    const unverified = { ...turnSandboxFixture, verified: false } as TurnSandbox;
    expect(turnSandboxCopy(unverified)).toContain("treat this unit as unsandboxed");
  });

  it("quotes every stage and reason the wire can carry", () => {
    for (const stage of ["probe", "profile", "policy_assert", "grant_assert", "exec", "runtime"]) {
      expect(SANDBOX_STAGE_COPY[stage]).toBeTruthy();
      expect(sandboxFailureCopy(stage, null)).toContain(SANDBOX_STAGE_COPY[stage]);
    }
    for (const reason of Object.keys(SANDBOX_REASON_COPY)) {
      expect(sandboxFailureCopy("probe", reason)).toContain(SANDBOX_REASON_COPY[reason]);
    }
    // An enum value this build does not know is quoted raw, never rewritten.
    expect(sandboxFailureCopy("probe", "quantum_flip")).toContain("quantum_flip");
    expect(sandboxFailureCopy("warp", null)).toContain("warp");
  });
});

describe("systemIntegrity", () => {
  const mk = (workers: SystemSandbox["workers"]) =>
    ({
      workers,
      pinned_backend_version: "0.80.0",
      policy_digest: workspaceFixture.volume_id,
    }) as SystemSandbox;

  it("flags backend version drift across the fleet", () => {
    const drifted = mk([
      requiredWorker,
      { ...requiredWorker, worker_id: "w2", backend_version: "0.81.0" },
    ]);
    expect(systemIntegrity(drifted).join(" ")).toContain("drift");
  });

  it("says a single-worker fleet cannot show agreement at all", () => {
    expect(systemIntegrity(mk([requiredWorker])).join(" ")).toContain("not a fleet");
  });

  it("is quiet when a multi-worker fleet agrees", () => {
    expect(systemIntegrity(mk([requiredWorker, { ...requiredWorker, worker_id: "w2" }]))).toEqual(
      [],
    );
  });
});

describe("volume identity display", () => {
  it("shortens a measured identity without pretending it is a device number", () => {
    expect(shortVolume(workspaceFixture.volume_id)).toBe("vol-7c1f7c");
    expect(shortVolume("d3adb33fdeadbeef")).toBe("vol-d3adb3");
    expect(shortVolume(null)).toBe("unknown");
    expect(shortVolume("")).toBe("unknown");
  });

  it("carries ADR-0017's refusal in the warning itself", () => {
    expect(UNKNOWN_VOLUME_WARNING).toContain("no M3 workspace may bind here");
  });

  it("uses the wire values verbatim as enforcement words", () => {
    expect(ENFORCEMENT_COPY.required.word).toBe("required");
    expect(ENFORCEMENT_COPY["permissive-dev"].word).toBe("permissive-dev");
    expect(ENFORCEMENT_COPY.disabled.word).toBe("disabled");
  });
});
