/**
 * The "Duplicate as a new step…" dialog (design 3b): it pre-fills from the
 * source step, POSTs the two body members and only, and on success navigates
 * to the new step.
 */
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, afterEach } from "vitest";
import { DuplicateDialog } from "./DuplicateDialog";
import type { NodeTemplate } from "../../api/nodeTemplates";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const SOURCE = {
  id: "t-1",
  slug: "code-reviewer",
  display_name: "Code reviewer",
  kind: "agent.acp",
  description: "",
  status: "active",
  latest_revision: {
    revision_id: "r-1",
    revision_number: 1,
    version_label: "2.0.0",
    revision_digest: "sha256:abc",
    created_at: "2026-07-01T10:00:00Z",
  },
  used_in_count: 2,
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:00:00Z",
} as unknown as NodeTemplate;

const CREATED = { ...SOURCE, id: "t-2", slug: "code-reviewer-copy" };

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/steps/t-1"]}>
        <Routes>
          <Route path="/steps/:id" element={<LocationProbe />} />
        </Routes>
        <DuplicateDialog open onClose={() => {}} source={SOURCE} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("DuplicateDialog", () => {
  afterEach(cleanup);

  it("pre-fills from the source and posts the new slug and name", async () => {
    const { requests } = harness([
      { path: "/api/v1/node-templates/t-1/duplicate", method: "POST", status: 201, body: CREATED },
    ]);
    expect((screen.getByTestId("duplicate-slug") as HTMLInputElement).value).toBe(
      "code-reviewer-copy",
    );
    expect((screen.getByTestId("duplicate-name") as HTMLInputElement).value).toBe("Code reviewer");

    fireEvent.change(screen.getByTestId("duplicate-slug"), {
      target: { value: "security-reviewer" },
    });
    fireEvent.change(screen.getByTestId("duplicate-name"), {
      target: { value: "Security reviewer" },
    });
    fireEvent.click(screen.getByTestId("duplicate-submit"));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/steps/t-2"));
    const post = requestsTo(requests, "/api/v1/node-templates/t-1/duplicate", "POST")[0];
    expect(JSON.parse(String(post.body))).toEqual({
      slug: "security-reviewer",
      display_name: "Security reviewer",
    });
  });

  it("keeps the submit disabled for an invalid slug", () => {
    harness([
      { path: "/api/v1/node-templates/t-1/duplicate", method: "POST", status: 201, body: CREATED },
    ]);
    fireEvent.change(screen.getByTestId("duplicate-slug"), { target: { value: "Bad Slug" } });
    expect((screen.getByTestId("duplicate-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
