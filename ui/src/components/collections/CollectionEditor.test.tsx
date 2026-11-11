/**
 * The collection editor (`/workflows/collections/:id`, ADR-0084): the ordered
 * entry table, the add row's pin refusal (branch refused, tag ok, full SHA
 * ok), the reorder → `Save draft` body order, and the publish confirm's exact
 * re-attach line. Rendered from fixtures; the editor reaches the wire only
 * through the stubs here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionEditor } from "./CollectionEditor";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const HOW =
  "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82";
const WHY =
  "cursor/plugins/harness/pstack/claude-code/skills/why#63912a91d52c43946f974f2aaf661334a6116a82";

const pstack = {
  id: "c-pstack",
  slug: "pstack-claude-code",
  name: "pstack (Claude Code)",
  description: "Lauren Tan's pstack harness, per skill.",
  created_by: "u-1",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 3,
  latest_revision: {
    revision_id: "r-pstack-3",
    revision: 3,
    status: "published",
    entries: [{ ref: HOW }, { ref: WHY, skills: ["why"], note: "the plan playbook" }],
    created_at: "2026-11-11T10:00:00Z",
  },
};

function mount(stubs: RouteStub[]) {
  const { requests } = mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CollectionEditor collectionId={pstack.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return requests;
}

afterEach(cleanup);

describe("CollectionEditor", () => {
  it("renders the header chip, the ordered entries and the add row", async () => {
    mount([
      {
        path: `/api/v1/apm-collections/${pstack.id}`,
        body: { collection: pstack, revisions: [pstack.latest_revision] },
      },
    ]);
    const chip = await screen.findByTestId("collection-revision-chip");
    expect(chip.textContent).toBe("r3 published");
    expect(screen.getByTestId("collection-entry-0").textContent).toContain("skills/how#");
    expect(screen.getByTestId("collection-entry-0").textContent).toContain("all");
    const second = screen.getByTestId("collection-entry-1");
    expect(second.textContent).toContain("skills/why#");
    expect(second.textContent).toContain("why"); // the skill chip
    expect(second.textContent).toContain("the plan playbook"); // the note
    expect(screen.getByTestId("collection-add-row")).toBeDefined();
  });

  it("refuses a branch, accepts a tag and a full SHA", async () => {
    mount([
      {
        path: `/api/v1/apm-collections/${pstack.id}`,
        body: { collection: pstack, revisions: [pstack.latest_revision] },
      },
    ]);
    const input = await screen.findByTestId("collection-add-ref");
    const add = screen.getByTestId("collection-add-package");

    fireEvent.change(input, { target: { value: "mattpocock/skills#main" } });
    fireEvent.click(add);
    expect(screen.getByTestId("collection-add-error").textContent).toBe(
      "Pin a tag or a full commit SHA — branches move.",
    );
    expect(screen.queryByTestId("collection-entry-2")).toBeNull();

    fireEvent.change(input, { target: { value: "mattpocock/skills#v1.3.2" } });
    fireEvent.click(add);
    expect((await screen.findByTestId("collection-entry-2")).textContent).toContain(
      "mattpocock/skills#v1.3.2",
    );
    expect(screen.queryByTestId("collection-add-error")).toBeNull();

    const sha = "63912a91d52c43946f974f2aaf661334a6116a82";
    fireEvent.change(input, { target: { value: `owner/repo/path#${sha}` } });
    fireEvent.click(add);
    expect((await screen.findByTestId("collection-entry-3")).textContent).toContain(`#${sha}`);
  });

  it("reorder changes the Save draft body order", async () => {
    const requests = mount([
      {
        path: `/api/v1/apm-collections/${pstack.id}`,
        body: { collection: pstack, revisions: [pstack.latest_revision] },
      },
      {
        path: `/api/v1/apm-collections/${pstack.id}/revisions`,
        method: "POST",
        status: 201,
        body: (n: number) => ({
          revision_id: "r-pstack-4",
          revision: 3 + n,
          status: "draft",
          entries: [{ ref: HOW }, { ref: WHY, skills: ["why"], note: "the plan playbook" }],
          created_by: "u-1",
          created_at: "2026-11-11T12:00:00Z",
        }),
      },
    ]);
    const down = await screen.findByTestId("collection-entry-down-0");
    fireEvent.click(down);
    // The row order flipped locally and the page knows it is unsaved.
    expect((await screen.findByTestId("collection-entry-0")).textContent).toContain("skills/why#");
    expect(screen.getByTestId("collection-editor-dirty")).toBeDefined();
    const save = screen.getByTestId("collection-save-draft") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => {
      const [request] = requestsTo(
        requests,
        `/api/v1/apm-collections/${pstack.id}/revisions`,
        "POST",
      );
      expect(request).toBeDefined();
      const body = JSON.parse(request.body ?? "{}") as { entries: { ref: string }[] };
      expect(body.entries.map((entry) => entry.ref)).toEqual([WHY, HOW]);
    });
    // The saved draft clears the dirty marker.
    await waitFor(() => expect(screen.queryByTestId("collection-editor-dirty")).toBeNull());
  });

  it("Publish r4 asks for the confirm and shows the re-attach line", async () => {
    const draft = {
      revision_id: "r-pstack-4",
      revision: 4,
      status: "draft",
      entries: pstack.latest_revision.entries,
      created_by: "u-1",
      created_at: "2026-11-11T12:00:00Z",
    };
    const requests = mount([
      {
        path: `/api/v1/apm-collections/${pstack.id}`,
        body: { collection: pstack, revisions: [draft, pstack.latest_revision] },
      },
      {
        path: `/api/v1/apm-collections/${pstack.id}/revisions/4/publish`,
        method: "POST",
        body: { ...draft, status: "published" },
      },
    ]);
    const publish = (await screen.findByTestId("collection-publish")) as HTMLButtonElement;
    expect(publish.textContent).toContain("Publish r4");
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    const dialog = await screen.findByTestId("collection-publish-dialog");
    expect(
      within(dialog).getByText("Profiles keep using r3 until you re-attach r4."),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByTestId("collection-publish-confirm"));
    await waitFor(() => {
      expect(
        requestsTo(requests, `/api/v1/apm-collections/${pstack.id}/revisions/4/publish`, "POST"),
      ).toHaveLength(1);
    });
  });

  it("Cancel keeps the draft unpublished", async () => {
    const draft = {
      revision_id: "r-pstack-4",
      revision: 4,
      status: "draft",
      entries: pstack.latest_revision.entries,
      created_by: "u-1",
      created_at: "2026-11-11T12:00:00Z",
    };
    const requests = mount([
      {
        path: `/api/v1/apm-collections/${pstack.id}`,
        body: { collection: pstack, revisions: [draft, pstack.latest_revision] },
      },
      {
        path: `/api/v1/apm-collections/${pstack.id}/revisions/4/publish`,
        method: "POST",
        body: { ...draft, status: "published" },
      },
    ]);
    fireEvent.click(await screen.findByTestId("collection-publish"));
    const dialog = await screen.findByTestId("collection-publish-dialog");
    fireEvent.click(within(dialog).getByTestId("collection-publish-cancel"));
    await waitFor(() => expect(screen.queryByTestId("collection-publish-dialog")).toBeNull());
    expect(
      requestsTo(requests, `/api/v1/apm-collections/${pstack.id}/revisions/4/publish`, "POST"),
    ).toHaveLength(0);
  });
});
