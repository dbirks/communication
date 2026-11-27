/**
 * useStudioDraft — the Studio's draft state over the version-checked draft
 * contract: apply/undo/redo over {text, ui_layout} snapshots, ambiguous op
 * passthrough, invalid-YAML lastGood, and the save 409 → conflict recovery.
 *
 * Driven against the fake fetch like the page tests: one `GET /drafts/{id}`
 * read and a `PUT` stub per write.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { parse } from "yaml";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Draft } from "../../api/types";
import { addNode, type OpResult } from "../../lib/pipeline/graphDoc";
import { useStudioDraft, uiLayoutOfText, withUILayout } from "./useStudioDraft";
import { moveDraggedNode } from "./StudioCanvas";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const DRAFT_ID = "draft-studio-00000001";
const PIPELINE_ID = "pipeline-studio-0000001";
const draftPath = `/api/v1/drafts/${DRAFT_ID}`;

const YAML = [
  "apiVersion: communication.dev/v1alpha1",
  "kind: Pipeline",
  "metadata:",
  "  name: hook-test",
  "spec:",
  "  nodes:",
  "  - id: first",
  "    kind: process.exec",
  "    config:",
  "      executable: sh",
  "      args: []",
].join("\n");

const LAYOUT = { nodes: { first: { x: 10, y: 20 } } };

function wireDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: DRAFT_ID,
    pipeline_id: PIPELINE_ID,
    status: "draft",
    document_yaml: YAML,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: LAYOUT,
    digest_scope: "v1alpha1-canonical-1",
    version: 5,
    edited_by: "user-1",
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:12:00Z",
    ...overrides,
  };
}

function mount(overrides: RouteStub[] = []) {
  // The base draft stub is GET-only so the PUT stubs the tests pass below are
  // the only thing that can answer a save (mockFetch matches the first stub
  // whose path and method fit).
  const { fetchMock, requests } = mockFetch([
    { path: draftPath, method: "GET", body: wireDraft() },
    ...overrides,
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const hook = renderHook(() => useStudioDraft(DRAFT_ID), {
    wrapper: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MemoryRouter, null, children),
      ),
  });
  // The draft read lands and the hook seeds its state before any assertion.
  void waitFor(() => expect(hook.result.current.savedVersion).toBe(5));
  return { fetchMock, requests, ...hook };
}

describe("useStudioDraft", () => {
  it("apply commits an op; undo and redo walk the {text, layout} snapshots", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.text).toBe(YAML));

    const op = () => addNode(result.current.text, { kind: "process.exec", scope: [] });
    let again!: OpResult;
    await act(async () => {
      again = result.current.apply(op);
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(result.current.text).toContain(`- id: ${again.changed[0]}`);
    expect(result.current.dirty).toBe(true);
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      result.current.undo();
    });
    expect(result.current.text).toBe(YAML);
    expect(result.current.canRedo).toBe(true);
    await act(async () => {
      result.current.redo();
    });
    expect(result.current.text).toContain(`- id: ${again.changed[0]}`);
    // The layout snapshot rides the undo too: a move is reverted with it.
  });

  it("move is undoable and only touches ui_layout, never the YAML", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.text).toBe(YAML));
    await act(async () => {
      result.current.move("first", { x: 99, y: 100 });
    });
    expect(result.current.layout.nodes?.["first"]).toEqual({ x: 99, y: 100 });
    expect(result.current.text).toBe(YAML);
    await act(async () => {
      result.current.undo();
    });
    expect(result.current.layout).toEqual(LAYOUT);
  });

  it("passes an ambiguous op through without touching the text", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.text).toBe(YAML));
    const outcome = result.current.apply(() => ({
      ok: false,
      ambiguous: true,
      reasons: ["approve only runs when nodes.check.outputs.route == 'pass'"],
    }));
    expect(outcome).toEqual({
      ok: false,
      ambiguous: true,
      reasons: ["approve only runs when nodes.check.outputs.route == 'pass'"],
    });
    expect(result.current.text).toBe(YAML);
    expect(result.current.canUndo).toBe(false);
  });
  it("invalid YAML keeps the text and the last good graph", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.text).toBe(YAML));
    expect(result.current.lastGood?.model.nodes).toHaveLength(1);

    await act(async () => {
      result.current.setText("kind: [broken");
    });
    expect(result.current.text).toBe("kind: [broken");
    expect(result.current.parse.ok).toBe(false);
    expect(result.current.lastGood?.model.nodes).toHaveLength(1);
    // A graph op on broken text is refused, and the text is kept either way.
    let refused!: OpResult;
    await act(async () => {
      refused = result.current.apply((text) => addNode(text, { kind: "until", scope: [] }));
    });
    expect(refused.ok).toBe(false);
    expect(result.current.text).toBe("kind: [broken");
  });

  it("save bakes the layout into metadata.ui and sends only {document_yaml, version}", async () => {
    const { requests, result } = mount([
      { path: draftPath, method: "PUT", body: wireDraft({ version: 6 }) },
    ]);
    await waitFor(() => expect(result.current.text).toBe(YAML));
    const dropped = { id: "first", data: { id: "first" }, position: { x: 99, y: 111 } };
    act(() => moveDraggedNode(dropped, [dropped], result.current.move));
    const ok = await result.current.save();
    expect(ok).toBe(true);
    const puts = requestsTo(requests, draftPath, "PUT");
    expect(puts).toHaveLength(1);
    const body = JSON.parse(puts[0].body ?? "{}") as {
      document_yaml?: string;
      version?: number;
      ui_layout?: unknown;
    };
    // The frozen wire schema 400s on any other member — positions ride the
    // bytes as the digest-excluded `metadata.ui` block instead.
    expect(body.ui_layout).toBeUndefined();
    expect(body.version).toBe(5);
    const baked = body.document_yaml ?? "";
    expect(baked).not.toBe(YAML);
    expect(uiLayoutOfText(baked)).toEqual({ nodes: { first: { x: 100, y: 120 } } });
    await waitFor(() => expect(result.current.savedVersion).toBe(6));
    expect(result.current.dirty).toBe(false);
  });

  it("withUILayout / uiLayoutOfText round-trip the canvas layout through metadata.ui", () => {
    const empty = { nodes: {} };
    expect(withUILayout(YAML, empty)).toBe(YAML);
    const baked = withUILayout(YAML, LAYOUT);
    expect(baked).toContain("ui:");
    expect(uiLayoutOfText(baked)).toEqual(LAYOUT);
    // A second save replaces the block in place, not a second one.
    const moved = withUILayout(baked, { nodes: { first: { x: 1, y: 2 } } });
    expect(moved.split("ui:").length).toBe(2);
    expect(uiLayoutOfText(moved)).toEqual({ nodes: { first: { x: 1, y: 2 } } });
    // Broken text is passed through untouched.
    const broken = "kind: [broken";
    expect(withUILayout(broken, LAYOUT)).toBe(broken);
    expect(uiLayoutOfText(broken)).toEqual({});
  });

  it("notes ride ui_layout: an add, an edit and a delete never touch the YAML", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.text).toBe(YAML));
    const note = { id: "note-1", x: 400, y: 60, width: 200, text: "check with Ada" };

    await act(async () => {
      result.current.setNotes([note]);
    });
    expect(result.current.layout.notes).toEqual([note]);
    // The definition text is byte-identical: a note cannot change what a run
    // executes, and there is no note step in the document.
    expect(result.current.text).toBe(YAML);
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      result.current.setNotes([{ ...note, text: "check with Ada before making live" }]);
    });
    expect(result.current.layout.notes).toEqual([
      { ...note, text: "check with Ada before making live" },
    ]);

    await act(async () => {
      result.current.undo();
    });
    expect(result.current.layout.notes).toEqual([note]);

    // A move keeps the notes it was not told about.
    await act(async () => {
      result.current.move("first", { x: 99, y: 100 });
    });
    expect(result.current.layout.notes).toEqual([note]);
    expect(result.current.layout.nodes?.["first"]).toEqual({ x: 99, y: 100 });
  });

  it("saves notes in ui_layout through the draft, and the note never enters the document", async () => {
    const { requests, result } = mount([
      { path: draftPath, method: "PUT", body: wireDraft({ version: 6 }) },
    ]);
    await waitFor(() => expect(result.current.text).toBe(YAML));
    await act(async () => {
      result.current.setNotes([
        { id: "note-1", x: 420, y: 60, width: 200, text: "check with Ada before making live" },
      ]);
    });
    expect(await result.current.save()).toBe(true);

    const puts = requestsTo(requests, draftPath, "PUT");
    expect(puts).toHaveLength(1);
    const body = JSON.parse(puts[0].body ?? "{}") as {
      document_yaml?: string;
      version?: number;
      ui_layout?: unknown;
    };
    // The frozen wire body is still exactly {document_yaml, version}.
    expect(body.ui_layout).toBeUndefined();
    const baked = body.document_yaml ?? "";
    const layout = uiLayoutOfText(baked);
    expect(layout.notes).toEqual([
      { id: "note-1", x: 420, y: 60, width: 200, text: "check with Ada before making live" },
    ]);
    // Nothing outside `metadata.ui` changed: the executable part of the
    // document — the spec the compiler reads and a run pins — is untouched,
    // so a note cannot change what a run executes.
    const withoutUi = (text: string) => {
      const doc = parse(text) as { metadata?: Record<string, unknown> };
      delete doc.metadata?.ui;
      return JSON.stringify(doc);
    };
    expect(withoutUi(baked)).toBe(withoutUi(YAML));
    expect(baked).not.toContain("check with Ada before making live\n  spec");
  });

  it("ui_layout fields the editor does not know survive the write and the read", () => {
    const layout = {
      nodes: { first: { x: 10, y: 20 } },
      notes: [{ id: "note-1", x: 40, y: 60, width: 200, text: "keep me" }],
      // Something the canvas has never heard of: another tool's bytes.
      minimap: { enabled: true, zoom: 0.8 },
    };
    const baked = withUILayout(YAML, layout);
    expect(uiLayoutOfText(baked)).toEqual(layout);
  });

  it("a deleted note stays deleted through the save path", async () => {
    const { requests, result } = mount([
      { path: draftPath, method: "PUT", body: wireDraft({ version: 6 }) },
    ]);
    await waitFor(() => expect(result.current.text).toBe(YAML));
    await act(async () => {
      result.current.setNotes([{ id: "note-1", x: 40, y: 60, width: 200, text: "old note" }]);
    });
    expect(await result.current.save()).toBe(true);
    const first = (
      JSON.parse(requestsTo(requests, draftPath, "PUT").at(-1)!.body ?? "{}") as {
        document_yaml?: string;
      }
    ).document_yaml;
    expect(uiLayoutOfText(first ?? "").notes).toHaveLength(1);

    await act(async () => {
      result.current.setNotes([]);
    });
    expect(await result.current.save()).toBe(true);
    const second = (
      JSON.parse(requestsTo(requests, draftPath, "PUT").at(-1)!.body ?? "{}") as {
        document_yaml?: string;
      }
    ).document_yaml;
    // The ui block is replaced, not merged: nothing is left to resurrect.
    expect(uiLayoutOfText(second ?? "").notes).toBeUndefined();
    expect(second).not.toContain("old note");
    expect(result.current.layout.nodes).toEqual(LAYOUT.nodes);
  });

  it("a 409 stale_draft_version becomes a conflict with the server's version", async () => {
    const { result } = mount([
      {
        path: draftPath,
        method: "PUT",
        status: 409,
        body: {
          type: "https://communication.dev/errors/stale-draft-version",
          title: "Stale draft version",
          status: 409,
          detail: "the draft moved on under you",
          draft_id: DRAFT_ID,
          current_version: 9,
        },
      },
    ]);
    await waitFor(() => expect(result.current.text).toBe(YAML));
    let ok: boolean = false;
    await act(async () => {
      ok = await result.current.save();
    });
    expect(ok).toBe(false);
    expect(result.current.conflict).toEqual({ currentVersion: 9 });
    expect(result.current.savedVersion).toBe(5);
    expect(result.current.dirty).toBe(true);
  });

  it("overwrite re-PUTs against the server's newer version and wins", async () => {
    // One stateful stub: the first PUT 409s, the overwrite's PUT succeeds.
    // (mockFetch answers from the first matching stub, so the stub itself is
    // rewritten between the two calls.)
    const stub: RouteStub = {
      path: draftPath,
      method: "PUT",
      status: 409,
      body: {
        type: "https://communication.dev/errors/stale-draft-version",
        title: "Stale draft version",
        status: 409,
        detail: "stale",
        draft_id: DRAFT_ID,
        current_version: 9,
      },
    };
    const { requests, result } = mount([stub]);
    await waitFor(() => expect(result.current.text).toBe(YAML));
    await act(async () => {
      await expect(result.current.save()).resolves.toBe(false);
    });
    expect(result.current.conflict).toEqual({ currentVersion: 9 });
    stub.status = 200;
    stub.body = wireDraft({ version: 10 });
    await act(async () => {
      await expect(result.current.overwrite()).resolves.toBe(true);
    });
    const puts = requestsTo(requests, draftPath, "PUT");
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1].body ?? "{}").version).toBe(9);
    await waitFor(() => expect(result.current.savedVersion).toBe(10));
    expect(result.current.conflict).toBeNull();
  });
});
