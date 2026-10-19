/**
 * The shared conversation surface: one panel for the page and the docks.
 *
 * Mocked at the fetch boundary, the same way the conversation page's suite is
 * (route stubs plus a fake `EventSource` the test drives), so the assertions
 * are about what a member sees: the dock's transcript and open-full link, the
 * viewer's disabled handoff, the controller's live composer, and the
 * non-controller's explainer.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { render as renderDom, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { setCsrfToken } from "../../api/client";
import { AgentConversationPanel } from "./AgentConversationPanel";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  controlledByOther,
  meFixture,
  projectFixture,
  mockFetch,
  type RouteStub,
} from "../../test/fakes";
import type { Conversation } from "../../api/types";

afterEach(cleanup);

/** The panel is a component, not a page: wrap it in the app's providers only. */
function renderPanel(ui: ReactNode, routes: RouteStub[]) {
  setCsrfToken(null);
  mockFetch(routes, {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return renderDom(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const projectPath = `/api/v1/projects/${projectFixture.id}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;

function routes(conversation: Conversation, myRole: string = "maintainer"): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, method: "GET", body: { ...projectFixture, my_role: myRole } },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: conversationPath, method: "GET", body: conversation },
  ];
}

const dock = (props: Record<string, unknown> = {}) => (
  <AgentConversationPanel
    conversationId={conversationId}
    projectId={projectFixture.id}
    variant="dock"
    {...props}
  />
);

describe("AgentConversationPanel (dock)", () => {
  it("renders the transcript and the open-full conversation link", async () => {
    renderPanel(dock(), routes(conversationFixture));
    const open = await screen.findByTestId("dock-open-conversation");
    expect(open.getAttribute("href")).toBe(
      `/projects/${projectFixture.id}/conversations/${conversationId}`,
    );
    expect(screen.getByText("Open full conversation")).toBeTruthy();

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Fix the flaky spec",
        }),
      );
      source.emit(conversationEvent("conversation.message.agent", { text: "On it.", final: true }));
    });

    const transcript = await screen.findByTestId("transcript");
    const items = within(transcript).getAllByTestId("transcript-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Fix the flaky spec");
    // The dock badge says who is driving, in words.
    expect(screen.getByTestId("controller-badge").textContent).toContain("in control");
  });

  it("shows a disabled Take control to a viewer, and says watching is all they may do", async () => {
    renderPanel(dock(), routes(controlledByOther, "viewer"));
    const take = await screen.findByTestId("take-control");
    expect(take.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "watch this conversation",
    );
    expect(screen.getByTestId("composer-input").hasAttribute("disabled")).toBe(true);
  });

  it("gives the controller an enabled composer", async () => {
    renderPanel(
      dock({
        composer: {
          inputId: "panel-prompt",
          rows: 2,
          nonControllerPlaceholder: "Only the controller can prompt.",
        },
      }),
      routes(conversationFixture),
    );
    const input = await screen.findByTestId("composer-input");
    expect(input.hasAttribute("disabled")).toBe(false);
    const send = screen.getByTestId("composer-send");
    // Empty prompts are never sent.
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "Check the tests" } });
    expect(send.hasAttribute("disabled")).toBe(false);
  });

  it("shows the non-controller the explainer instead of a live composer", async () => {
    renderPanel(dock(), routes(controlledByOther));
    const input = await screen.findByTestId("composer-input");
    expect(input.hasAttribute("disabled")).toBe(true);
    const explainer = screen.getByTestId("composer-explainer");
    expect(explainer.textContent).toContain(
      "Only the controller (Dana Observer) can send prompts.",
    );
    expect(explainer.textContent).toContain("Take control to drive.");
  });
});
