/**
 * The thread rail's ARTIFACTS section (docs/design/handoff-app-shell/gaps/
 * threads.md, W3): the rows `GET /api/v1/projects/{id}/artifacts?conversation_id=…`
 * returns for one thread — the empty answer is "no artifacts yet", the refused
 * answer is an error, and every row is a link to the artifact page.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { ThreadArtifacts } from "./ThreadArtifacts";
import { mockFetch, type RouteStub } from "../../test/fakes";
import { artifactFixture, conversationId, projectFixture } from "../../test/fakes";
import type { Artifact } from "../../api/types";

const projectId = projectFixture.id;
const apiProject = `/api/v1/projects/${projectId}`;
const listPath = `${apiProject}/artifacts`;

function routes(artifacts: Artifact[], status?: number, detail?: string): RouteStub[] {
  const list: RouteStub = status
    ? {
        path: listPath,
        method: "GET",
        status,
        body: { type: "about:blank", title: "Not Found", status, detail },
      }
    : { path: listPath, method: "GET", body: { artifacts } };
  return [list];
}

function harness(routeList: RouteStub[]) {
  const { requests } = mockFetch(routeList);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { requests, wrapper };
}

afterEach(cleanup);

describe("the thread rail's ARTIFACTS section", () => {
  it("lists a thread's artifacts with name, kind and age, linking each row to the artifact page", async () => {
    const { wrapper } = harness(routes([artifactFixture]));
    render(<ThreadArtifacts projectId={projectId} conversationId={conversationId} />, { wrapper });

    const list = await screen.findByTestId("thread-artifacts");
    expect(list).toBeTruthy();
    // The rail element itself is present in every state, rows included — the
    // ARTIFACTS section never disappears just because it has content.
    expect(screen.getByTestId("artifacts-rail")).toBeTruthy();
    const row = screen.getByTestId("thread-artifact-row");
    expect(row.textContent).toContain(artifactFixture.name);
    expect(row.textContent).toContain(artifactFixture.kind);
    expect(row.getAttribute("href")).toBe(`/artifacts/${artifactFixture.id}`);
  });

  it("lists at most five rows of a thread that produced more", async () => {
    const many: Artifact[] = Array.from({ length: 6 }, (_, i) => ({
      ...artifactFixture,
      id: `01987a78-999${i}-7000-8000-abcdef012345`,
      name: `artifact-${i}.md`,
      kind: "markdown",
      conversation_id: conversationId,
    }));
    const { wrapper } = harness(routes(many));
    render(<ThreadArtifacts projectId={projectId} conversationId={conversationId} />, { wrapper });

    await screen.findByTestId("thread-artifacts");
    expect(screen.getAllByTestId("thread-artifact-row")).toHaveLength(5);
  });

  it("shows the loading copy while the thread's artifacts are being read", () => {
    const { wrapper } = harness(routes([artifactFixture]));
    render(<ThreadArtifacts projectId={projectId} conversationId={conversationId} />, { wrapper });
    expect(screen.getByTestId("artifacts-rail").textContent).toContain(
      "Loading this thread's artifacts",
    );
  });

  it("explains that a thread with no artifacts yet is empty, not hidden", async () => {
    const { wrapper } = harness(routes([]));
    render(<ThreadArtifacts projectId={projectId} conversationId={conversationId} />, { wrapper });

    expect(await screen.findByText("No artifacts from this thread yet")).toBeTruthy();
    expect(screen.queryByTestId("thread-artifacts")).toBeNull();
  });

  it("surfaces a refused thread artifact list instead of an empty list", async () => {
    const { wrapper } = harness(routes([], 404, "no such thread"));
    render(<ThreadArtifacts projectId={projectId} conversationId={conversationId} />, { wrapper });

    expect(await screen.findByText("no such thread")).toBeTruthy();
  });
});
