import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineRevisionSummary } from "../../lib/pipeline/contract";
import { VersionsPanel } from "./VersionsPanel";

afterEach(cleanup);

const revisions: PipelineRevisionSummary[] = [
  {
    id: "rev-3",
    revision_number: 3,
    version_label: "v3",
    revision_digest: "sha256:3333",
    plan_digest: "sha256:p3",
    digest_scope: "v1alpha1-canonical-1",
    published_at: new Date(Date.now() - 3600_000).toISOString(),
    published_by: "u-dana",
    status: "published",
  },
  {
    id: "rev-2",
    revision_number: 2,
    version_label: "v2",
    revision_digest: "sha256:2222",
    plan_digest: "sha256:p2",
    digest_scope: "v1alpha1-canonical-1",
    published_at: new Date(Date.now() - 86400_000).toISOString(),
    published_by: "u-ada",
    status: "deprecated",
  },
];

const baseDoc = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "test" },
  spec: { nodes: [{ id: "plan", kind: "agent.acp" }] },
};

const draftYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: test
spec:
  nodes:
    - id: plan
      kind: agent.acp
    - id: check
      kind: process.exec
`;

describe("VersionsPanel", () => {
  it("renders draft summary, LIVE tag, run count, and version actions", () => {
    const onSelectDraft = vi.fn();
    const onSelectRevision = vi.fn();
    const onRestoreRevision = vi.fn();
    const onClose = vi.fn();

    render(
      <VersionsPanel
        revisions={revisions}
        baseDocument={baseDoc}
        draftText={draftYaml}
        hasDraft
        viewingDigest={null}
        canAuthor
        runCountsByDigest={new Map([["sha256:3333", 12]])}
        actorName={(id) => (id === "u-dana" ? "Dana" : "Ada")}
        onSelectDraft={onSelectDraft}
        onSelectRevision={onSelectRevision}
        onRestoreRevision={onRestoreRevision}
        onClose={onClose}
      />,
    );

    const panel = screen.getByTestId("versions-panel");
    expect(panel.textContent).toContain("Your draft");
    expect(panel.textContent).toContain("+ check");
    expect(panel.textContent).toContain("LIVE");
    expect(panel.textContent).toContain("Dana");
    expect(panel.textContent).toContain("ran 12 times");
    expect(panel.textContent).toContain("v2");
    expect(panel.textContent).toContain("Ada");

    fireEvent.click(screen.getByTestId("versions-select-v2"));
    expect(onSelectRevision).toHaveBeenCalledWith("sha256:2222");

    fireEvent.click(screen.getByTestId("versions-restore-v2"));
    expect(onRestoreRevision).toHaveBeenCalledWith(revisions[1]);

    fireEvent.click(screen.getByTestId("versions-select-draft"));
    expect(onSelectDraft).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("versions-panel-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
