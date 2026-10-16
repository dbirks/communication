/**
 * The draft editor plus its per-step form (wishlist W4). The invariant under
 * test is that the form is a *view onto the textarea*: the textarea holds the
 * only copy of the document, a field edit rewrites one line of it, and `Save`
 * PUTs the whole text — the form never holds a parallel model the server would
 * never see. A `kind` with no fields must say so rather than render a form that
 * edits nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { DraftEditor } from "./DraftEditor";
import type { Draft } from "../../api/types";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const PIPELINE_ID = "01987b20-0000-7000-8000-abcdef012345";
const DRAFT_ID = "01987b30-0000-7000-8000-abcdef012345";
const draftPath = `/api/v1/drafts/${DRAFT_ID}`;

/** Small enough to assert on line by line: one `agent.acp`, one kind the form
 * does not know, one `model.chat` whose `prompt` the document never carried. */
export const draftYaml = [
  "apiVersion: communication.dev/v1alpha1",
  "kind: Pipeline",
  "spec:",
  "  nodes:",
  "  - id: plan",
  "    kind: agent.acp",
  "    timeoutSeconds: 900",
  "    config:",
  "      profile: m4-planner",
  "      prompt: |",
  "        Goal: plan the thing",
  "  - id: gate",
  "    kind: human.approval",
  "    config:",
  "      summary: Ship it",
  "      approverRoles: [maintainer]",
  "      deadlineSeconds: 86400",
  "      onTimeout: fail",
  "  - id: ask",
  "    kind: model.chat",
  "    config:",
  "      model: a-model",
  "  - id: loop",
  "    kind: until",
  "    config:",
  "      maxIterations: 4",
  "      carryForward: true",
  "      passWhen: nodes.loop_inner.outputs.ok == true",
  "      body:",
  "        nodes:",
  "        - id: loop_inner",
  "          kind: agent.acp",
  "          config:",
  "            profile: m4-implementer",
  "  - id: fan",
  "    kind: for_each",
  "    config:",
  "      items: ${{ nodes.inventory.outputs.rows }}",
  "      maxConcurrency: 2",
  "      body:",
  "        nodes:",
  "        - id: fan_inner",
  "          kind: process.exec",
  "          config:",
  "            executable: go",
  "  - id: verdict",
  "    kind: condition",
  "    config:",
  "      cases:",
  "      - when: nodes.loop.outputs.approved == true",
  "        route: verified",
  "      default: needs_attention",
  "  - id: publish",
  "    kind: artifact.publish",
  "    config:",
  "      name: review-evidence.md",
  "      kind: markdown",
  "      mediaType: text/markdown",
  "      sensitivity: standard",
  "      from:",
  "        mode: output_json",
  "  - id: invoke",
  "    kind: pipeline.invoke",
  "    config:",
  "      pipeline: other",
  "",
].join("\n");

function draftBody(status: Draft["status"], yaml = draftYaml): Draft {
  return {
    id: DRAFT_ID,
    pipeline_id: PIPELINE_ID,
    status,
    document_yaml: yaml,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: {},
    digest_scope: "v1alpha1-canonical-1",
    version: 4,
    edited_by: "01987b40-0000-7000-8000-abcdef012345",
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:12:00Z",
  };
}

function mount(
  status: Draft["status"] = "invalid",
  overrides: RouteStub[] = [],
  options: { canAuthor?: boolean } = {},
) {
  const canAuthor = options.canAuthor ?? true;
  const base: RouteStub[] = [
    { path: draftPath, body: draftBody(status) },
    { path: draftPath, method: "PUT", body: draftBody(status) },
    {
      path: `${draftPath}/validate`,
      method: "POST",
      body: { valid: false, digest_scope: "v1alpha1-canonical-1", errors: [], notes: [] },
    },
  ];
  const { requests } = mockFetch([...overrides, ...base]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  // A router, because the app mounts one: the guard's way out is `useNavigate`,
  // which needs it. `WhereAmI` is how the tests see the navigation the guard
  // allows, and the `<Link>` is the thing the shell's nav really renders — a
  // bare `navigate()` call is exactly what the guard cannot intercept.
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/library/p"]}>
        <Routes>
          <Route
            path="/library/p"
            element={
              <>
                <DraftEditor pipelineId={PIPELINE_ID} draftId={DRAFT_ID} canAuthor={canAuthor} />
                <Link to="/library">Library</Link>
              </>
            }
          />
          <Route path="/library" element={<p>library list</p>} />
        </Routes>
        <WhereAmI />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

/** The router's answer, so a test can watch a blocked navigation not happen. */
function WhereAmI() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

const area = () => screen.getByTestId("draft-editor-input") as HTMLTextAreaElement;
const field = (key: string) => screen.getByTestId(`draft-editor-field-${key}`) as HTMLInputElement;

describe("DraftEditor node form", () => {
  it("lists the nodes and edits the selected node's prompt back into the text", async () => {
    mount();
    await screen.findByTestId("draft-editor-input");
    expect(screen.getByTestId("draft-editor-node-0").textContent).toBe("plan");
    expect(screen.getByTestId("draft-editor-node-1").textContent).toBe("gate");
    // plan is the default selection, and its prompt is a `|` block in the text.
    const prompt = screen.getByTestId("draft-editor-field-prompt") as HTMLTextAreaElement;
    expect(prompt.value).toBe("Goal: plan the thing");

    fireEvent.change(prompt, { target: { value: "Goal: plan twice\nReply with JSON." } });
    const lines = area().value.split("\n");
    expect(lines[9]).toBe("      prompt: |");
    expect(lines[10]).toBe("        Goal: plan twice");
    expect(lines[11]).toBe("        Reply with JSON.");
    // The rest of the document is untouched, and the editor knows it is dirty.
    expect(lines.slice(12)).toEqual(draftYaml.split("\n").slice(11));
    expect(screen.getByTestId("draft-editor-dirty").textContent).toContain("unsaved");
  });

  it("writes a string quoted and a number bare, and Save PUTs the whole text", async () => {
    const { requests } = mount();
    await screen.findByTestId("draft-editor-input");
    const profile = screen.getByTestId("draft-editor-field-profile") as HTMLInputElement;
    const timeout = screen.getByTestId("draft-editor-field-timeoutSeconds") as HTMLInputElement;
    expect(profile.value).toBe("m4-planner");
    expect(timeout.value).toBe("900");

    fireEvent.change(profile, { target: { value: "it's m4's" } });
    fireEvent.change(timeout, { target: { value: "1200" } });
    const lines = area().value.split("\n");
    expect(lines[8]).toBe("      profile: 'it''s m4''s'");
    expect(lines[6]).toBe("    timeoutSeconds: 1200");

    const edited = area().value;
    fireEvent.click(screen.getByTestId("draft-editor-save"));
    await waitFor(() => expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, draftPath, "PUT")[0].body ?? "{}");
    expect(body.version).toBe(4);
    // The PUT carries the edited document, not a fragment of it.
    expect(body.document_yaml).toBe(edited);
    expect(body.document_yaml).toContain("      profile: 'it''s m4''s'");
    expect(body.document_yaml).toContain("kind: human.approval");
  });

  it("says so when a kind has no editable fields", async () => {
    mount();
    await screen.findByTestId("draft-editor-input");
    // `pipeline.invoke` carries only nested config (pipeline / inputs /
    // childLimits): nothing the fixed table edits, so the pane admits it.
    fireEvent.click(screen.getByTestId("draft-editor-node-7"));
    expect(screen.getByTestId("draft-editor-no-fields").textContent).toContain(
      "no editable fields",
    );
    expect(screen.queryByTestId("draft-editor-field-prompt")).toBeNull();
  });

  it("points at the YAML for a key the document does not carry", async () => {
    mount();
    await screen.findByTestId("draft-editor-input");
    fireEvent.click(screen.getByTestId("draft-editor-node-2"));
    expect(field("model").value).toBe("a-model");
    expect(screen.getByTestId("draft-editor-field-missing").textContent).toContain(
      "add it in the YAML",
    );
    expect(screen.getByTestId("draft-editor-field-missing").textContent).toContain(
      "/spec/nodes/2/config/prompt",
    );
    expect(screen.getByTestId("draft-editor-field-prompt").hasAttribute("disabled")).toBe(true);
  });

  it("follows the textarea: a hand-edited document re-reads its fields", async () => {
    mount();
    await screen.findByTestId("draft-editor-input");
    fireEvent.change(area(), {
      target: { value: area().value.replace("profile: m4-planner", "profile: by-hand") },
    });
    expect(field("profile").value).toBe("by-hand");
    // A document with no nodes leaves the form with nothing to pick.
    fireEvent.change(area(), { target: { value: "apiVersion: x\nspec:\n  nodes: []\n" } });
    expect(screen.getByTestId("draft-editor-no-nodes")).toBeDefined();
  });
});

/**
 * A draft that has never been validated has no verdict to show. That used to
 * blank the page: the server sends a new draft whose `validation` is an empty
 * block, `viewValidate` mapped over an absent `errors` array, and the thrown
 * `TypeError` took the whole route with it. The editor must render the absence
 * as itself — "not validated yet" — and never as a pass.
 */
function mountWithValidation(validation: unknown, status: Draft["status"] = "draft") {
  return mount(status, [{ path: draftPath, body: { ...draftBody(status), validation } }]);
}

describe("DraftEditor with an unvalidated draft", () => {
  it("says so when the draft carries no validation at all", async () => {
    mount("draft");
    await screen.findByTestId("draft-editor-input");
    expect(screen.getByTestId("draft-editor-not-validated").textContent).toContain(
      "not validated yet",
    );
    expect(screen.getByTestId("draft-editor-not-validated").textContent).toContain(
      "press Validate",
    );
    expect(screen.getByTestId("draft-editor-verdict").textContent).toBe("never validated");
    expect(screen.queryByTestId("draft-editor-findings")).toBeNull();
    // Validity is the server's to report; nothing here enables publish.
    expect(screen.getByTestId("draft-editor-publish").hasAttribute("disabled")).toBe(true);
  });

  it("renders the empty validation block a new draft really served", async () => {
    mountWithValidation({});
    await screen.findByTestId("draft-editor-input");
    expect(screen.getByTestId("draft-editor-not-validated")).toBeDefined();
    expect(screen.getByTestId("draft-editor-verdict").textContent).toBe("never validated");
  });

  it("does not crash on a verdict with no findings array behind it", async () => {
    mountWithValidation({ valid: false });
    await screen.findByTestId("draft-editor-input");
    expect(screen.getByTestId("draft-editor-findings")).toBeDefined();
    expect(screen.getByTestId("draft-editor-verdict").textContent).toBe("0 findings");
    expect(screen.getByTestId("draft-editor-notes").textContent).toContain("no notes");
  });

  it("shows the findings a validated draft does serve", async () => {
    mountWithValidation({
      valid: false,
      digest_scope: "v1alpha1-canonical-1",
      errors: [
        {
          code: "unknown_profile",
          source: "compiler",
          message: "profile `m4-planner` is not known to this organization",
          instance_location: "/spec/nodes/0/config/profile",
        },
      ],
      notes: [],
    });
    await screen.findByTestId("draft-editor-input");
    expect(screen.getByTestId("draft-editor-problem-0").textContent).toContain("unknown_profile");
    expect(screen.getByTestId("draft-editor-verdict").textContent).toBe("1 findings");
    expect(screen.queryByTestId("draft-editor-not-validated")).toBeNull();
  });
});

/**
 * The six kinds that used to render "no editable fields" over a node whose
 * config was full of real keys. Each edit must land on its own line of the
 * textarea — the form is a view onto the document, never a parallel model.
 */
describe("DraftEditor node form covers the whole library", () => {
  /** Select the node by its id and return the pane's field by key. */
  async function openNode(id: string) {
    mount();
    await screen.findByTestId("draft-editor-input");
    const nodes = await screen.findByTestId("draft-editor-nodes");
    const button = [...nodes.querySelectorAll("button")].find(
      (element) => element.textContent === id,
    );
    if (!button) throw new Error(`node ${id} is not in the picker`);
    fireEvent.click(button);
  }

  it("edits a human.approval's roles, deadline and timeout in place", async () => {
    await openNode("gate");
    expect(field("approverRoles").value).toBe("maintainer");
    expect(field("deadlineSeconds").value).toBe("86400");
    expect(field("onTimeout").value).toBe("fail");
    expect((screen.getByTestId("draft-editor-field-summary") as HTMLTextAreaElement).value).toBe(
      "Ship it",
    );

    fireEvent.change(field("approverRoles"), { target: { value: "maintainer, contributor" } });
    fireEvent.change(field("deadlineSeconds"), { target: { value: "3600" } });
    fireEvent.change(field("onTimeout"), { target: { value: "expire" } });
    const lines = area().value.split("\n");
    expect(lines[15]).toBe("      approverRoles: ['maintainer', 'contributor']");
    expect(lines[16]).toBe("      deadlineSeconds: 3600");
    expect(lines[17]).toBe("      onTimeout: 'expire'");
    // Approver ids are not in this document: the form says where to add them
    // rather than inventing a key the schema would refuse nothing of.
    expect(screen.getAllByTestId("draft-editor-field-missing").length).toBeGreaterThan(0);
    // Everything the form did not touch is where it was.
    expect(lines.filter((_, i) => ![15, 16, 17].includes(i)).join("\n")).toBe(
      draftYaml
        .split("\n")
        .filter((_, i) => ![15, 16, 17].includes(i))
        .join("\n"),
    );
  });

  it("edits an until's iterations and carryForward without touching its body", async () => {
    await openNode("loop");
    expect(field("maxIterations").value).toBe("4");
    expect(field("carryForward").value).toBe("true");
    fireEvent.change(field("maxIterations"), { target: { value: "6" } });
    fireEvent.change(field("carryForward"), { target: { value: "false" } });
    const lines = area().value.split("\n");
    expect(lines.some((line) => line === "      maxIterations: 6")).toBe(true);
    // A boolean writes bare: `'false'` is a string where the schema wants a bool.
    expect(lines.some((line) => line === "      carryForward: false")).toBe(true);
    expect(lines.some((line) => line === "        nodes:")).toBe(true);
  });

  it("edits a for_each's items and concurrency", async () => {
    await openNode("fan");
    expect(field("items").value).toBe("${{ nodes.inventory.outputs.rows }}");
    fireEvent.change(field("maxConcurrency"), { target: { value: "4" } });
    expect(area().value).toContain("      maxConcurrency: 4");
  });

  it("edits a condition's default and admits its cases stay in the YAML", async () => {
    await openNode("verdict");
    expect(field("default").value).toBe("needs_attention");
    fireEvent.change(field("default"), { target: { value: "rejected" } });
    expect(area().value).toContain("      default: 'rejected'");
    // `cases` is an array of {when, route}: structure this form will not rewrite.
    expect(area().value).toContain("      - when: nodes.loop.outputs.approved == true");
    expect(screen.getByTestId("draft-editor-yaml-only").textContent).toContain(
      "config.cases (when/route pairs)",
    );
  });

  it("edits an artifact.publish's name, kind and sensitivity, leaving from: alone", async () => {
    await openNode("publish");
    expect(field("name").value).toBe("review-evidence.md");
    expect(field("kind").value).toBe("markdown");
    expect(field("sensitivity").value).toBe("standard");
    fireEvent.change(field("name"), { target: { value: "evidence.md" } });
    fireEvent.change(field("sensitivity"), { target: { value: "restricted" } });
    const text = area().value;
    expect(text).toContain("      name: 'evidence.md'");
    expect(text).toContain("      sensitivity: 'restricted'");
    expect(text).toContain("      from:\n        mode: output_json");
    expect(screen.getByTestId("draft-editor-yaml-only").textContent).toContain("config.from");
  });

  it("offers agent.acp's session mode and secret refs, which the old table omitted", async () => {
    await openNode("plan");
    // The keys exist in the form now; this draft does not carry them, so each
    // points at the pointer to add rather than inventing a line.
    expect(screen.getByTestId("draft-editor-field-sessionMode")).toBeDefined();
    expect(screen.getByTestId("draft-editor-field-secretRefs").hasAttribute("disabled")).toBe(true);
    const hints = screen.getAllByTestId("draft-editor-field-missing").map((el) => el.textContent);
    expect(hints.some((text) => text?.includes("/spec/nodes/0/config/sessionMode"))).toBe(true);
    expect(screen.getByTestId("draft-editor-yaml-only").textContent).toContain("config.workspace");
  });

  it("writes a session mode the draft already carries, as the enum value it is", async () => {
    const yaml = [
      "spec:",
      "  nodes:",
      "  - id: plan",
      "    kind: agent.acp",
      "    config:",
      "      profile: m4-planner",
      "      prompt: do it",
      "      sessionMode: new",
      "      secretRefs: [project/gh_token]",
      "",
    ].join("\n");
    mount("draft", [{ path: draftPath, body: draftBody("draft", yaml) }]);
    await screen.findByTestId("draft-editor-input");
    const mode = screen.getByTestId("draft-editor-field-sessionMode") as HTMLSelectElement;
    expect(mode.value).toBe("new");
    fireEvent.change(mode, { target: { value: "resume_if_supported" } });
    expect(field("secretRefs").value).toBe("project/gh_token");
    fireEvent.change(field("secretRefs"), { target: { value: "project/gh_token, org/npm" } });
    const lines = area().value.split("\n");
    expect(lines[7]).toBe("      sessionMode: 'resume_if_supported'");
    expect(lines[8]).toBe("      secretRefs: ['project/gh_token', 'org/npm']");
  });
});

/**
 * The role rule and the unsaved-changes guard.
 *
 * Both bugs were the same failure of nerve: the sidebar said "authoring needs
 * the library role" while the editor handed everyone a writable textarea with
 * an enabled Save, and the chip said "unsaved" while the nav threw the edit away
 * without a word. The permission answer is the server's (`requireLibraryRole` =
 * `is_org_admin`, `api/pipelines.go`); the nav answer is the guard in
 * `lib/pipeline/unsavedGuard.ts`.
 */
describe("DraftEditor permissions", () => {
  it("is a read-only view for a caller without the library role", async () => {
    const { requests } = mount("valid", [], { canAuthor: false });
    await screen.findByTestId("draft-editor-input");
    const input = area();
    expect(input.hasAttribute("readonly")).toBe(true);

    fireEvent.change(input, { target: { value: `${input.value}\n# tampered` } });
    // The `readonly` attribute is what stops a real browser's keystrokes;
    // `fireEvent` does not honour it, so this asserts the stronger thing — even
    // with text the server does not have, Save stays disabled and carries the
    // reason, so no write is reachable. Publish refuses for the same reason even
    // though the server called this draft valid.
    expect(screen.getByTestId("draft-editor-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("draft-editor-save").getAttribute("title")).toContain("library role");
    expect(screen.getByTestId("draft-editor-publish").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("draft-editor-publish").getAttribute("title")).toContain(
      "library role",
    );
    expect(screen.getByTestId("draft-editor-read-only").textContent).toContain(
      "read-only — editing a shared draft needs the library role",
    );
    expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(0);
  });

  it("disables the node form for a caller without the library role", async () => {
    mount("valid", [], { canAuthor: false });
    await screen.findByTestId("draft-editor-input");
    expect(field("profile").hasAttribute("disabled")).toBe(true);
    expect(area().hasAttribute("readonly")).toBe(true);
  });

  it("keeps Save enabled for the library role, gated only on dirtiness", async () => {
    mount("valid");
    await screen.findByTestId("draft-editor-input");
    // Clean: nothing to save. Dirty: the role that holds it may save.
    expect(screen.getByTestId("draft-editor-save").hasAttribute("disabled")).toBe(true);
    fireEvent.change(area(), { target: { value: "# edited\n" } });
    expect(screen.getByTestId("draft-editor-save").hasAttribute("disabled")).toBe(false);
  });
});

describe("DraftEditor unsaved-changes guard", () => {
  it("asks before a nav link discards the edit, and keeps the text on stay", async () => {
    mount("draft");
    await screen.findByTestId("draft-editor-input");
    fireEvent.change(area(), { target: { value: "spec:\n  nodes: []\n# keep me\n" } });
    expect(screen.getByTestId("draft-editor-dirty").textContent).toContain("unsaved");

    fireEvent.click(screen.getByText("Library"));
    // The click never became a navigation: the page is still where it was, and
    // the editor is asking in its own words.
    expect(screen.getByTestId("where").textContent).toBe("/library/p");
    const guard = screen.getByTestId("draft-editor-leave-guard");
    expect(guard.textContent).toContain("unsaved changes");
    expect(area().value).toContain("keep me");

    fireEvent.click(screen.getByTestId("draft-editor-leave-stay"));
    expect(screen.queryByTestId("draft-editor-leave-guard")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/library/p");
    expect(area().value).toContain("keep me");
  });

  it("leaves, discarding, when the caller confirms", async () => {
    mount("draft");
    await screen.findByTestId("draft-editor-input");
    fireEvent.change(area(), { target: { value: "spec:\n  nodes: []\n# throw me away\n" } });
    fireEvent.click(screen.getByText("Library"));
    fireEvent.click(screen.getByTestId("draft-editor-leave-discard"));
    expect(screen.getByTestId("where").textContent).toBe("/library");
    expect(screen.getByText("library list")).toBeDefined();
  });

  it("does not ask when there is nothing unsaved", async () => {
    mount("draft");
    await screen.findByTestId("draft-editor-input");
    fireEvent.click(screen.getByText("Library"));
    expect(screen.queryByTestId("draft-editor-leave-guard")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/library");
  });

  it("asks the browser before a reload or close throws the edit away", async () => {
    mount("draft");
    await screen.findByTestId("draft-editor-input");
    fireEvent.change(area(), { target: { value: "# dirty\n" } });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    // Once saved, the guard stops holding the window shut.
    fireEvent.click(screen.getByTestId("draft-editor-save"));
    await waitFor(() => expect(screen.queryByTestId("draft-editor-dirty")).toBeNull());
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
