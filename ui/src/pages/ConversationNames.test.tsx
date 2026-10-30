/**
 * M2 follow-ups, proven on the screen rather than in the fold: control events
 * name people, an empty tool input is not rendered as `{}`, and a closed
 * permission prompt stops shouting (handoff rule 05: the strong bar is only for
 * a panel that needs action).
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  FakeEventSource,
  claudeProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  meFixture,
  projectFixture,
  type RouteStub,
} from "../test/fakes";
import type { Member, User } from "../api/types";

const projectId = projectFixture.id;
const grace: User = {
  id: "01987a63-3333-7000-8000-abcdef012345",
  display_name: "Grace Hopper",
  email: null,
};
const members: Member[] = [
  { user_id: grace.id, display_name: grace.display_name, role: "contributor" },
];

const page = `/p/${projectId}/conversations/${conversationId}`;

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: `/api/v1/projects/${projectId}`, method: "GET", body: projectFixture },
    { path: `/api/v1/projects/${projectId}/members`, method: "GET", body: { items: members } },
    { path: "/api/v1/users", method: "GET", body: { items: [grace] } },
    { path: `/api/v1/conversations/${conversationId}`, method: "GET", body: conversationFixture },
    // The M3 context rail reads these; this file is about the transcript.
    { path: `/api/v1/projects/${projectId}/workspaces`, method: "GET", body: { workspaces: [] } },
  ];
}

/** Every line currently in the transcript, as a person reads it. */
async function transcriptLines(): Promise<string[]> {
  const root = await screen.findByTestId("transcript");
  return within(root)
    .getAllByTestId("transcript-item")
    .map((item) => item.textContent ?? "");
}

describe("control events name the humans involved", () => {
  it("says who took control, in their display name", async () => {
    renderApp({ path: page, routes: routes() });
    await screen.findByTestId("conversation-title");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.control.transferred", {
          from_kind: "human",
          from_user_id: meFixture.id,
          to_kind: "human",
          to_user_id: grace.id,
          reason: "taken",
          control_version: 2,
        }),
      );
    });

    const lines = await transcriptLines();
    expect(lines.some((line) => line.includes("Control taken by Grace Hopper"))).toBe(true);
    // The uuid is not a label, and it is nowhere on the line that replaced it.
    expect(lines.some((line) => line.includes(grace.id))).toBe(false);
  });

  it("says who it returned to, and never invents a name it does not have", async () => {
    renderApp({ path: page, routes: routes() });
    await screen.findByTestId("conversation-title");
    const stranger = "01987aaa-bbbb-7000-8000-abcdef012345";

    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.control.transferred", {
          to_kind: "human",
          to_user_id: grace.id,
          reason: "returned",
        }),
      );
      source.emit(
        conversationEvent("conversation.control.transferred", {
          to_kind: "human",
          to_user_id: stranger,
          reason: "taken",
        }),
      );
    });

    const lines = await transcriptLines();
    expect(lines.some((line) => line.includes("Control returned to Grace Hopper"))).toBe(true);
    // A person the directory does not know is "someone (ef012345)" — the uuid's
    // random tail, never its time prefix (which every id created nearby shares),
    // never a bare uuid and never a guessed name. The directory is asked about
    // this id — the stubs answer, and answer without them — so the fallback
    // stands after the bounded re-lookups of `api/actors.ts`.
    expect(lines.some((line) => line.includes("someone (ef012345)"))).toBe(true);
    expect(lines.some((line) => line.includes(stranger))).toBe(false);
  });

  it("keeps the badge and the prompt-explanation in the same words", async () => {
    renderApp({
      path: page,
      routes: routes([
        {
          path: `/api/v1/conversations/${conversationId}`,
          method: "GET",
          body: {
            ...conversationFixture,
            control: {
              kind: "human",
              user_id: grace.id,
              display_name: null,
              previous_user_id: meFixture.id,
              version: 4,
            },
          },
        },
      ]),
    });
    // The badge resolves the id through the directory rather than showing "you"
    // or a uuid to somebody who is not the controller.
    const badge = await screen.findByTestId("controller-badge");
    expect(badge.textContent).toContain("Grace Hopper");
    expect(badge.textContent).not.toContain(grace.id);
    fireEvent.click(screen.getByTestId("take-control"));
  });
});

describe("a tool call with no arguments says so by showing nothing", () => {
  it("renders no input block for the `{}` an ACP harness sends", async () => {
    renderApp({ path: page, routes: routes() });
    await screen.findByTestId("conversation-title");

    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_empty",
          title: "List files",
          kind: "execute",
          status: "in_progress",
          input_preview: "{}",
        }),
      );
      source.emit(
        conversationEvent("conversation.tool.update", {
          tool_call_id: "toolu_empty",
          status: "completed",
          output_preview: '{"a":1}',
        }),
      );
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_real",
          title: "Edit secrets.go",
          kind: "edit",
          status: "in_progress",
          input_preview: '{"path":"internal/api/secrets.go"}',
        }),
      );
    });

    const root = await screen.findByTestId("transcript");
    const empty = within(root)
      .getAllByTestId("transcript-item")
      .find((item) => item.textContent?.includes("List files"));
    expect(empty).toBeDefined();
    // Rows start collapsed (6d); expand them to see what the call carried.
    fireEvent.click(within(empty as HTMLElement).getByTestId("tool-row-toolu_empty"));
    expect(within(empty as HTMLElement).queryByTestId("tool-preview-input")).toBeNull();
    // A real output still shows, and a real input still shows.
    expect(within(empty as HTMLElement).getByTestId("tool-preview-output").textContent).toContain(
      '"a":1',
    );
    const real = within(root)
      .getAllByTestId("transcript-item")
      .find((item) => item.textContent?.includes("Edit secrets.go"));
    fireEvent.click(within(real as HTMLElement).getByTestId("tool-row-toolu_real"));
    expect(within(real as HTMLElement).getByTestId("tool-preview-input").textContent).toContain(
      "secrets.go",
    );
    // Nowhere in the transcript is a bare pair of braces standing in for content.
    expect(root.textContent).not.toMatch(/^\{\}$/m);
    expect(root.textContent).not.toContain(" {} ");
    expect(root.textContent).not.toContain("{}");
  });
});

describe("permission prompts shout only while they need a decision", () => {
  const requested = (requestId: string) =>
    conversationEvent("conversation.permission.requested", {
      permission_request_id: requestId,
      tool_call_id: "toolu_1",
      title: "Write outside the workspace",
      kind: "edit",
      options: [
        { option_id: "allow_once", label: "Allow once", kind: "allow_once" },
        { option_id: "reject", label: "Reject", kind: "reject_always" },
      ],
      deadline_at: "2026-10-14T18:05:00Z",
    });

  function toneOf(card: HTMLElement): string | null {
    return card.querySelector("[data-ds-bar]")?.getAttribute("data-tone") ?? null;
  }

  it("uses the strong bar while it is pending and the gray bar once it is decided", async () => {
    renderApp({ path: page, routes: routes() });
    await screen.findByTestId("conversation-title");

    act(() => {
      FakeEventSource.last().emit(requested("perm_1"));
    });
    const root = await screen.findByTestId("transcript");
    const card = within(root).getByTestId("permission-card");
    // Pending: the controller owes an answer, so the bar takes the state's color.
    expect(toneOf(card)).toBe("strong");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.permission.decided", {
          permission_request_id: "perm_1",
          status: "decided",
          decision_option_id: "allow_once",
          decided_by: meFixture.id,
        }),
      );
    });
    // Decided: a closed record. Gray bar, state still visible as a chip.
    expect(toneOf(card)).toBe("neutral");
    expect(screen.getByTestId("permission-status-perm_1").textContent).toContain("decided");
    expect(card.textContent).toContain("Allow once");
  });

  it("grays an expired prompt too, because nobody can act on it any more", async () => {
    renderApp({ path: page, routes: routes() });
    await screen.findByTestId("conversation-title");

    act(() => {
      const source = FakeEventSource.last();
      source.emit(requested("perm_2"));
      source.emit(
        conversationEvent("conversation.permission.decided", {
          permission_request_id: "perm_2",
          status: "expired",
          decision_option_id: null,
          decided_by: null,
        }),
      );
    });

    const root = await screen.findByTestId("transcript");
    const card = within(root).getByTestId("permission-card");
    expect(toneOf(card)).toBe("neutral");
    expect(screen.getByTestId("permission-status-perm_2").textContent).toContain("expired");
    // An expired prompt is history, so no decision control is offered for it.
    expect(within(card).queryByTestId("permission-allow")).toBeNull();
  });

  it("keeps a read-only prompt's explanation aimed at whoever may decide", async () => {
    renderApp({
      path: page,
      routes: routes([
        {
          path: `/api/v1/conversations/${conversationId}`,
          method: "GET",
          body: {
            ...conversationFixture,
            control: {
              kind: "human",
              user_id: grace.id,
              display_name: null,
              previous_user_id: meFixture.id,
              version: 5,
            },
          },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");
    act(() => {
      FakeEventSource.last().emit(requested("perm_2"));
    });
    const root = await screen.findByTestId("transcript");
    const card = within(root).getByTestId("permission-card");
    // The bar is still strong: an open prompt needs *somebody's* action even when
    // it is not yours — but the buttons are not yours to press.
    expect(toneOf(card)).toBe("strong");
    expect(within(card).queryByTestId("permission-allow")).toBeNull();
    expect(within(card).getByTestId("permission-readonly").textContent).toContain("Grace Hopper");
  });
});
