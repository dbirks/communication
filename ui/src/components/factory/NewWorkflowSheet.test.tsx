/**
 * NewWorkflowSheet — the sheet's ways in, against the fake fetch.
 *
 * The load-bearing assertions are the two writes and the address: `Sketch it`
 * creates the definition and its first draft (ADR-0002's logical create, then
 * its draft) and lands on the editor carrying that draft
 * (`?draft=…&describe=1`), with the sentence parked in sessionStorage for the
 * editor's assistant box — and no model call anywhere, because the sheet never
 * asks anyone to sketch.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NewWorkflowSheet,
  describeKey,
  nameFromDescription,
  templateBlurb,
  templateSteps,
  writeDescription,
} from "./NewWorkflowSheet";
import type { Draft, Pipeline } from "../../api/types";
import { mockFetch, type RouteStub } from "../../test/fakes";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  templateById,
} from "../../lib/pipeline/templates";

// The one test that needs the templates section absent — only Blank exists —
// swaps this list. Defaults to the real templates so every other test is
// unaffected.
const templatesState = vi.hoisted(() => ({
  list: null as readonly import("../../lib/pipeline/templates").PipelineTemplate[] | null,
}));
vi.mock("../../lib/pipeline/templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pipeline/templates")>();
  return {
    ...actual,
    get PIPELINE_TEMPLATES() {
      return templatesState.list ?? actual.PIPELINE_TEMPLATES;
    },
  };
});

afterEach(() => {
  templatesState.list = null;
  cleanup();
});

const NEW_PIPELINE_ID = "01987c01-0000-7000-8000-newcopy01234";
const NEW_DRAFT_ID = "01987c02-0000-7000-8000-newcopy01234";
const COPY_PIPELINE_ID = "01987c03-0000-7000-8000-copy0001234";
const COPY_DRAFT_ID = "01987c04-0000-7000-8000-copy0001234";
const SOURCE_ID = "01987b20-0000-7000-8000-abcdef012345";
const SOURCE_DIGEST = `sha256:${"3f2f".repeat(32)}`;
const USER_ID = "01987a61-2345-7000-8000-abcdef012345";

function createdPipeline(slug: string, id: string): Pipeline {
  return {
    id,
    slug,
    display_name: slug,
    description: "",
    created_by: USER_ID,
    created_at: "2026-11-20T10:00:00Z",
    latest_revision_number: 0,
    revision_count: 0,
    archived: false,
    revisions: [],
  };
}

function createdDraft(pipelineId: string, id: string): Draft {
  return {
    id,
    pipeline_id: pipelineId,
    status: "draft",
    document_yaml: BLANK_SKELETON_YAML,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: {},
    validation: undefined,
    digest_scope: "v1alpha1-canonical-1",
    version: 1,
    created_at: "2026-11-20T10:00:00Z",
    updated_at: "2026-11-20T10:00:00Z",
    edited_by: USER_ID,
  };
}

const sourcePipeline: Pipeline = {
  ...createdPipeline("wf-1", SOURCE_ID),
  display_name: "Workflow One",
  latest_revision_number: 1,
  revision_count: 1,
  revisions: [
    {
      revision_number: 1,
      version_label: "1.0.0",
      revision_digest: SOURCE_DIGEST,
      plan_digest: `sha256:${"0d0c".repeat(32)}`,
      digest_scope: "v1alpha1-canonical-1",
      published_at: "2026-11-02T10:00:00Z",
      published_by: USER_ID,
      status: "published",
    },
  ],
};

/** Records where the sheet navigated. */
function Landinger() {
  const { pathname, search } = useLocation();
  return <div data-testid="landing">{`${pathname}${search}`}</div>;
}

/**
 * The stubs the sheet's reads hit, plus the create pair this test exercises.
 * `create` is the `POST /pipelines` answer; the draft POST is answered under
 * whatever id that returned.
 */
function routesFor(create: RouteStub["body"], createdId: string, draftId: string): RouteStub[] {
  return [
    { path: "/api/v1/pipelines", method: "POST", body: create },
    {
      path: `/api/v1/pipelines/${createdId}/drafts`,
      method: "POST",
      body: createdDraft(createdId, draftId),
    },
    { path: `/api/v1/pipelines/${SOURCE_ID}`, body: sourcePipeline },
    {
      path: `/api/v1/revisions/${SOURCE_DIGEST}/document`,
      body: "apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n",
      headers: { "content-type": "text/yaml" },
    },
  ];
}

function mount(
  routes: RouteStub[],
  scope: string | null = null,
  props: { scopeName?: string | null } = {},
) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/factory"]}>
        <Routes>
          <Route
            path="/factory"
            element={
              <NewWorkflowSheet
                scope={scope}
                scopeName={props.scopeName ?? null}
                workflows={[
                  {
                    id: SOURCE_ID,
                    slug: "wf-1",
                    display_name: "Workflow One",
                    latest_revision_number: 1,
                    revision_count: 1,
                    archived: false,
                  },
                ]}
                onClose={onClose}
              />
            }
          />
          <Route path="/factory/:pipelineId" element={<Landinger />} />
          <Route path="/p/:projectId/factory/:pipelineId" element={<Landinger />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, onClose, unmount: () => view.unmount() };
}

const DESCRIPTION = "When an issue gets the ready label, plan it, implement it, run the tests";

function sketchButton(): HTMLButtonElement {
  return screen.getByTestId("new-workflow-sketch") as HTMLButtonElement;
}

/** The starters the sheet offers: every template but Blank, which the sheet's
 * own Blank canvas link already is. */
function nonBlankTemplates() {
  return PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
}

/** The disclosure is closed by default (review 08-1280-1): anything that wants
 * a template row opens it first, exactly as a person does. */
function openTemplates(): void {
  fireEvent.click(screen.getByTestId("new-workflow-templates-toggle"));
}

describe("nameFromDescription", () => {
  it("takes the first five words, and no trailing punctuation", () => {
    expect(nameFromDescription(DESCRIPTION)).toBe("When an issue gets the");
    expect(nameFromDescription("  tests, and ship!  ")).toBe("tests, and ship");
    expect(nameFromDescription("   ")).toBe("");
  });
});

describe("NewWorkflowSheet", () => {
  it("is a labelled modal whose Esc and close button reach the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { onClose, unmount } = mount(
      routesFor(createdPipeline("plan-it", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID),
    );
    const sheet = screen.getByTestId("new-workflow-sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.getAttribute("aria-labelledby")).toBe("new-workflow-sheet-title");
    expect(sheet.textContent).toContain("New workflow");
    // The sheet is the page's to close: the key hands the request over, and
    // only the unmount gives the focus back.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("new-workflow-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Sketch it inert until the box says something", () => {
    mount(routesFor(createdPipeline("plan-it", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    expect(sketchButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("new-workflow-description"), { target: { value: "  " } });
    expect(sketchButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("new-workflow-description"), {
      target: { value: DESCRIPTION },
    });
    expect(sketchButton().disabled).toBe(false);
  });

  it("sketches: two writes, the sentence parked, and the editor with the draft", async () => {
    window.sessionStorage.clear();
    const { requests } = mount(
      routesFor(
        createdPipeline("when-an-issue-gets-the", NEW_PIPELINE_ID),
        NEW_PIPELINE_ID,
        NEW_DRAFT_ID,
      ),
    );
    fireEvent.change(screen.getByTestId("new-workflow-description"), {
      target: { value: DESCRIPTION },
    });
    fireEvent.click(screen.getByTestId("new-workflow-sketch"));
    await waitFor(() => expect(screen.queryByTestId("landing")).toBeTruthy());
    expect(screen.getByTestId("landing").textContent).toBe(
      `/factory/${NEW_PIPELINE_ID}?draft=${NEW_DRAFT_ID}&describe=1`,
    );
    // The sentence travels through sessionStorage, not through a model.
    expect(window.sessionStorage.getItem(describeKey(NEW_PIPELINE_ID))).toBe(DESCRIPTION);
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.url)).toEqual([
      "/api/v1/pipelines",
      `/api/v1/pipelines/${NEW_PIPELINE_ID}/drafts`,
    ]);
    expect(JSON.parse(posts[0]?.body ?? "{}")).toMatchObject({
      slug: "when-an-issue-gets-the",
      display_name: "When an issue gets the",
    });
    expect(JSON.parse(posts[1]?.body ?? "{}")).toMatchObject({
      document_yaml: expect.stringContaining("name: when-an-issue-gets-the"),
    });
    // The sheet calls no model: nothing went to the assistant.
    expect(requests.filter((request) => request.url.includes("assistant"))).toHaveLength(0);
  });

  it("refuses to name a workflow out of punctuation alone", () => {
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    fireEvent.change(screen.getByTestId("new-workflow-description"), { target: { value: "??!!" } });
    fireEvent.click(screen.getByTestId("new-workflow-sketch"));
    expect(screen.getByTestId("new-workflow-name-error").textContent).toBe(
      "That holds no words to name a workflow — type a few.",
    );
  });

  it("parks a description under the per-workflow key", () => {
    window.sessionStorage.clear();
    writeDescription("pipe-x", "hello");
    expect(describeKey("pipe-x")).toBe("communication.factory.describe.pipe-x");
    expect(window.sessionStorage.getItem(describeKey("pipe-x"))).toBe("hello");
  });

  it("copies with the index's own Duplicate call, scoped where it was opened", async () => {
    const { requests } = mount(
      routesFor(createdPipeline("wf-1-copy", COPY_PIPELINE_ID), COPY_PIPELINE_ID, COPY_DRAFT_ID),
      "prj-1",
    );
    fireEvent.click(screen.getByTestId(`new-workflow-copy-${SOURCE_ID}`));
    await waitFor(() => expect(screen.queryByTestId("landing")).toBeTruthy());
    expect(screen.getByTestId("landing").textContent).toBe(
      `/p/prj-1/factory/${COPY_PIPELINE_ID}?draft=${COPY_DRAFT_ID}`,
    );
    const urls = requests.map((request) => request.url);
    // The source is read, its latest revision's regenerated text is fetched,
    // and the copy lands as a fresh definition plus one draft.
    expect(urls).toContain(`/api/v1/pipelines/${SOURCE_ID}`);
    expect(urls).toContain(`/api/v1/revisions/${SOURCE_DIGEST}/document`);
    const post = requests.find((request) => request.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      slug: "wf-1-copy",
      display_name: "Workflow One copy",
    });
  });

  it("opens the blank canvas with the skeleton draft, named Untitled workflow", async () => {
    const { requests } = mount(
      routesFor(
        createdPipeline("untitled-workflow", NEW_PIPELINE_ID),
        NEW_PIPELINE_ID,
        NEW_DRAFT_ID,
      ),
    );
    fireEvent.click(screen.getByTestId("new-workflow-blank"));
    await waitFor(() => expect(screen.queryByTestId("landing")).toBeTruthy());
    expect(screen.getByTestId("landing").textContent).toBe(
      `/factory/${NEW_PIPELINE_ID}?draft=${NEW_DRAFT_ID}`,
    );
    const first = requests.find((request) => request.method === "POST");
    expect(JSON.parse(first?.body ?? "{}")).toMatchObject({
      slug: "untitled-workflow",
      display_name: "Untitled workflow",
    });
  });

  it("says what the server refused, and stays open", async () => {
    const { onClose } = mount([
      {
        path: "/api/v1/pipelines",
        status: 409,
        body: {
          type: "https://communication.dev/errors/pipeline_slug_taken",
          title: "Conflict",
          status: 409,
          detail: "that slug is taken",
        },
      },
    ]);
    fireEvent.change(screen.getByTestId("new-workflow-description"), {
      target: { value: DESCRIPTION },
    });
    fireEvent.click(screen.getByTestId("new-workflow-sketch"));
    expect(await screen.findByTestId("new-workflow-sheet")).toBeTruthy();
    expect((await screen.findByTestId("new-workflow-sheet-error")).textContent).toContain(
      "that slug is taken",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the templates in a collapsed disclosure below the README's parts", () => {
    const { unmount } = mount(
      routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID),
    );
    const sheet = screen.getByTestId("new-workflow-sheet");
    const text = sheet.textContent ?? "";
    // README § 4 lists three parts and ends with the copy chips and the Blank
    // canvas link; the starters are the extra, so they wait behind one click
    // BELOW it (review 08-1280-1) — closed by default, opening in place.
    expect(text.indexOf("Or from something you keep doing in chats")).toBeLessThan(
      text.indexOf("Or copy"),
    );
    expect(text.indexOf("Or copy")).toBeLessThan(text.indexOf("Start from a template"));
    const toggle = screen.getByTestId("new-workflow-templates-toggle") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain(`Start from a template (${nonBlankTemplates().length})`);
    // Closed: no row is in the DOM, so none of its buttons steals the tab order.
    for (const template of nonBlankTemplates()) {
      expect(screen.queryByTestId(`new-workflow-template-${template.id}`)).toBeNull();
    }

    fireEvent.click(toggle);
    expect(
      (screen.getByTestId("new-workflow-templates-toggle") as HTMLButtonElement).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");

    // Opened in place: the section label keeps its id and every row carries its
    // name, its one-line description and the steps its document puts on the canvas.
    const label = screen.getByTestId("new-workflow-templates-label");
    expect(label.textContent).toBe(`Start from a template (${nonBlankTemplates().length})`);
    expect(label.className).toContain("uppercase");
    for (const template of nonBlankTemplates()) {
      const row = screen.getByTestId(`new-workflow-template-${template.id}`).closest("div");
      expect(row, `row for ${template.id}`).toBeTruthy();
      expect(row?.textContent).toContain(template.label);
      expect(row?.textContent).toContain(templateBlurb(template));
      for (const step of templateSteps(template).slice(0, 5)) {
        expect(row?.textContent).toContain(step);
      }
    }
    // The six-step sample shows five chips and names the rest.
    const pstack = screen.getByTestId("new-workflow-template-pstack-feature").closest("div")!;
    expect(templateSteps(templateById("pstack-feature")!)).toHaveLength(6);
    expect(pstack.textContent).toContain("+1");
    expect(pstack.textContent).toContain("1 more step");
    const pstackSteps = screen.getByTestId("new-workflow-template-steps-pstack-feature");
    expect(pstackSteps.textContent).toBe(
      "Steps: survey→plan→approve→implement→review+1 1 more step",
    );
    // The Blank template is dropped: the sheet's own Blank canvas link is the
    // one way to start blank.
    expect(screen.queryByTestId("new-workflow-template-blank")).toBeNull();
    unmount();
  });

  // Review 08-1280-2: the promise belongs with the verb it describes, inside
  // the box's own bottom row — not on a line under the box.
  it("says what Sketch it does inside the box, beside the button", () => {
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    const sketch = screen.getByTestId("new-workflow-sketch");
    const row = sketch.parentElement as HTMLElement;
    const helper = [...row.children].find((node) =>
      (node.textContent ?? "").startsWith("Steps get sketched on the canvas"),
    );
    expect(helper, "the helper sentence shares Sketch it's row").toBeTruthy();
    // …and that row is inside the Describe it box, not under it.
    const box = screen.getByTestId("new-workflow-description").parentElement as HTMLElement;
    expect(box.contains(row)).toBe(true);
  });

  it("names the scope the workflow will belong to", () => {
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID), null, {
      scopeName: "Project One",
    });
    // Review 08-1280-3: at All scope (or any scope) the sheet has to say where
    // the workflow lands.
    expect(document.getElementById("new-workflow-sheet-title")?.textContent).toBe(
      "New workflow in Project One",
    );
  });

  // Review 08-1280-4: the prototype's scrim is the content area — the rail and
  // the top bar stay undimmed and the sheet starts under the bar.
  it("stops the scrim at the shell", () => {
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    const backdrop = screen.getByTestId("new-workflow-backdrop");
    expect(backdrop.className).not.toContain("inset-0");
    expect(backdrop.className).toContain("md:top-[60px]");
    expect(backdrop.className).toContain("md:left-16");
  });

  it("renders no template disclosure when only the Blank template exists", () => {
    templatesState.list = PIPELINE_TEMPLATES.filter((template) => template.id === "blank");
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    expect(screen.queryByTestId("new-workflow-templates-toggle")).toBeNull();
    expect(screen.queryByTestId("new-workflow-templates-label")).toBeNull();
    expect(screen.queryByTestId("new-workflow-template-blank")).toBeNull();
    // The Blank canvas link still offers the blank start.
    expect(screen.getByTestId("new-workflow-blank").textContent).toBe("Blank canvas");
  });

  it("uses a template with the old dialog's two writes and its suggested name", async () => {
    const { requests } = mount(
      routesFor(
        createdPipeline("plan-with-approval", NEW_PIPELINE_ID),
        NEW_PIPELINE_ID,
        NEW_DRAFT_ID,
      ),
      "prj-1",
    );
    openTemplates();
    fireEvent.click(screen.getByTestId("new-workflow-template-plan-with-approval"));
    await waitFor(() => expect(screen.queryByTestId("landing")).toBeTruthy());
    expect(screen.getByTestId("landing").textContent).toBe(
      `/p/prj-1/factory/${NEW_PIPELINE_ID}?draft=${NEW_DRAFT_ID}`,
    );
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.url)).toEqual([
      "/api/v1/pipelines",
      `/api/v1/pipelines/${NEW_PIPELINE_ID}/drafts`,
    ]);
    // The dialog named the workflow after the starter and derived the id from it.
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({
      slug: "plan-with-approval",
      display_name: "Plan with approval",
    });
    // The first draft is the sample document, with metadata.name on the new id.
    const draftYaml = String(JSON.parse(posts[1]?.body ?? "{}").document_yaml);
    expect(draftYaml).toContain("name: plan-with-approval");
    expect(draftYaml).toContain("- id: survey");
    expect(draftYaml).not.toBe(BLANK_SKELETON_YAML);
  });

  it("keeps a failed template create open and says what the server refused", async () => {
    const { onClose } = mount([
      {
        path: "/api/v1/pipelines",
        status: 409,
        body: {
          type: "https://communication.dev/errors/pipeline_slug_taken",
          title: "Conflict",
          status: 409,
          detail: "that slug is taken",
        },
      },
    ]);
    openTemplates();
    fireEvent.click(screen.getByTestId("new-workflow-template-security-review"));
    expect(await screen.findByTestId("new-workflow-sheet")).toBeTruthy();
    expect((await screen.findByTestId("new-workflow-sheet-error")).textContent).toContain(
      "that slug is taken",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("landing")).toBeNull();
  });

  it("closes on the backdrop, but not on a click inside the sheet", () => {
    const { onClose } = mount(
      routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID),
    );
    fireEvent.mouseDown(screen.getByTestId("new-workflow-sheet"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("new-workflow-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names the chat section honestly: a label and one true sentence", () => {
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    const label = screen.getByTestId("new-workflow-chats-label");
    // The uppercasing is the label's own class (the section-label rule), so the
    // DOM keeps the sentence as written and a screen reader never hears SHOUT.
    expect(label.textContent).toBe("Or from something you keep doing in chats");
    expect(label.className).toContain("uppercase");
    expect(screen.getByTestId("new-workflow-copy-label").textContent).toBe("Or copy");
    expect(screen.getByTestId("new-workflow-chats-empty").textContent).toBe(
      "Nothing spotted yet. When the same steps keep happening in chats, they show up here.",
    );
  });

  it("offers the two links that skip the description", () => {
    mount(routesFor(createdPipeline("x", NEW_PIPELINE_ID), NEW_PIPELINE_ID, NEW_DRAFT_ID));
    expect(screen.getByTestId("new-workflow-blank").textContent).toBe("Blank canvas");
    fireEvent.click(screen.getByTestId("new-workflow-import"));
    expect(screen.getByTestId("import-yaml-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("import-yaml-cancel"));
    expect(screen.queryByTestId("import-yaml-dialog")).toBeNull();
    // Esc closed the import, not the sheet behind it.
    expect(screen.getByTestId("new-workflow-sheet")).toBeTruthy();
  });
});
