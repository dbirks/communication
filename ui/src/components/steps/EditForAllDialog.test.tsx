/**
 * The "Edit for all" dialog (design 3b): the latest revision's config seeds
 * the YAML editor, the suggested version is a patch bump, the POST body is
 * exactly what ADR-0049 § 3 checks (parsed config, the typed version,
 * `adopt_using_workflows: true`), the § 5 adoption result renders verbatim
 * (empty arrays → the honest "once adoption ships" note), and Escape closes.
 */
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, afterEach } from "vitest";
import { EditForAllDialog } from "./EditForAllDialog";
import type { NodeTemplateRevision } from "../../api/nodeTemplates";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const LATEST = {
  revision_id: "r-1",
  revision_number: 1,
  version_label: "2.0.0",
  parameters: { type: "object", properties: { profile: { type: "string" } } },
  config: { profile: "reviewer", prompt: "review" },
  output_schema: { type: "object" },
  workspace_mode: "read_only",
  revision_digest: "sha256:abc",
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
} as unknown as NodeTemplateRevision;

function harness(routes: RouteStub[], onClose: () => void = vi.fn()) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <EditForAllDialog open onClose={onClose} templateId="t-1" usedInCount={2} latest={LATEST} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, onClose };
}

afterEach(cleanup);

describe("EditForAllDialog", () => {
  it("seeds the config editor from the latest revision and suggests a patch bump", () => {
    const { onClose } = harness([
      {
        path: "/api/v1/node-templates/t-1/revisions",
        method: "POST",
        status: 201,
        body: { revision: LATEST, adopted: [], skipped: [] },
      },
    ]);
    expect(screen.getByText("Edit for all 2 → version 2.0.1")).toBeTruthy();
    const config = screen.getByTestId("edit-for-all-config");
    expect((config as HTMLTextAreaElement).value).toContain("reviewer");
    expect((screen.getByTestId("edit-for-all-version") as HTMLInputElement).value).toBe("2.0.1");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("POSTs the parsed config, the version and adoption, then renders the result with the honest note", async () => {
    const response = {
      revision: { ...LATEST, revision_number: 2, version_label: "2.0.1", revision_id: "r-2" },
      adopted: [],
      skipped: [],
    };
    const { requests } = harness([
      { path: "/api/v1/node-templates/t-1/revisions", method: "POST", status: 201, body: response },
    ]);
    const config = screen.getByTestId("edit-for-all-config");
    fireEvent.change(config, { target: { value: "profile: reviewer-v2\n" } });
    fireEvent.click(screen.getByTestId("edit-for-all-submit"));

    await waitFor(() => expect(screen.getByTestId("edit-for-all-result")).toBeTruthy());
    expect(screen.getByTestId("edit-for-all-result").textContent).toContain("2.0.1");
    // Part 1: empty adoption arrays → the honest pending note, never a fake.
    expect(screen.getByTestId("edit-for-all-adoption-pending")).toBeTruthy();

    const post = requestsTo(requests, "/api/v1/node-templates/t-1/revisions", "POST")[0];
    const body = JSON.parse(String(post.body));
    expect(body.adopt_using_workflows).toBe(true);
    expect(body.version_label).toBe("2.0.1");
    expect(body.config).toEqual({ profile: "reviewer-v2" });
    expect(body.workspace_mode).toBe("read_only");
    expect(body.parameters).toEqual(LATEST.parameters);
  });

  it("refuses to publish a config that is not an object", async () => {
    const { requests } = harness([
      {
        path: "/api/v1/node-templates/t-1/revisions",
        method: "POST",
        status: 201,
        body: { revision: LATEST, adopted: [], skipped: [] },
      },
    ]);
    fireEvent.change(screen.getByTestId("edit-for-all-config"), {
      target: { value: "- just\n- a\n- list\n" },
    });
    fireEvent.click(screen.getByTestId("edit-for-all-submit"));
    expect(screen.getByTestId("edit-for-all-error")).toBeTruthy();
    expect(requestsTo(requests, "/api/v1/node-templates/t-1/revisions", "POST")).toHaveLength(0);
  });

  it("Escape closes without publishing", () => {
    const onClose = vi.fn();
    harness(
      [
        {
          path: "/api/v1/node-templates/t-1/revisions",
          method: "POST",
          status: 201,
          body: { revision: LATEST, adopted: [], skipped: [] },
        },
      ],
      onClose,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
