/**
 * The library row is where three separate facts stay separate: what the newest
 * published revision is, what each channel pins, and what state the draft is in.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PipelineLibrary } from "./PipelineLibrary";
import {
  featureDevelopmentDrafts,
  featureDevelopmentRevisions,
  libraryPipelines,
  projectAssignments,
  releasePromotionDrafts,
} from "../../test/fixtures/m4/library";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

const rows = libraryPipelines.map((pipeline) => {
  const assignment = projectAssignments.find((item) => item.pipeline_id === pipeline.id);
  const feature = pipeline.slug === "feature-development";
  return {
    pipeline,
    latest: feature ? featureDevelopmentRevisions[0] : null,
    revisions: feature ? featureDevelopmentRevisions : [],
    drafts: feature
      ? featureDevelopmentDrafts
      : pipeline.slug === "release-promotion"
        ? releasePromotionDrafts
        : [],
    channels: assignment?.channels ?? [],
  };
});

describe("PipelineLibrary", () => {
  it("shows name, latest published revision and the digest pair", () => {
    render(<PipelineLibrary rows={rows} />);
    const row = screen.getByTestId("pipeline-row-feature-development");
    expect(screen.getByTestId("pipeline-name-feature-development").textContent).toContain(
      "Feature development",
    );
    expect(row.textContent).toContain("latest published r7");
    expect(row.textContent).toContain("7 revisions");
    expect(screen.getByTestId("pipeline-digest-feature-development").textContent).toContain(
      "pinned here 3f2f6e6a7ad1",
    );
    expect(screen.getByTestId("pipeline-digest-feature-development").textContent).toContain(
      "plan 0d0c7b3a6a5b",
    );
  });

  it("shows the channel labels as digests, never as 'latest'", () => {
    render(<PipelineLibrary rows={rows} />);
    const channels = screen.getByTestId("pipeline-channels-feature-development");
    expect(channels.textContent).toContain("stable 7.0.0 3f2f6e6a7ad1");
    expect(channels.textContent).toContain("beta 6.2.0 aaaa1f2f3f4f");
    // The word "latest" belongs to a revision, never to a channel.
    expect(channels.textContent).not.toContain("latest");
  });

  it("says plainly when no channel is set, instead of implying one", () => {
    render(<PipelineLibrary rows={rows} />);
    // release-promotion has a draft and no assignment: nothing is pinned to it.
    expect(screen.getByTestId("pipeline-no-channel-release-promotion").textContent).toContain(
      "no channel set for this project",
    );
    // module-verification is pinned on stable only, so it shows one chip.
    const moduleChannels = screen.getByTestId("pipeline-channels-module-verification");
    expect(moduleChannels.textContent).toContain("stable 2.0.0");
    expect(moduleChannels.textContent).not.toContain("beta");
  });

  it("names the draft's editor through the page's lookup, never a bare id", () => {
    render(
      <PipelineLibrary
        rows={rows}
        nameOf={(userId) => (userId === "usr_david" ? "David Chen" : userId)}
      />,
    );
    expect(screen.getByTestId("pipeline-validation-feature-development").textContent).toContain(
      "draft v12 · David Chen",
    );
  });

  it("falls back to a short id when the page supplies no lookup", () => {
    render(<PipelineLibrary rows={rows} />);
    // `usr_david` is not uuid-shaped, so shortId keeps it whole — but a uuid
    // is never echoed raw (see api/names.test.ts for the uuid case).
    expect(screen.getByTestId("pipeline-validation-feature-development").textContent).toContain(
      "draft v12 · usr_david",
    );
  });

  it("omits the channel cell entirely at org scope", () => {
    render(<PipelineLibrary rows={rows} scope="org" />);
    // No project owns these pipelines, so there is no channel to speak of —
    // not even an honest-looking "no channel set".
    expect(screen.queryAllByTestId(/pipeline-channels-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/pipeline-no-channel-/)).toHaveLength(0);
    // The rest of the row is untouched.
    expect(screen.getByTestId("pipeline-row-feature-development").textContent).toContain(
      "latest published r7",
    );
  });

  it("reports the project's assignment in place of a channel, when the page has one", () => {
    // M4's `AssignmentCreate` has no channel member, so a project surface that
    // knows the assignment must say "assigned", not "no channel set".
    render(
      <PipelineLibrary
        rows={rows}
        assignmentFor={(pipelineId) =>
          pipelineId === "pl_01J8FEATUREDEV"
            ? {
                revisionNumber: 7,
                revisionDigest: featureDevelopmentRevisions[0].revision_digest,
                maxConcurrentRuns: 3,
                enabled: true,
              }
            : null
        }
      />,
    );
    expect(screen.getByTestId("pipeline-assignment-feature-development").textContent).toContain(
      "assigned · r7 3f2f6e6a7ad1 · max 3 concurrent",
    );
    // The wrong-on-screen line is gone: an assigned row says nothing about channels.
    expect(screen.queryByTestId("pipeline-no-channel-feature-development")).toBeNull();
    // Unassigned is still the honest absence, not "latest".
    expect(screen.getByTestId("pipeline-no-assignment-release-promotion").textContent).toContain(
      "not assigned to this project",
    );
  });

  it("names an assignment it cannot resolve to a revision number by digest alone", () => {
    render(
      <PipelineLibrary
        rows={rows}
        assignmentFor={() => ({
          revisionNumber: null,
          revisionDigest: featureDevelopmentRevisions[0].revision_digest,
          maxConcurrentRuns: 1,
          enabled: false,
        })}
      />,
    );
    // No invented `r<N>`; a disabled pin does not read as a live one.
    expect(screen.getByTestId("pipeline-assignment-feature-development").textContent).toContain(
      "assigned · disabled · 3f2f6e6a7ad1 · max 1 concurrent",
    );
  });

  it("shows channels by default (project scope)", () => {
    render(<PipelineLibrary rows={rows} />);
    expect(screen.getByTestId("pipeline-channels-feature-development")).toBeTruthy();
  });

  it("carries a draft's validation state as the server's status, with its count in words", () => {
    render(<PipelineLibrary rows={rows} />);
    expect(screen.getByTestId("pipeline-validation-feature-development").textContent).toContain(
      "draft has findings",
    );
    expect(screen.getByTestId("pipeline-validation-feature-development").textContent).toContain(
      "draft v12",
    );
    expect(screen.getByTestId("pipeline-validation-release-promotion").textContent).toContain(
      "validating",
    );
  });

  it("never published is its own state, not an empty revision cell", () => {
    render(<PipelineLibrary rows={rows} />);
    expect(screen.getByTestId("pipeline-unpublished-release-promotion").textContent).toContain(
      "never published — 0 revisions",
    );
  });

  it("marks an archived pipeline without hiding it", () => {
    render(<PipelineLibrary rows={rows} />);
    expect(screen.getByTestId("pipeline-row-legacy-import").textContent).toContain("archived");
  });

  it("offers the create action to someone who has it, and the reason when they do not", () => {
    const onNew = vi.fn();
    render(<PipelineLibrary rows={rows} onNew={onNew} canCreate />);
    fireEvent.click(screen.getByTestId("pipeline-library-new"));
    expect(onNew).toHaveBeenCalled();

    render(<PipelineLibrary rows={rows} canCreate={false} />);
    expect(screen.queryAllByTestId("pipeline-library-new")).toHaveLength(1); // only the first render's
    expect(screen.getByTestId("pipeline-library-readonly").textContent).toContain(
      "publishing needs the owner role",
    );
  });

  it("names the reason it is empty", () => {
    render(
      <PipelineLibrary
        rows={[]}
        emptyCopy="Nothing here yet — a pipeline exists once a draft publishes."
      />,
    );
    expect(screen.getByTestId("pipeline-library-empty").textContent).toContain(
      "once a draft publishes",
    );
    expect(screen.getByTestId("pipeline-library-count").textContent).toBe("0 shown");
  });

  it("opens the pipeline from its name", () => {
    const onOpen = vi.fn();
    render(<PipelineLibrary rows={rows} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("pipeline-name-module-verification"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ slug: "module-verification" }));
  });
});
