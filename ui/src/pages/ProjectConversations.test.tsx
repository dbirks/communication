/**
 * Where a conversation was opened stays the row badge's job on the surfaces
 * that draw it (the inbox, the workbench). This harness pins the badge's own
 * deep-link contract, which the shared `Row` must keep honouring.
 *
 * The rest of this file belonged to `pages/ProjectConversations.tsx` — the
 * project's Threads tab. That page is no longer routed (`/p/:p/threads` is a
 * replace-redirect and the tab row is gone with the old project frame); its
 * surviving behaviours are ported to the replacement in
 * `pages/Chats.ported.test.tsx`, and its frame-only assertions are retired.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);
import { OriginBadge } from "../components/Conversations";
import { Row } from "../components/ds/Row";
import { conversationSummaryFixture } from "../test/fakes";

const RUN_ID = "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c";
const NODE_EXECUTION_ID = "01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d";
const ATTEMPT_ID = "01987b13-4d7d-7a6e-8b42-5f6a7b8c9d0e";

const runLinkedSummary = {
  ...conversationSummaryFixture,
  id: "01987a64-2222-7000-8000-abcdef012346",
  title: "Watch the retry",
  origin: "run" as const,
  run_link: {
    run_id: RUN_ID,
    run_title: "Ship billing",
    node_execution_id: NODE_EXECUTION_ID,
    node_instance_key: "/review",
    node_id: "review",
    attempt_id: ATTEMPT_ID,
    attempt_number: 2,
  },
};

describe("the origin badge still deep-links a run-opened thread", () => {
  it("badges a manual row and deep-links a run-linked row", () => {
    render(
      <MemoryRouter>
        <Row to={`/chats/${runLinkedSummary.id}`} data-testid="conversation-row-badge-harness">
          <OriginBadge conversation={runLinkedSummary} />
        </Row>
      </MemoryRouter>,
    );

    const badge = screen.getByTestId("conversation-origin-run");
    expect(badge.textContent).toContain("From run · Ship billing · review");
    // The badge itself is the workbench deep link: node, instance and
    // attempt. It carries link semantics (role + title) rather than an
    // anchor because the row is itself an anchor.
    expect(badge.getAttribute("role")).toBe("link");
    expect(badge.getAttribute("title")).toBe(
      `/runs/${RUN_ID}?node=review&instance=${NODE_EXECUTION_ID}&attempt=2`,
    );
  });

  it("a pointer click on the badge navigates to the workbench, not the conversation", () => {
    // The row itself is the anchor and the badge lives inside it: a click on
    // the badge must land on the workbench deep link, never on the row's own
    // conversation href. A `useLocation` probe reports where the router is.
    function Where() {
      const location = useLocation();
      return <div data-testid="badge-where">{`${location.pathname}${location.search}`}</div>;
    }
    const workbenchHref = `/runs/${RUN_ID}?node=review&instance=${NODE_EXECUTION_ID}&attempt=2`;
    render(
      <MemoryRouter initialEntries={[`/chats/${runLinkedSummary.id}`]}>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
        <Row to={`/chats/${runLinkedSummary.id}`} data-testid="conversation-row-badge-harness">
          <OriginBadge conversation={runLinkedSummary} />
        </Row>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("badge-where").textContent).not.toContain(workbenchHref);
    // Clicking the badge must prevent the default action — otherwise the row
    // anchor's own conversation href wins the browser navigation in a real
    // browser and only keyboard Enter reaches the workbench.
    expect(fireEvent.click(screen.getByTestId("conversation-origin-run"))).toBe(false);
    const where = screen.getByTestId("badge-where");
    // The click opened the Run Workbench deep link…
    expect(where.textContent).toBe(workbenchHref);
    // …and not the row's own conversation URL.
    expect(where.textContent).not.toContain(`/conversations/${runLinkedSummary.id}`);
  });
});
