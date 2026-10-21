/**
 * Chip + capability derivation is the only place the app is allowed to claim
 * "verified". The table: green needs BOTH a verified worker AND an observed
 * nono probe; missing either half is amber; a missing registry is muted —
 * never a guess.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityCell,
  duplicateName,
  hasVerifiedWorker,
  launcherEntry,
  nonoObserved,
  sandboxChip,
  type Launcher,
  type LauncherCapability,
  type SystemSandbox,
} from "./profiles";

const capability = (
  capabilityId: LauncherCapability["capability"],
  result: LauncherCapability["result"] = "not_tested",
): LauncherCapability => ({
  capability: capabilityId,
  result,
  observed_at: result === "observed" ? "2026-10-14T18:00:00Z" : null,
  evidence: result === "observed" ? "docs/compatibility/SANDBOX.md" : null,
});

const launcher = (
  id: string,
  registered: boolean,
  caps: LauncherCapability[] = [capability("acp_session")],
): Launcher => ({
  id,
  display_name: id,
  registered,
  workers_online: registered ? 1 : 0,
  capabilities: caps,
});

const verifiedSandbox: SystemSandbox = {
  workers: [
    { worker_id: "w-1", backend: "nono", enforcement: "required", verified: true },
    { worker_id: "w-2", backend: "nono", enforcement: "permissive-dev", verified: false },
  ],
  pinned_backend_version: "0.80.0",
  policy_digest: `sha256:${"ab".repeat(32)}`,
};

describe("hasVerifiedWorker", () => {
  it("only a required + verified worker counts", () => {
    expect(hasVerifiedWorker(verifiedSandbox)).toBe(true);
    expect(
      hasVerifiedWorker({
        workers: [
          { worker_id: "w", backend: "nono", enforcement: "permissive-dev", verified: true },
        ],
        pinned_backend_version: "0.80.0",
        policy_digest: `sha256:${"ab".repeat(32)}`,
      }),
    ).toBe(false);
    expect(hasVerifiedWorker(null)).toBe(false);
  });
});

describe("sandboxChip", () => {
  it("is muted when the registry read failed (null), whatever the worker says", () => {
    const chip = sandboxChip({ launcherId: "claude", launchers: null, sandbox: verifiedSandbox });
    expect(chip.state).toBe("unavailable");
    expect(chip.text).toBe("status not available yet");
    expect(chip.glyph).toBe("·");
  });

  it("is amber LAUNCHER NOT REGISTERED when the id has no entry or none registered", () => {
    const withMissing = sandboxChip({
      launcherId: "gemini",
      launchers: [launcher("claude", true)],
      sandbox: verifiedSandbox,
    });
    expect(withMissing.state).toBe("not-registered");
    expect(withMissing.text).toBe("LAUNCHER NOT REGISTERED");
    const unregistered = sandboxChip({
      launcherId: "pi",
      launchers: [launcher("pi", false)],
      sandbox: verifiedSandbox,
    });
    expect(unregistered.state).toBe("not-registered");
  });

  it("is green ONLY when both halves have evidence", () => {
    const green = sandboxChip({
      launcherId: "claude",
      launchers: [launcher("claude", true, [capability("nono_required", "observed")])],
      sandbox: verifiedSandbox,
    });
    expect(green.state).toBe("verified");
    expect(green.text).toBe("REQUIRED · VERIFIED");
    expect(green.glyph).toBe("✓");
  });

  it("stays amber when the worker half is missing", () => {
    const chip = sandboxChip({
      launcherId: "claude",
      launchers: [launcher("claude", true, [capability("nono_required", "observed")])],
      sandbox: {
        workers: [{ worker_id: "w", backend: "nono", enforcement: "required", verified: false }],
        pinned_backend_version: "0.80.0",
        policy_digest: `sha256:${"ab".repeat(32)}`,
      },
    });
    expect(chip.state).toBe("not-verified");
    expect(chip.text).toBe("NOT VERIFIED");
  });

  it("stays amber when the probe half is missing", () => {
    const chip = sandboxChip({
      launcherId: "codex",
      launchers: [launcher("codex", true, [capability("nono_required", "not_tested")])],
      sandbox: verifiedSandbox,
    });
    expect(chip.state).toBe("not-verified");
  });

  it("never goes green from a not_supported negative", () => {
    expect(
      nonoObserved(launcher("claude", true, [capability("nono_required", "not_supported")])),
    ).toBe(false);
  });

  it("finds the entry by id", () => {
    expect(launcherEntry([launcher("claude", true)], "claude")?.registered).toBe(true);
    expect(launcherEntry([launcher("claude", true)], "codex")).toBeNull();
    expect(launcherEntry(null, "claude")).toBeNull();
  });
});

describe("capabilityCell", () => {
  it("observed carries the probe date only", () => {
    expect(capabilityCell(capability("acp_session", "observed"))).toEqual({
      glyph: "✓",
      text: "observed 2026-10-14",
    });
  });

  it("not_supported is an observed negative; not_tested claims nothing", () => {
    expect(capabilityCell(capability("resume", "not_supported"))).toEqual({
      glyph: "×",
      text: "not supported",
    });
    expect(capabilityCell(capability("permission_prompts"))).toEqual({
      glyph: "·",
      text: "not tested",
    });
  });
});

describe("duplicateName", () => {
  it("names the copy after its source", () => {
    expect(duplicateName("Claude Code")).toBe("Claude Code copy");
  });
});
