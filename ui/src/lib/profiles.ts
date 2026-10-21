/**
 * Agent-profile status derivation — pure functions with their own tests.
 *
 * Honesty rules (gaps/profiles.md §1, §5):
 * - `REQUIRED · VERIFIED` (green) is a claim about this deployment. It is
 *   allowed only when BOTH halves have evidence: a live worker reports
 *   required sandbox enforcement with a verified launch (`GET
 *   /api/v1/system/sandbox`), and the launcher's `nono_required` capability
 *   cell is `observed` (a recorded probe row — contract C5, ADR-0051).
 *   Missing evidence is an amber "NOT VERIFIED", never green.
 * - A launcher id the registry does not carry (or carries as
 *   `registered: false`) renders `LAUNCHER NOT REGISTERED`: a profile naming
 *   it fails closed at launch (ADR-0019 D6), and that is a fact worth a row,
 *   not an error banner.
 * - When the registry read itself fails (the lab image predates the
 *   endpoint), the chip is muted: "status not available yet". The app never
 *   guesses what the registry would have said.
 * - Capability cells read only recorded evidence: `observed` carries the
 *   probe date, `not_supported` an observed negative, `not_tested` the
 *   default (never pre-filled).
 */
import type { components } from "../api/schema";
import { ENFORCEMENT_COPY } from "../api/sandbox";

export type Launcher = components["schemas"]["Launcher"];
export type LauncherList = components["schemas"]["LauncherList"];
export type LauncherCapability = components["schemas"]["LauncherCapability"];
export type SystemSandbox = components["schemas"]["SystemSandbox"];

export type SandboxChipState = "verified" | "not-registered" | "not-verified" | "unavailable";

export interface SandboxChip {
  state: SandboxChipState;
  /** Handoff glyph: ✓ ! · — the text always travels with it (never colour alone). */
  glyph: string;
  text: string;
  /** What the chip is (or is not) claiming, for the row's `title` attribute. */
  title: string;
}

/** The C5 entry for one launcher id, or null when the id has no entry. */
export function launcherEntry(
  launchers: Launcher[] | null | undefined,
  id: string,
): Launcher | null {
  return launchers?.find((l) => l.id === id) ?? null;
}

/**
 * The worker half of the chip: a live worker whose registration records
 * required enforcement AND a verified launch. A `permissive-dev` or
 * `disabled` worker — or one that never verified — is not evidence.
 */
export function hasVerifiedWorker(sandbox: SystemSandbox | null | undefined): boolean {
  return (sandbox?.workers ?? []).some(
    (worker) => worker.enforcement === "required" && worker.verified,
  );
}

/** The green half of the chip: a recorded probe, not a promise. */
export function nonoObserved(launcher: Launcher | null): boolean {
  return (
    launcher?.capabilities.some(
      (capability) => capability.capability === "nono_required" && capability.result === "observed",
    ) ?? false
  );
}

/**
 * The three chip states of a profile row. `launchers: null` is the registry
 * read failing (not "no launchers exist"): the chip must then say it knows
 * nothing, not pretend the launcher is unregistered.
 */
export function sandboxChip(args: {
  launcherId: string;
  launchers: Launcher[] | null;
  sandbox: SystemSandbox | null | undefined;
}): SandboxChip {
  if (args.launchers == null) {
    return {
      state: "unavailable",
      glyph: "·",
      text: "status not available yet",
      title:
        "The launcher registry could not be read, so no sandbox claim is made for this profile.",
    };
  }
  const entry = launcherEntry(args.launchers, args.launcherId);
  if (entry == null || !entry.registered) {
    return {
      state: "not-registered",
      glyph: "!",
      text: "LAUNCHER NOT REGISTERED",
      title: `No launcher entry for "${args.launcherId}": a profile naming it fails closed at launch.`,
    };
  }
  const workerHalf = hasVerifiedWorker(args.sandbox);
  const probeHalf = nonoObserved(entry);
  if (workerHalf && probeHalf) {
    const evidence = entry.capabilities.find(
      (capability) => capability.capability === "nono_required",
    )?.evidence;
    return {
      state: "verified",
      glyph: "✓",
      text: "REQUIRED · VERIFIED",
      title:
        (evidence ? `Evidence: ${evidence}. ` : "") +
        "A live worker reports required, verified sandbox enforcement and a recorded probe shows nono required.",
    };
  }
  return {
    state: "not-verified",
    glyph: "!",
    text: "NOT VERIFIED",
    title: workerHalf
      ? "A worker reports verified enforcement, but no recorded probe covers this launcher's nono requirement."
      : "No live worker reports verified required-enforcement, so this profile has no verified sandbox here.",
  };
}

/** One C5 capability cell: glyph + words, evidence dates only. */
export function capabilityCell(capability: LauncherCapability): { glyph: string; text: string } {
  if (capability.result === "observed") {
    const day = capability.observed_at?.slice(0, 10) ?? "";
    return { glyph: "✓", text: day ? `observed ${day}` : "observed" };
  }
  if (capability.result === "not_supported") {
    return { glyph: "×", text: "not supported" };
  }
  return { glyph: "·", text: "not tested" };
}

/** `Duplicate…` names the copy after its source. */
export function duplicateName(name: string): string {
  return `${name} copy`;
}

/** The worker's enforcement mode word, as the fleet-integrity wording says it. */
export function enforcementWord(enforcement: "required" | "permissive-dev" | "disabled"): string {
  return ENFORCEMENT_COPY[enforcement].word;
}
