/**
 * `/projects/:projectId/pipelines` as the place a project *gets* a pipeline.
 * The tests that matter: the assign control exists only for a maintainer, it
 * offers the newest published revision rather than a floating "latest", and
 * confirming posts the revision **id** route 18 demands (route 5's summary
 * carries no uuid — the digest is resolved through route 13 first).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";
import { shortId } from "../api/names";
import type { Pipeline, PipelineRevision } from "../api/types";
import {
  WIRE_CHILD_PIPELINE_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireAssignmentList,
  wireDraftSummaries,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRunList,
} from "../test/fixtures/m4/wire";

const ASSIGNMENTS_PATH = `/api/v1/projects/${wireProjectId}/assignments`;
const ASSIGN_POST_PATH = ASSIGNMENTS_PATH;
const CHILD_REVISION_ID = "01987b21-0001-7000-8000-abcdef012345";
const CHILD_REVISION_DIGEST = `sha256:${"1a2b".repeat(32)}`;
const CHILD_PREV_REVISION_DIGEST = `sha256:${"2b3c".repeat(32)}`;

/** `module-check` — the library pipeline this project has NOT assigned yet. */
const childPipeline: Pipeline = {
  ...wirePipeline,
  id: WIRE_CHILD_PIPELINE_ID,
  slug: "module-check",
  latest_revision_number: 2,
  revision_count: 2,
  revisions: [
    {
      ...wirePipeline.revisions[0],
      revision_number: 2,
      version_label: "2.0.0",
      revision_digest: CHILD_REVISION_DIGEST,
      status: "published",
    },
    {
      ...wirePipeline.revisions[0],
      revision_number: 1,
      version_label: "1.0.0",
      revision_digest: CHILD_PREV_REVISION_DIGEST,
      status: "published",
    },
  ],
};

const childRevision: PipelineRevision = {
  ...wireRevision,
  id: CHILD_REVISION_ID,
  pipeline_id: WIRE_CHILD_PIPELINE_ID,
  revision_number: 2,
  version_label: "2.0.0",
  revision_digest: CHILD_REVISION_DIGEST,
};

function routes(role: "maintainer" | "viewer", extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: { ...projectFixture, my_role: role } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}/drafts`, body: wireDraftSummaries },
    { path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}`, body: childPipeline },
    { path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}/drafts`, body: { drafts: [] } },
    { path: ASSIGNMENTS_PATH, body: wireAssignmentList },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    { path: `/api/v1/revisions/${CHILD_REVISION_DIGEST}`, body: childRevision },
    { path: `/api/v1/projects/${wireProjectId}/runs`, body: wireRunList },
  ];
}

function mount(role: "maintainer" | "viewer", extra: RouteStub[] = []) {
  return renderApp({
    path: `/projects/${wireProjectId}/pipelines`,
    routes: routes(role, extra),
  });
}

describe("/projects/:projectId/pipelines — assigning a library pipeline", () => {
  it("offers a maintainer the assign control only for the unassigned pipeline", async () => {
    mount("maintainer");

    await screen.findByTestId("pipeline-name-module-check");
    const list = screen.getByTestId("pipeline-assign-list");
    expect(within(list).getByTestId("assign-open-module-check").textContent).toContain(
      "Assign to this project",
    );
    // `feature-development` already has an assignment here, so it is not on offer.
    expect(within(list).queryByTestId("assign-open-feature-development")).toBeNull();
    // A viewer-only surface must not even show the control; this one does, and
    // the pin line stays the server's truth until something is assigned — in
    // short form, because a bare uuid is never a label.
    const pin = screen.getByTestId("project-pipeline-pin").textContent ?? "";
    expect(pin).toContain("pinned revision r7");
    expect(pin).toContain(shortId(WIRE_REVISION_ID));
    expect(pin).not.toContain(WIRE_REVISION_ID);
  });

  it("reports the project's assignment on the row, not a channel M4 has no word for", async () => {
    mount("maintainer");

    await screen.findByTestId("pipeline-name-module-check");
    // `feature-development` is assigned here: the cell says so, with the pin
    // (r<N> + short digest) and the ceiling the server gave the assignment.
    const assigned = screen.getByTestId("pipeline-assignment-feature-development").textContent;
    expect(assigned).toContain("assigned");
    expect(assigned).toContain("r7");
    expect(assigned).toContain("3f2f3f2f3f2f");
    expect(assigned).toContain("max 1 concurrent");
    // The claim that was wrong on screen: nothing says "no channel set" when
    // the pipeline *is* assigned to this project.
    expect(screen.queryAllByTestId(/pipeline-no-channel-/)).toHaveLength(0);
    // `module-check` has no assignment: the honest absence, next to the Assign
    // control that fixes it.
    expect(screen.getByTestId("pipeline-no-assignment-module-check").textContent).toContain(
      "not assigned to this project",
    );
    expect(screen.getByTestId("assign-open-module-check")).toBeTruthy();
  });

  it("gives the pinned document the panel's width, with no empty findings column", async () => {
    mount("maintainer");

    const layout = await screen.findByTestId("yaml-view-layout");
    expect(layout.getAttribute("data-layout")).toBe("below");
    // Nothing has been validated here, so the side pane that only apologized is
    // gone rather than eating half the width.
    expect(screen.queryByTestId("yaml-validation-none")).toBeNull();
    expect(screen.getByTestId("yaml-view")).toBeTruthy();
    // Ids stay short everywhere on this panel.
    const newest = screen.getByTestId("project-pipeline-newest-run").textContent ?? "";
    expect(newest).toContain(shortId(WIRE_RUN_ID));
    expect(newest).not.toContain(WIRE_RUN_ID);
  });

  it("shows a viewer no assign control at all", async () => {
    mount("viewer");

    await screen.findByTestId("pipeline-name-module-check");
    expect(screen.queryByTestId("pipeline-assign-list")).toBeNull();
    expect(screen.queryByTestId("assign-open-module-check")).toBeNull();
  });

  it("confirms with the newest published revision id and refetches the assignments", async () => {
    const created = {
      ...wireAssignmentList.assignments[0],
      id: "01987b22-0001-7000-8000-abcdef012345",
      pipeline_id: WIRE_CHILD_PIPELINE_ID,
      pinned_revision_id: CHILD_REVISION_ID,
      pinned_revision_digest: CHILD_REVISION_DIGEST,
      pinned_version_label: "2.0.0",
    };
    const { requests } = mount("maintainer", [
      { path: ASSIGN_POST_PATH, method: "POST", status: 201, body: created },
    ]);

    fireEvent.click(await screen.findByTestId("assign-open-module-check"));
    // The id is resolved from the digest before anything is postable.
    const confirm = await screen.findByTestId("assign-confirm-module-check");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    // The form names r2, the newest published revision — not r1, not "latest".
    expect(screen.getByTestId("assign-form-module-check").textContent).toContain("r2 · 2.0.0");

    fireEvent.click(confirm);
    await waitFor(() => expect(requestsTo(requests, ASSIGN_POST_PATH, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, ASSIGN_POST_PATH, "POST")[0].body ?? "{}");
    expect(body).toEqual({
      pipeline_id: WIRE_CHILD_PIPELINE_ID,
      pinned_revision_id: CHILD_REVISION_ID,
      max_concurrent_runs: 1,
    });
    expect(body.pinned_revision_id).toBe(CHILD_REVISION_ID);
    // The newest digest is the one resolved — r2 was never looked at.
    expect(requestsTo(requests, `/api/v1/revisions/${CHILD_REVISION_DIGEST}`)).toHaveLength(1);
    expect(requestsTo(requests, `/api/v1/revisions/${CHILD_PREV_REVISION_DIGEST}`)).toHaveLength(0);

    // The list and `NewRunForm` read the same key: the invalidation refetches it.
    await waitFor(() => expect(requestsTo(requests, ASSIGNMENTS_PATH)).toHaveLength(2));
  });

  it("renders the server's 409 inline instead of pretending the pin took", async () => {
    const { requests } = mount("maintainer", [
      {
        path: ASSIGN_POST_PATH,
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/conflict",
          title: "Conflict",
          status: 409,
          detail: "this pipeline is already assigned to this project",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("assign-open-module-check"));
    const confirm = await screen.findByTestId("assign-confirm-module-check");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    const alert = await screen.findByTestId("assign-error-module-check");
    expect(alert.textContent).toContain("already assigned");
    // The form stays open on a refusal — the maintainer sees what the server said.
    expect(screen.getByTestId("assign-form-module-check")).toBeTruthy();
    expect(requestsTo(requests, ASSIGN_POST_PATH, "POST")).toHaveLength(1);
  });
});
