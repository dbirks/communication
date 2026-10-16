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
  "  - id: ask",
  "    kind: model.chat",
  "    config:",
  "      model: a-model",
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

function mount(status: Draft["status"] = "invalid", overrides: RouteStub[] = []) {
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
  render(
    <QueryClientProvider client={queryClient}>
      <DraftEditor pipelineId={PIPELINE_ID} draftId={DRAFT_ID} />
    </QueryClientProvider>,
  );
  return { requests };
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
    fireEvent.click(screen.getByTestId("draft-editor-node-1"));
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
