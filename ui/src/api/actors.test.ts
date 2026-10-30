/**
 * Actor naming: `deciderLabel` (a `decided_by` can name a policy, not a person
 * — ADR-0039), and `useDirectoryRepair`, the reason a person the directory has
 * not named is still a lookup rather than a verdict.
 */
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_REPAIR_ATTEMPTS,
  DIRECTORY_REPAIR_TICK_MS,
  deciderLabel,
  useDirectoryRepair,
} from "./actors";

const nameOf = (userId: string) => (userId === "u-ada" ? "Ada" : `stranger (${userId})`);

describe("deciderLabel", () => {
  it("names a profile policy in words", () => {
    expect(deciderLabel("profile_policy:deny", nameOf)).toBe("the profile's deny policy");
    expect(deciderLabel("profile_policy:preapproved_within_sandbox", nameOf)).toBe(
      "the profile's preapproved policy (sandboxed)",
    );
  });

  it("names a node policy as the step's policy", () => {
    expect(deciderLabel("node_policy:deny", nameOf)).toBe("the step's deny policy");
    expect(deciderLabel("node_policy:preapproved_within_sandbox", nameOf)).toBe(
      "the step's preapproved policy (sandboxed)",
    );
  });

  it("falls back to a bare policy mode for other prefixes", () => {
    expect(deciderLabel("workspace_policy:deny", nameOf)).toBe("policy deny");
    expect(deciderLabel("org_policy:preapproved_within_sandbox", nameOf)).toBe(
      "policy preapproved_within_sandbox",
    );
  });

  it("still names a user through nameOf", () => {
    expect(deciderLabel("u-ada", nameOf)).toBe("Ada");
    expect(deciderLabel("01987a63-3333-7000-8000-abcdef012345", nameOf)).toBe(
      "stranger (01987a63-3333-7000-8000-abcdef012345)",
    );
  });
});

function target(debt: readonly string[], directory: { busy: boolean; settled: string }) {
  const refetch = vi.fn();
  const hook = renderHook(
    ({ busy, settled }: { busy: boolean; settled: string }) =>
      useDirectoryRepair(debt, { busy, settled, refetch }),
    { initialProps: directory },
  );
  return { hook, refetch };
}

describe("useDirectoryRepair", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("asks again the moment the debt is visible, not when the safety tick comes round", () => {
    vi.useFakeTimers();
    const { hook, refetch } = target(["u-bob"], { busy: false, settled: "pending:0" });
    // A request the reader is waiting on cannot wait for a timer: the re-read is
    // already under way by the time the first render is committed. That is what
    // makes a lost directory read a blip rather than a page that misnames
    // somebody for the rest of its life.
    expect(refetch).toHaveBeenCalledTimes(1);

    // A settled directory read re-arms the ask; the tick is only the net under
    // it, for a refetch that leaves the cache untouched.
    hook.rerender({ busy: false, settled: "error:0:1" });
    expect(refetch).toHaveBeenCalledTimes(2);
    hook.rerender({ busy: false, settled: "error:0:2" });
    expect(refetch).toHaveBeenCalledTimes(3);

    // And it stops: an id nobody can name costs DIRECTORY_REPAIR_ATTEMPTS reads,
    // then the page keeps the honest "someone (abc12345)".
    hook.rerender({ busy: false, settled: "error:0:3" });
    vi.advanceTimersByTime(DIRECTORY_REPAIR_TICK_MS * 4);
    expect(refetch).toHaveBeenCalledTimes(DIRECTORY_REPAIR_ATTEMPTS);
  });

  it("does not duplicate a directory read already in flight, and asks when it lands", () => {
    vi.useFakeTimers();
    const { hook, refetch } = target(["u-bob"], { busy: true, settled: "fetching" });
    expect(refetch).not.toHaveBeenCalled();
    hook.rerender({ busy: false, settled: "error" });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the directory can name everyone", () => {
    vi.useFakeTimers();
    const { refetch } = target([], { busy: false, settled: "success:1:0" });
    vi.advanceTimersByTime(DIRECTORY_REPAIR_TICK_MS * 4);
    expect(refetch).not.toHaveBeenCalled();
  });
});
