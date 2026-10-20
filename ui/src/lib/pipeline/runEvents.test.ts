/**
 * `projectRun`'s forward guard (issue 2, header-status2): the fold replays
 * the journal's whole tail over every refetched API baseline, so a lifecycle
 * frame journaled BEFORE the fetch — the takeover return's `run.resumed`
 * (`paused → queued`) when the run has started executing again and no later
 * `run.*` frame is journaled — must not pin the run status over the row the
 * API served. A frame may move the status only FORWARD from the baseline,
 * along the run machine (`runtime`'s `runTransitions`).
 */
import { describe, expect, it } from "vitest";
import type { RunDetail, RunStatus } from "./contract";
import { wireRun, wireRunEvent } from "../../test/fixtures/m4/wire";
import { projectRun, type RunBaseline } from "./runEvents";

function runBaseline(status: RunStatus): RunBaseline {
  return { run: { ...wireRun, assignment_id: null, status } as RunDetail };
}

describe("the run lifecycle fold keeps the API baseline authoritative", () => {
  it("does not pin QUEUED over a refetched running baseline after a human takeover's return", () => {
    // The real journal tail of a takeover: the pause, then the return —
    // `run.resumed` naming the park it cleared (paused_reason
    // `human_takeover`, destination `paused → queued`). The run then leased
    // and started executing again with NO further `run.*` frame, and the
    // workbench refetched its baseline while `running`.
    const baseline = runBaseline("running");
    const events = [
      wireRunEvent("run.paused", { paused_reason: "human_takeover" }, { global_seq: 9601 }),
      wireRunEvent("run.resumed", { paused_reason: "human_takeover" }, { global_seq: 9602 }),
    ];
    const projected = projectRun(baseline, events);
    expect(projected.run?.status).toBe("running");
    expect(projected.run?.paused_reason).toBeNull();
  });

  it("lets the gate's resume clear the park — `waiting_human → running` is forward", () => {
    // 2afa9fd's gate-resume behaviour: the decide commit + the advancer's
    // move with its own `run.resumed` naming the cleared gate park.
    const baseline = runBaseline("waiting_human");
    const events = [
      wireRunEvent(
        "approval.decided",
        { approval_id: "a1", decision: "approved", version: 2 },
        {
          global_seq: 9611,
        },
      ),
      wireRunEvent("run.resumed", { paused_reason: "waiting_human" }, { global_seq: 9612 }),
    ];
    expect(projectRun(baseline, events).run?.status).toBe("running");
  });

  it("lets a paused frame newer than the baseline win — `running → paused` is forward", () => {
    // A fresh `run.paused` lands after the refetch and must repaint the
    // chip before the invalidation's refetch confirms it.
    const baseline = runBaseline("running");
    const events = [wireRunEvent("run.paused", { paused_reason: "manual" }, { global_seq: 9621 })];
    const projected = projectRun(baseline, events);
    expect(projected.run?.status).toBe("paused");
    expect(projected.run?.paused_reason).toBe("manual");
  });

  it("keeps the manual pause's clear — `paused → queued` is forward", () => {
    const baseline = runBaseline("paused");
    const events = [wireRunEvent("run.resumed", { paused_reason: "manual" }, { global_seq: 9631 })];
    expect(projectRun(baseline, events).run?.status).toBe("queued");
  });

  it("never reanimates a terminal row from a stale frame", () => {
    const baseline = runBaseline("completed");
    const events = [wireRunEvent("run.started", {}, { global_seq: 9641 })];
    expect(projectRun(baseline, events).run?.status).toBe("completed");
  });

  it("never invents a run row from frames the screen has not fetched", () => {
    // The fold repaints rows the API served; with no baseline row there is
    // nothing to repaint and the invalidation's refetch brings the row.
    const events = [wireRunEvent("run.started", {}, { global_seq: 9651 })];
    expect(projectRun({ run: null }, events).run).toBeNull();
  });
});
