import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import MessageList, { type MessageListProps } from "./MessageList";
import { mapAssistantMessage } from "../../api/assistant";
import type { AssistantSystemStatus } from "../../api/assistant";
import type { AssistantMessage } from "./types";
import { queryKeys } from "../../api/queries";
import type { Draft } from "../../api/types";
import { mockFetch } from "../../test/fakes";

afterEach(() => {
  cleanup();
});

const userMessage = (text: string): AssistantMessage => ({
  id: "m-user",
  kind: "user",
  payload: { kind: "user", text },
  created_at: "2026-10-20T10:00:00Z",
});

const assistantMessage = (): AssistantMessage => ({
  id: "m-a",
  kind: "assistant",
  payload: {
    kind: "assistant",
    turn_id: "01K1",
    answer_markdown: "Claude Code · work is used by `3` nodes.\n\nTwo are running.",
    links: [
      { label: "Feature Delivery · run 4f2a", route: "/p/01J/runs/4f2a" },
      { label: "Process Ready Issues · idle", route: "/p/01J/runs" },
    ],
    tool_calls: [
      { name: "run.nodes", summary: "listed 4 nodes on run 4f2a", ok: true },
      { name: "palette.search", summary: "matched 2 runs", ok: true },
    ],
  },
  created_at: "2026-10-20T10:00:05Z",
});

const questionMessage = (): AssistantMessage => ({
  id: "m-q",
  kind: "question",
  payload: {
    kind: "question",
    prompt: "Stricter how? Pick one.",
    options: [
      { label: "Fail review on any auth finding", value: "fail_any" },
      { label: "Add an OWASP checklist", value: "owasp" },
    ],
    allow_free_text: true,
    answered_by: null,
  },
  created_at: "2026-10-20T10:00:10Z",
});

const changeMessage = (): AssistantMessage => ({
  id: "m-c",
  kind: "change",
  payload: {
    kind: "change",
    change_id: "chg-1",
    change_kind: "draft_edit",
    target_ref: "draft:01K1",
    summary: "Inserted node `review` after `tests`",
    undoable: true,
  },
  created_at: "2026-10-20T10:00:12Z",
});

const approvalMessage = (): AssistantMessage => ({
  id: "m-ap",
  kind: "approval_request",
  payload: {
    kind: "approval_request",
    action: "run.retry",
    summary: "Retry node `test` on run 9c1e (attempt 2)",
    state: "pending",
  },
  created_at: "2026-10-20T10:00:15Z",
});

describe("MessageList", () => {
  it("renders the user bubble with its text and the assistant prose with code spans", () => {
    render(
      <MessageList
        messages={[userMessage("hi"), assistantMessage()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const bubble = screen.getByTestId("assistant-msg-user");
    expect(bubble.textContent).toBe("hi");
    const answer = screen.getByTestId("assistant-answer");
    expect(answer.textContent).toContain("Claude Code · work is used by 3 nodes.");
    // `3` is rendered as a mono code span, not HTML
    const code = answer.querySelector("code");
    expect(code?.textContent).toBe("3");
  });

  it("renders one `Go` + chevron row per link and navigates on click", () => {
    const onGo = vi.fn();
    render(
      <MessageList
        messages={[assistantMessage()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={onGo}
      />,
    );
    const links = screen.getAllByTestId("assistant-link");
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toContain("Feature Delivery · run 4f2a");
    expect(links[0].textContent).toContain("Go");
    expect(links[0].querySelector("svg")?.getAttribute("class")).toContain(
      "tabler-icon-chevron-right",
    );
    fireEvent.click(links[0]);
    expect(onGo).toHaveBeenCalledWith("/p/01J/runs/4f2a");
    fireEvent.click(links[1]);
    expect(onGo).toHaveBeenCalledWith("/p/01J/runs");
  });

  it("collapses the tool calls behind `used <tool>, <tool>` + chevron (A4 §4)", () => {
    render(
      <MessageList
        messages={[assistantMessage()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const details = screen.getByTestId("assistant-tools") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // The folded line NAMES the tools; a count is not what the design shows.
    expect(details.querySelector("summary")?.textContent).toBe("used run.nodes, palette.search");
    expect(details.textContent).not.toContain("used 2 tools");
    expect(details.querySelector("svg")?.getAttribute("class")).toContain(
      "tabler-icon-chevron-right",
    );
    // Review §5: the design's line is a TOP RULE with the chevron FIRST
    // (`› used repo.check, credential.list +1`), the same row
    // `SetupChecklist` draws — not a trailing chevron with no rule.
    const summary = details.querySelector("summary") as HTMLElement;
    expect(summary.className).toContain("border-t");
    expect(summary.className).toContain("border-line");
    expect(summary.className).toContain("pt-[4px]");
    expect(summary.firstElementChild?.getAttribute("class")).toContain("tabler-icon-chevron-right");
    expect(summary.lastElementChild?.textContent).toBe("used run.nodes, palette.search");
    details.open = true;
    expect(details.textContent).toContain("run.nodes");
    expect(details.textContent).toContain("palette.search");
  });

  it("routes question, approval and change rows to their cards / the chip", () => {
    const onAnswerQuestion = vi.fn();
    const onConfirmApproval = vi.fn();
    const onDismissApproval = vi.fn();
    render(
      <MessageList
        messages={[questionMessage(), approvalMessage(), changeMessage()]}
        onAnswerQuestion={onAnswerQuestion}
        onConfirmApproval={onConfirmApproval}
        onDismissApproval={onDismissApproval}
        onGo={() => {}}
      />,
    );
    // question card
    expect(screen.getByTestId("assistant-question")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("assistant-question-option")[1]);
    expect(onAnswerQuestion).toHaveBeenCalledWith("Add an OWASP checklist");
    // approval card, with the transcript row's id
    fireEvent.click(screen.getByTestId("assistant-approval-confirm"));
    expect(onConfirmApproval).toHaveBeenCalledWith("m-ap");
    fireEvent.click(screen.getByTestId("assistant-approval-dismiss"));
    expect(onDismissApproval).toHaveBeenCalledWith("m-ap");
    // change rows render in the chip, not the transcript
    const list = screen.getByTestId("assistant-messages");
    expect(list.querySelector('[data-testid="assistant-msg-change"]')).toBeNull();
    expect(screen.queryAllByTestId("assistant-question-option").length).toBeGreaterThan(0);
  });

  it("numbers the question cards from the transcript and inks the tapped answer (2f)", () => {
    const second = (): AssistantMessage => ({
      ...questionMessage(),
      id: "m-q2",
      payload: {
        ...questionMessage().payload,
        prompt: "What starts it?",
      } as AssistantMessage["payload"],
    });
    const reply = (): AssistantMessage => ({
      id: "m-reply",
      kind: "user",
      payload: { kind: "user", text: "Add an OWASP checklist" },
      created_at: "2026-10-20T10:01:00Z",
    });
    const answeredFirst = (): AssistantMessage => ({
      ...questionMessage(),
      payload: {
        ...questionMessage().payload,
        answered_by: "m-reply",
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[answeredFirst(), second(), reply()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const headers = screen.getAllByTestId("assistant-question-header");
    // The index the transcript proves; the total the one-question-per-turn
    // flow cannot know, so it is not printed (rcn-2f round 7).
    expect(headers.map((h) => h.textContent)).toEqual(["Question 1", "Question 2"]);
    const options = screen.getAllByTestId("assistant-question-option");
    // first card: the reply quoted its second option verbatim → inked
    const chosen = options.find((o) => o.getAttribute("data-selected") === "true");
    expect(chosen?.textContent).toBe("Add an OWASP checklist");
    // the unanswered card still offers its options
    expect(options.some((o) => !o.hasAttribute("disabled"))).toBe(true);
  });

  it("reads the answer as markdown — bold is bold, not asterisks (review 2f)", () => {
    const answer = (text: string): AssistantMessage => ({
      ...assistantMessage(),
      payload: {
        ...assistantMessage().payload,
        answer_markdown: text,
        links: [],
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[answer("Drafting **EMU-RCN reply → OK** in `web` for **alice**.")]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const prose = screen.getByTestId("assistant-answer");
    // Review 2f: the draft's `**EMU-RCN reply → OK**` reached the person as
    // markup. The emphasis renders, the markers do not.
    expect([...prose.querySelectorAll("strong")].map((s) => s.textContent)).toEqual([
      "EMU-RCN reply → OK",
      "alice",
    ]);
    expect(prose.textContent).not.toContain("**");
    expect(prose.querySelector("code")?.textContent).toBe("web");
  });

  /**
   * a11y (axe `link-in-text-block`, lab acceptance 42547338029): an inline
   * link inside the answer's running text must carry a non-colour cue. The
   * app's convention is an underline: the base rule draws it for links
   * inside `<p>`, and the answer's root carries `[&_a]:underline` so links
   * in blocks the paragraph rule cannot reach — a markdown LIST item — get
   * the same cue. A colour-only link (accent on ink, 1.43:1 against the
   * words around it) fails the gate for the whole screen.
   */
  it("underlines inline links in the answer — in a paragraph and in a list item", () => {
    const message: AssistantMessage = {
      ...assistantMessage(),
      payload: {
        ...assistantMessage().payload,
        answer_markdown:
          "See [M4 Exit](https://lab.test/p/01J) for the board.\n\n- Waiting: [the run](https://lab.test/p/01J/runs/4f2a) on its gate",
        links: [],
      } as AssistantMessage["payload"],
    };
    render(
      <MessageList
        messages={[message]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const prose = screen.getByTestId("assistant-answer");
    const paragraphLink = prose.querySelector("[data-testid='markdown-paragraph'] a");
    const listLink = prose.querySelector("[data-testid='markdown-list'] a");
    expect(paragraphLink?.getAttribute("href")).toBe("https://lab.test/p/01J");
    expect(listLink?.getAttribute("href")).toBe("https://lab.test/p/01J/runs/4f2a");
    // The underline class rides the answer's root, so every link under it —
    // paragraph or list — is cued, and the offset matches the app's inline
    // links (QuestionCard's convention).
    expect(prose.className).toContain("[&_a]:underline");
    expect(prose.className).toContain("[&_a]:underline-offset-2");
  });

  it("renders a draft step list with its progress glyphs (2f)", () => {
    const steps = (): AssistantMessage => ({
      id: "m-steps",
      kind: "assistant",
      payload: {
        kind: "assistant",
        answer_markdown:
          "I read the chat. Drafting Adapter swap → PR in the library:\n\n" +
          "✓ Plan — Claude Code · opus\n✓ Approval — maintainer\n● Review — Codex · skill review\n· Open draft PR",
        links: [{ label: "Open draft", route: "/workflows/pl-9" }],
        tool_calls: [],
      },
      created_at: "2026-10-20T10:00:05Z",
    });
    const onGo = vi.fn();
    render(
      <MessageList
        messages={[steps()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={onGo}
      />,
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(4);
    expect(rows[0].getAttribute("data-state")).toBe("done");
    expect(rows[2].getAttribute("data-state")).toBe("current");
    expect(rows[3].getAttribute("data-state")).toBe("later");
    // Handoff §1: the mark is a Tabler icon per state, not a ✓ / ● / · glyph.
    expect(rows.map((row) => row.querySelector("svg")?.getAttribute("class"))).toEqual([
      expect.stringContaining("tabler-icon-check"),
      expect.stringContaining("tabler-icon-check"),
      expect.stringContaining("tabler-icon-point-filled"),
      expect.stringContaining("tabler-icon-point"),
    ]);
    // 2f draws the step word on the left and WHO runs it in machine type at
    // the row's end, so the row is two members, not one sentence: the dash
    // the server's rule puts between them is a delimiter, not text (rcn-2f
    // review item 2 — the profile used to ride inside the prose).
    expect(within(rows[0]).getByTestId("assistant-step-name").textContent).toBe("Plan");
    expect(within(rows[0]).getByTestId("assistant-step-profile").textContent).toBe(
      "Claude Code · opus",
    );
    // A step the draft names no owner for prints alone: inventing one would
    // claim a fact no read gave.
    expect(within(rows[3]).queryByTestId("assistant-step-profile")).toBeNull();
    // the saved draft's `Open draft` link navigates through the caller
    fireEvent.click(screen.getByTestId("assistant-link"));
    expect(onGo).toHaveBeenCalledWith("/workflows/pl-9");
  });

  it("keeps a step list whole when its intro rides the same paragraph (2f)", () => {
    const answer = (text: string): AssistantMessage => ({
      ...assistantMessage(),
      payload: {
        ...assistantMessage().payload,
        answer_markdown: text,
        links: [],
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[
          answer(
            "I read the chat. Drafting Adapter swap → PR in the library:\n" +
              "- ✓ Plan — Claude Code\n" +
              "- ● Review — Codex · gpt-5\n" +
              "- · Open draft PR",
          ),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    // The bullet-marked lines are still the draft step list…
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(3);
    expect(rows[1].getAttribute("data-state")).toBe("current");
    expect(within(rows[0]).getByTestId("assistant-step-name").textContent).toBe("Plan");
    expect(within(rows[0]).getByTestId("assistant-step-profile").textContent).toBe("Claude Code");
    // …and the intro line stays its own prose paragraph.
    expect(screen.getByTestId("assistant-answer").textContent).toContain(
      "I read the chat. Drafting Adapter swap",
    );
  });

  /**
   * rcn-2f round 7: the lab's step list reached the transcript with blank
   * lines between its rows — one line per paragraph — and the old
   * paragraph-bound rule fell back to a block of stray ✓ prose. The rows are
   * the draft's step list as the assistant posted them: blank lines between
   * them are the model's spacing, not a list boundary.
   */
  it("keeps a step list whole across the blank lines between its rows (rcn-2f round 7)", () => {
    const answer = (text: string): AssistantMessage => ({
      ...assistantMessage(),
      payload: {
        ...assistantMessage().payload,
        answer_markdown: text,
        links: [],
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[
          answer(
            "I read the chat. Drafting Adapter swap → PR in the library:\n\n" +
              "✓ Plan — Claude Code · opus\n\n" +
              "✓ Implement — Codex · gpt-5\n\n" +
              "● Review — Codex · skill review\n\n" +
              "· Open draft PR — Codex · gpt-5",
          ),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    // One list, four rows, in the order posted — not four prose lines.
    const lists = screen.getAllByTestId("assistant-step-list");
    expect(lists).toHaveLength(1);
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "current",
      "later",
    ]);
    expect(within(rows[0]).getByTestId("assistant-step-name").textContent).toBe("Plan");
    expect(within(rows[2]).getByTestId("assistant-step-profile").textContent).toBe(
      "Codex · skill review",
    );
    // The intro stays its own prose paragraph.
    expect(screen.getByTestId("assistant-answer").textContent).toContain(
      "I read the chat. Drafting Adapter swap",
    );
  });

  /**
   * rcn-2f review item 2: the profile is a MEMBER of the row, not the tail of
   * its sentence — so splitting the line at the dash is the renderer's whole
   * job, and a step name with a hyphen of its own must survive it.
   */
  it("splits the step from its owner at the dash, not at the first hyphen", () => {
    const answer = (text: string): AssistantMessage => ({
      ...assistantMessage(),
      payload: {
        ...assistantMessage().payload,
        answer_markdown: text,
        links: [],
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[
          answer(
            "✓ Draft-reply — Codex · gpt-5\n● Verify the reply — m4-planner · opus\n· Open the PR",
          ),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(within(rows[0]).getByTestId("assistant-step-name").textContent).toBe("Draft-reply");
    expect(within(rows[0]).getByTestId("assistant-step-profile").textContent).toBe("Codex · gpt-5");
    expect(within(rows[1]).getByTestId("assistant-step-name").textContent).toBe("Verify the reply");
    expect(within(rows[1]).getByTestId("assistant-step-profile").textContent).toBe(
      "m4-planner · opus",
    );
    // An owner-less line still reads as a step; the row simply prints no member.
    expect(within(rows[2]).getByTestId("assistant-step-name").textContent).toBe("Open the PR");
    expect(within(rows[2]).queryByTestId("assistant-step-profile")).toBeNull();
    // Screen readers get the owner as words, not as a floating label.
    expect(rows[0].textContent).toContain("runs on Codex · gpt-5");
  });

  it("leaves a stray ✓ line as prose (a step list needs ≥ 2 marked lines)", () => {
    render(
      <MessageList
        messages={[
          {
            ...assistantMessage(),
            payload: {
              ...assistantMessage().payload,
              answer_markdown: "✓ done.\n\nAll clear.",
            } as AssistantMessage["payload"],
          },
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    expect(screen.queryByTestId("assistant-step-list")).toBeNull();
  });

  // rcn-review10-2f: the live flow answered "Drafting it as a one-step
  // workflow in the library:" with exactly ONE step line — a workflow the
  // chat proved in a single step. That line is the draft's step list, not
  // prose: the drafting intro (ending on the colon that opens the list,
  // naming the draft / library / workflow) is the signal.
  it("renders a ONE-step draft as the step list when a drafting intro precedes it (rcn-review10-2f)", () => {
    render(
      <MessageList
        messages={[
          {
            ...assistantMessage(),
            payload: {
              ...assistantMessage().payload,
              answer_markdown:
                "I read the chat. Drafting it as a one-step workflow in the library:\n\n✓ Reply — m4-planner",
            } as AssistantMessage["payload"],
          },
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const lists = screen.getAllByTestId("assistant-step-list");
    expect(lists).toHaveLength(1);
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByTestId("assistant-step-name").textContent).toBe("Reply");
    expect(within(rows[0]).getByTestId("assistant-step-profile").textContent).toBe("m4-planner");
    // The intro stays prose — only the marked line is the list.
    const answer = screen.getByTestId("assistant-answer");
    expect(answer.textContent).toContain("Drafting it as a one-step workflow in the library:");
  });

  it("keeps the one-step list a list when intro and step share one paragraph (rcn-review10-2f)", () => {
    render(
      <MessageList
        messages={[
          {
            ...assistantMessage(),
            payload: {
              ...assistantMessage().payload,
              answer_markdown: "Drafting Reply in the library:\n✓ Reply — m4-planner",
            } as AssistantMessage["payload"],
          },
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByTestId("assistant-step-name").textContent).toBe("Reply");
  });

  it("still leaves a lone ✓ line as prose unless a drafting intro opened it (rcn-review10-2f)", () => {
    // A colon line that does NOT name the draft / library / workflow, and
    // a drafting mention that does not end on the colon: neither is an
    // intro, so the stray ✓ line stays prose.
    for (const text of [
      "Here is the summary:\n\n✓ Done today",
      "Drafting it as a one-step workflow, as we discussed\n\n✓ Reply — m4-planner",
    ]) {
      const { unmount } = render(
        <MessageList
          messages={[
            {
              ...assistantMessage(),
              payload: {
                ...assistantMessage().payload,
                answer_markdown: text,
              } as AssistantMessage["payload"],
            },
          ]}
          onAnswerQuestion={() => {}}
          onConfirmApproval={() => {}}
          onDismissApproval={() => {}}
          onGo={() => {}}
        />,
      );
      expect(screen.queryByTestId("assistant-step-list")).toBeNull();
      unmount();
    }
  });
});

/**
 * Design 2f round 12: the step list is the SAVED DRAFT's steps, not the
 * model's prose marks. When the answer carries the `Open draft` link, the
 * list renders from the draft's document (fetched through the drafts API);
 * with a question card still open, no ✓ appears anywhere; without a draft
 * link the model's lines stand but their ✓ downgrades to ·.
 */
const DRAFT_DOCUMENT_YAML = `apiVersion: communication.dev/v1alpha1
kind: PipelineDefinition
spec:
  nodes:
    - id: draft_reply
      kind: agent.acp
      config:
        profile: m4-planner
    - id: gate
      kind: human.approval
      dependsOn: [draft_reply]
      config:
        summary: "Approve the reply"
        approverRoles: [maintainer]
    - id: publish
      kind: agent.acp
      dependsOn: [gate]
      config:
        profile: m4-implementer
`;

const savedAnswer = (): AssistantMessage => ({
  id: "m-draft",
  kind: "assistant",
  payload: {
    kind: "assistant",
    answer_markdown:
      "I read the chat. Drafting EMU-RCN reply OK in the library — saved.\n\n" +
      "✓ Reply OK — m4-planner\n✓ Reply OK — m4-implementer\n\n" +
      "The draft currently uses one step; the fork is which profile runs it.",
    links: [{ label: "Open draft", route: "/workflows/01PL/drafts/d-9" }],
    tool_calls: [],
  },
  created_at: "2026-10-20T10:00:05Z",
});

const openQuestionRow = (): AssistantMessage => ({
  id: "m-qq",
  kind: "question",
  payload: {
    kind: "question",
    prompt: "The draft currently uses one step; the fork is which profile runs it?",
    options: [
      { label: "m4-planner", value: "planner" },
      { label: "m4-implementer", value: "implementer" },
    ],
    allow_free_text: true,
    answered_by: null,
  },
  created_at: "2026-10-20T10:00:10Z",
});

function renderWithDraftCache(
  ui: ReactElement,
  draft: { id: string; documentYaml?: string } | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (draft !== null) {
    const documentYaml = draft.documentYaml ?? DRAFT_DOCUMENT_YAML;
    queryClient.setQueryData(queryKeys.draft(draft.id), {
      id: draft.id,
      pipeline_id: "01PL",
      status: "draft",
      document_yaml: documentYaml,
      source_kind: "assistant",
      source_sha256: "sha256:0",
      ui_layout: {},
      digest_scope: "sha256:0",
      revision_digest: null,
      plan_digest: null,
      published_revision_id: null,
      version: 1,
      edited_by: "01J",
      created_at: "2026-10-20T10:00:00Z",
      updated_at: "2026-10-20T10:00:00Z",
    } satisfies Draft);
  }
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

describe("MessageList draft-backed step list (design 2f round 12)", () => {
  it("lists the SAVED DRAFT's steps — never the model's marks — with an open question: the bound node ●, no ✓ anywhere", () => {
    renderWithDraftCache(
      <MessageList
        messages={[savedAnswer(), openQuestionRow()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
      { id: "d-9" },
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    // three nodes from the document — not the model's two "Reply OK" lines
    expect(rows.map((row) => within(row).getByTestId("assistant-step-name").textContent)).toEqual([
      "draft_reply",
      "gate",
      "publish",
    ]);
    expect(
      rows.map((row) => within(row).getByTestId("assistant-step-profile").textContent),
    ).toEqual(["m4-planner", "gate", "m4-implementer"]);
    // the node the open question's options bind is ●; the rest are ·; no ✓
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "current",
      "later",
      "later",
    ]);
    // the model's own step lines are gone; its prose survives — minus the
    // sentence that restates the open question card word for word, which
    // appears once, on the card (rcn-review13-2f)
    expect(screen.queryByText(/Reply OK/)).toBeNull();
    const answer = screen.getByTestId("assistant-answer");
    expect(answer.textContent).toContain("EMU-RCN reply OK in the library — saved.");
    expect(answer.textContent).not.toContain("The draft currently uses one step");
    expect(
      screen.getByText("The draft currently uses one step; the fork is which profile runs it?"),
    ).toBeTruthy();
  });

  it("marks every draft step ✓ when the answer saved the draft and no question is open", () => {
    renderWithDraftCache(
      <MessageList
        messages={[savedAnswer()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
      { id: "d-9" },
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(["done", "done", "done"]);
    expect(screen.queryByText(/Reply OK/)).toBeNull();
  });

  it("without a draft link keeps the model's lines but downgrades ✓ to · while its question is open", () => {
    const answer = (): AssistantMessage => ({
      ...savedAnswer(),
      id: "m-nodraft",
      payload: {
        kind: "assistant",
        answer_markdown:
          "I read the chat. Drafting it in the library:\n\n" +
          "✓ Plan — Claude Code · opus\n● Review — Codex · skill review\n· Open draft PR",
        links: [],
        tool_calls: [],
      } as AssistantMessage["payload"],
    });
    renderWithDraftCache(
      <MessageList
        messages={[answer(), openQuestionRow()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
      null,
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows.map((row) => within(row).getByTestId("assistant-step-name").textContent)).toEqual([
      "Plan",
      "Review",
      "Open draft PR",
    ]);
    // the first line's ✓ is downgraded; the ● the model drew stays ●
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "later",
      "current",
      "later",
    ]);
  });

  it("falls back to the model's lines — downgraded — when the draft read fails", async () => {
    mockFetch([]);
    try {
      renderWithDraftCache(
        <MessageList
          messages={[savedAnswer(), openQuestionRow()]}
          onAnswerQuestion={() => {}}
          onConfirmApproval={() => {}}
          onDismissApproval={() => {}}
          onGo={() => {}}
        />,
        null,
      );
      const rows = await screen.findAllByTestId("assistant-step-row");
      // the draft read 404'd (no stub), so the model's lines stand again —
      // both its ✓ downgraded to · while the question is open
      expect(rows.map((row) => within(row).getByTestId("assistant-step-name").textContent)).toEqual(
        ["Reply OK", "Reply OK"],
      );
      expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(["later", "later"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * rcn-review13-2f: the saved draft is recognised by the link's TARGET —
 * a route pointing at a library draft page — not by the label's wording.
 * The round-13 lab turn shipped the link labelled with a raw path, and the
 * whole 2f state (step list, `Open draft` beside the composer) disappeared
 * because the app keyed on the label. Chips never print a raw path either,
 * and the answer's prose no longer restates the open question card's
 * question.
 */
describe("MessageList round 13: target-based draft recognition, readable chips", () => {
  const DRAFTED_DOC =
    "apiVersion: communication.dev/v1alpha1\n" +
    "kind: PipelineDefinition\n" +
    "metadata:\n" +
    "  name: adapter-swap-to-pr\n" +
    "spec:\n" +
    "  nodes:\n" +
    "    - id: plan\n" +
    "      kind: agent.acp\n" +
    "      config:\n" +
    "        profile: m4-planner\n" +
    "    - id: review\n" +
    "      kind: agent.acp\n" +
    "      dependsOn: [plan]\n" +
    "      config:\n" +
    "        profile: codex-review\n";

  const answerWithLinks = (links: { label: string; route: string }[]): AssistantMessage => ({
    id: "m-r13",
    kind: "assistant",
    payload: {
      kind: "assistant",
      answer_markdown: "Drafted it from the chat and saved it in the library.",
      links,
      tool_calls: [],
    },
    created_at: "2026-10-20T11:00:00Z",
  });

  it("a draft link labelled with a raw path still yields the step list — and the chip reads `Open draft · <name>`, never the path", () => {
    renderWithDraftCache(
      <MessageList
        messages={[
          answerWithLinks([
            { label: "/workflows/pl-9/drafts/d-13", route: "/workflows/pl-9/drafts/d-13" },
          ]),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
      { id: "d-13", documentYaml: DRAFTED_DOC },
    );
    // recognition survived the label: the list is the DRAFT's steps
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows.map((row) => within(row).getByTestId("assistant-step-name").textContent)).toEqual([
      "plan",
      "review",
    ]);
    // the chip carries the readable wording with the draft's own name
    const chip = screen.getByTestId("assistant-link");
    expect(chip.textContent).toContain("Open draft · adapter-swap-to-pr");
    expect(chip.textContent).not.toContain("/");
  });

  it("a differently-worded draft label still recognises the draft by its target", () => {
    renderWithDraftCache(
      <MessageList
        messages={[
          answerWithLinks([{ label: "See the draft", route: "/workflows/pl-9/drafts/d-13" }]),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
      { id: "d-13", documentYaml: DRAFTED_DOC },
    );
    expect(screen.getAllByTestId("assistant-step-row")).toHaveLength(2);
    // the chip says `Open draft` (the name is still loading → no fetch in
    // this stub, so the base label stands) and never the model's words
    expect(screen.getByTestId("assistant-link").textContent).toContain("Open draft");
  });

  it("raw-path chips get a readable label — never a truncated /workflo…", () => {
    render(
      <MessageList
        messages={[
          answerWithLinks([
            { label: "/workflows/pl-9", route: "/workflows/pl-9" },
            { label: "/inbox", route: "/inbox" },
            { label: "", route: "/runs/r-1" },
          ]),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const chips = screen.getAllByTestId("assistant-link").map((chip) => chip.textContent);
    expect(chips[0]).toContain("Workflow pl-9");
    expect(chips[1]).toContain("Today");
    expect(chips[2]).toContain("Run r-1");
    for (const chip of chips) {
      expect(chip).not.toMatch(/\//);
    }
  });

  it("drops the prose sentence that repeats the open question card — whitespace and punctuation blind", () => {
    const answer: AssistantMessage = {
      id: "m-q",
      kind: "assistant",
      payload: {
        kind: "assistant",
        answer_markdown:
          "Saved the draft from the chat.  Should review repeat until clean. The steps are ready.",
        links: [],
        tool_calls: [],
      },
      created_at: "2026-10-20T11:01:00Z",
    };
    const question: AssistantMessage = {
      id: "m-qcard",
      kind: "question",
      payload: {
        kind: "question",
        prompt: "Should   review repeat until clean?",
        options: [
          { label: "Repeat, max 3", value: "repeat" },
          { label: "Run once", value: "once" },
        ],
        answered_by: null,
      },
      created_at: "2026-10-20T11:01:05Z",
    };
    render(
      <MessageList
        messages={[answer, question]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const answerProse = screen.getByTestId("assistant-answer");
    expect(answerProse.textContent).toContain("Saved the draft from the chat.");
    expect(answerProse.textContent).toContain("The steps are ready.");
    // the repeated sentence stands once — on the card, not in the prose
    expect(answerProse.textContent).not.toContain("Should review repeat");
    expect(screen.getByText(/Should\s+review repeat until clean\?/)).toBeTruthy();
  });

  it("leaves prose alone when no question card is open for the answer", () => {
    render(
      <MessageList
        messages={[
          answerWithLinks([]),
          {
            id: "m-user-2",
            kind: "user",
            payload: { kind: "user", text: "nice" },
            created_at: "2026-10-20T11:02:00Z",
          },
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-answer").textContent).toContain(
      "Drafted it from the chat and saved it in the library.",
    );
  });
});

/**
 * Issue #63: the ask lands in the transcript the moment it is sent, as an
 * optimistic local row. While in flight it is a plain user bubble (the
 * caller shows `thinking…`); a failed send KEEPS the bubble and answers it
 * in place — the honest line under the person's own words, with the Retry
 * that re-sends them (named by the row's id).
 */
describe("MessageList optimistic rows (issue #63)", () => {
  const pendingAsk = (): AssistantMessage => ({
    ...userMessage("What needs me right now?"),
    local: { state: "pending" },
  });
  const failedAsk = (): AssistantMessage => ({
    ...userMessage("What needs me right now?"),
    local: {
      state: "failed",
      error: "The assistant could not answer. Your question was not sent — send it again.",
    },
  });

  it("draws an in-flight ask as a plain user bubble — no line, no Retry", () => {
    render(
      <MessageList
        messages={[pendingAsk()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const bubble = screen.getByTestId("assistant-msg-user");
    expect(bubble.textContent).toBe("What needs me right now?");
    expect(screen.queryByTestId("assistant-error")).toBeNull();
    expect(screen.queryByTestId("assistant-send-retry")).toBeNull();
  });

  it("keeps a failed ask's bubble and puts the error line under it with a Retry", () => {
    const onRetrySend = vi.fn();
    render(
      <MessageList
        messages={[failedAsk()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
        onRetrySend={onRetrySend}
      />,
    );
    const bubble = screen.getByTestId("assistant-msg-user");
    // The person's words stay, and the line lives UNDER them — inside the
    // bubble's own row, not floating at the top of the panel.
    expect(bubble.textContent).toContain("What needs me right now?");
    const error = screen.getByTestId("assistant-error");
    expect(bubble.contains(error)).toBe(true);
    expect(bubble.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.textContent).toContain("Your question was not sent — send it again.");
    // The bubble's text comes first, the error after it.
    expect(onRetrySend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("assistant-send-retry"));
    expect(onRetrySend).toHaveBeenCalledWith("m-user");
  });

  it("a server row with no local marker renders exactly as before", () => {
    render(
      <MessageList
        messages={[userMessage("echoed")]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-msg-user").textContent).toBe("echoed");
    expect(screen.queryByTestId("assistant-error")).toBeNull();
  });
});

/**
 * rcn-review17-2f: the answer's links are a group of their own. They used to
 * carry the step list's `●` and print the raw id the model had handled, so
 * they read as more steps of the draft — and one of them (the saved draft) is
 * the same door the panel footer already offers.
 */
describe("MessageList link rows (rcn-review17-2f)", () => {
  const answerWith = (links: { label: string; route: string }[]): AssistantMessage => ({
    id: "m-r17",
    kind: "assistant",
    payload: {
      kind: "assistant",
      answer_markdown:
        "Drafting Chat reply in the library:\n✓ reply — m4-planner\n· confirm — gate",
      links,
      tool_calls: [],
    },
    created_at: "2026-10-20T11:00:00Z",
  });

  const renderLinks = (
    links: { label: string; route: string }[],
    props: { openDraftHref?: string | null } = {},
  ) =>
    renderWithDraftCache(
      <MessageList
        messages={[answerWith(links)]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
        {...props}
      />,
      { id: "d-9", documentYaml: DRAFT_DOCUMENT_YAML },
    );

  it("draws the links under a hairline, with no step glyph on any row", () => {
    renderLinks([
      { label: "Open M4 Exit", route: "/workflows/pl-9" },
      { label: "Agent profiles", route: "/profiles" },
    ]);
    const group = screen.getByTestId("assistant-links");
    const rows = screen.getAllByTestId("assistant-link");
    expect(rows).toHaveLength(2);
    // the step list is still the only place the glyphs are drawn
    expect(screen.getAllByTestId("assistant-step-row").length).toBeGreaterThan(0);
    expect(group.textContent).not.toContain("●");
    expect(group.textContent).not.toContain("✓");
    for (const row of rows) {
      expect(within(row).queryAllByTestId("assistant-step-row")).toHaveLength(0);
      expect(row.textContent).toContain("Go");
    }
    // a rule of its own, so the group does not read as more of the list above
    expect(group.style.borderTop).not.toBe("");
    // and the group is not a step row: no state marker, no profile column
    expect(rows[0].getAttribute("data-state")).toBeNull();
  });

  it("never prints a raw id in a link row", () => {
    renderLinks([{ label: "Open M4 Exit (01a1aa60…)", route: "/workflows/pl-9" }]);
    const row = screen.getByTestId("assistant-link");
    expect(row.textContent).toContain("Open M4 Exit");
    expect(row.textContent).not.toContain("01a1aa60");
  });

  it("hides the saved draft's row while the panel footer offers Open draft for that draft", () => {
    renderLinks(
      [
        { label: "Open M4 Exit", route: "/workflows/pl-9" },
        { label: "Open draft", route: "/workflows/pl-9/drafts/d-9" },
      ],
      { openDraftHref: "/workflows/pl-9/drafts/d-9" },
    );
    const rows = screen.getAllByTestId("assistant-link");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Open M4 Exit")]);
    // the draft is still the draft: its step list stands in the prose
    expect(screen.getByTestId("assistant-step-list")).toBeTruthy();
  });

  it("keeps the draft row when the footer points at another draft, or shows no button", () => {
    const links = [
      { label: "Open draft", route: "/workflows/pl-9/drafts/d-9" },
      { label: "Agent profiles", route: "/profiles" },
    ];
    renderLinks(links, { openDraftHref: "/workflows/pl-9/drafts/d-other" });
    expect(screen.getAllByTestId("assistant-link")).toHaveLength(2);
    cleanup();
    renderLinks(links, { openDraftHref: null });
    const rows = screen.getAllByTestId("assistant-link");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Open draft");
  });
});

/**
 * Handoff A3–A6: the parts the transcript gains — the assumed line under an
 * answer that used the page, the spoken tag on a dictated turn, the judge's
 * verdict on each tool row, and the setup checklist as the empty thread's own
 * message. Each rides the wire payload, so every case here runs the real
 * mapper (`api/assistant.mapAssistantMessage`) rather than a hand-built row.
 */
const wireRow = (
  kind: "user" | "assistant",
  payload: Record<string, unknown>,
): AssistantMessage => {
  const row = mapAssistantMessage({
    id: `m-${kind}`,
    kind,
    payload,
    created_at: "2026-10-20T10:00:00Z",
  });
  if (row === null) throw new Error("the mapper dropped the row under test");
  return row;
};

const answerRow = (payload: Record<string, unknown>): AssistantMessage =>
  wireRow("assistant", {
    kind: "assistant",
    answer_markdown: "Run 9c1e waits on the review gate.",
    links: [],
    tool_calls: [],
    ...payload,
  });

const renderMessages = (messages: AssistantMessage[], extra: Partial<MessageListProps> = {}) =>
  render(
    <MessageList
      messages={messages}
      onAnswerQuestion={() => {}}
      onConfirmApproval={() => {}}
      onDismissApproval={() => {}}
      onGo={() => {}}
      {...extra}
    />,
  );

/** CONTRACT §1's object as a bare server answers it: a chat model and one
 * worker, nothing else set up. */
const SETUP_STATUS = {
  chat_model: { configured: true, model: "qwen3-8-flash-next" },
  speech_model: { configured: false, model: "" },
  decision_model: { configured: false, model: "" },
  workers: { online: 1, sandbox_mode: "required" },
  execution_mode: "inprocess",
  github_credentials: [{ name: "GITHUB_TOKEN", scope: "org", used_by: 0 }],
  projects: { count: 0 },
  workflows: { count: 3, samples: 2, assigned: 0 },
} satisfies AssistantSystemStatus;

describe("MessageList handoff parts (A3–A6)", () => {
  it("prints the assumed item under the answer that used it (A4 §3)", () => {
    renderMessages([answerRow({ assumed: "run 9c1e" })]);
    const line = screen.getByTestId("assistant-assumed");
    expect(line.textContent).toBe("assumed you meant run 9c1e (on screen)");
    // the answer itself stays the answer: the line is under it, not in it
    expect(screen.getByTestId("assistant-answer").textContent).toBe(
      "Run 9c1e waits on the review gate.",
    );
  });

  it("says nothing about an assumption the answer never made", () => {
    renderMessages([answerRow({})]);
    expect(screen.queryByTestId("assistant-assumed")).toBeNull();
  });

  it("tags a dictated turn as spoken, and a typed one as nothing (A6 §5)", () => {
    renderMessages([wireRow("user", { kind: "user", text: "why is it stuck?", spoken: true })]);
    const tag = screen.getByTestId("assistant-spoken");
    expect(tag.textContent).toBe("spoken");
    expect(screen.getByTestId("assistant-msg-user").textContent).toContain("why is it stuck?");
    cleanup();
    renderMessages([wireRow("user", { kind: "user", text: "why is it stuck?" })]);
    expect(screen.queryByTestId("assistant-spoken")).toBeNull();
  });

  it("names each tool the turn used and what the judge made of it (A5 §4)", () => {
    const details = ((): HTMLElement => {
      renderMessages([
        answerRow({
          tool_calls: [
            { name: "workflow.list", summary: "listed 3 workflows", ok: true, judge: "allowed" },
            { name: "run.cancel", summary: "waits for you", ok: false, judge: "asked" },
            { name: "repo.check", summary: "checked the repo", ok: true, judge: "unavailable" },
            { name: "issue.list", summary: "listed 2 issues", ok: true },
          ],
        }),
      ]);
      return screen.getByTestId("assistant-tools");
    })();
    const rows = within(details).getAllByTestId("assistant-tool-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "used workflow.list · judge allowedlisted 3 workflows",
      "used run.cancel · judge askedwaits for you",
      "used repo.check · judge unavailablechecked the repo",
      "used issue.listlisted 2 issues",
    ]);
    // Handoff §1: the ok/failed mark is a Tabler icon, not a ✓/× character.
    expect(rows.map((row) => row.querySelector("svg")?.getAttribute("class"))).toEqual([
      expect.stringContaining("tabler-icon-check"),
      expect.stringContaining("tabler-icon-x"),
      expect.stringContaining("tabler-icon-check"),
      expect.stringContaining("tabler-icon-check"),
    ]);
  });

  it("shows the setup checklist as the empty thread's first message and sends its prompts (A3 §2)", async () => {
    const { requests } = mockFetch([{ path: "/api/v1/assistant/status", body: SETUP_STATUS }]);
    try {
      const onSendPrompt = vi.fn();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <MessageList
            messages={[]}
            onAnswerQuestion={() => {}}
            onConfirmApproval={() => {}}
            onDismissApproval={() => {}}
            onGo={() => {}}
            showSetup
            onSendPrompt={onSendPrompt}
          />
        </QueryClientProvider>,
      );
      expect(await screen.findByTestId("assistant-setup")).toBeTruthy();
      expect(requests.some((request) => request.url === "/api/v1/assistant/status")).toBe(true);
      const action = screen
        .getAllByTestId("assistant-setup-action")
        .find((button) => button.textContent?.startsWith("Add one"));
      expect(action).toBeDefined();
      fireEvent.click(action!);
      expect(onSendPrompt).toHaveBeenCalledWith("help me add my first project");
      fireEvent.click(screen.getAllByTestId("assistant-starter")[2]);
      expect(onSendPrompt).toHaveBeenCalledWith("Is anything stuck here?");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("makes no status request at all once the thread has messages (A3: the checklist is the empty thread's)", async () => {
    const { requests } = mockFetch([{ path: "/api/v1/assistant/status", body: SETUP_STATUS }]);
    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <MessageList
            messages={[answerRow({})]}
            onAnswerQuestion={() => {}}
            onConfirmApproval={() => {}}
            onDismissApproval={() => {}}
            onGo={() => {}}
          />
        </QueryClientProvider>,
      );
      expect(screen.getByTestId("assistant-answer")).toBeTruthy();
      await Promise.resolve();
      expect(requests.map((request) => request.url)).toEqual([]);
      expect(screen.queryByTestId("assistant-setup")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Walk-through findings 7 and 8, on the wire rows the server actually sends:
 * the answer's GFM table renders as a table (not as raw pipes), and the folded
 * disclosure line NAMES the tools the turn used.
 */
describe("the answer's markdown table (walk-through finding 7)", () => {
  const tableAnswer = [
    "Three workflows ship with the install:",
    "",
    "| Workflow | Revision | Assigned |",
    "| --- | --- | --- |",
    "| `feature-delivery` | r7 | no |",
    "| **hotfix** | r2 | 2 projects |",
  ].join("\n");

  it("renders the header row, the body rows and the inline markup inside them", () => {
    renderMessages([answerRow({ answer_markdown: tableAnswer })]);
    const table = screen.getByTestId("assistant-table") as HTMLElement;
    expect(table.querySelector("table")).toBeTruthy();
    const heads = Array.from(table.querySelectorAll("th")).map((th) => th.textContent);
    expect(heads).toEqual(["Workflow", "Revision", "Assigned"]);
    const rows = Array.from(table.querySelectorAll("[data-testid='assistant-table-row']"));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("feature-deliveryr7no");
    // The cell's inline code is a code span, not a pair of backticks.
    expect(rows[0].querySelector("code")?.textContent).toBe("feature-delivery");
    // …and a bold cell is a strong, not two asterisks.
    expect(rows[1].querySelector("strong")?.textContent).toBe("hotfix");
    // The prose around the table is still prose, and the pipes are gone.
    const answer = screen.getByTestId("assistant-answer");
    expect(answer.textContent).toContain("Three workflows ship with the install:");
    expect(answer.textContent).not.toContain("| --- |");
    expect(answer.textContent).not.toContain("| Workflow |");
  });

  it("is the compact table the design draws: 12.5px rows, line rules, mono header, its own scroll", () => {
    renderMessages([answerRow({ answer_markdown: tableAnswer })]);
    const table = screen.getByTestId("assistant-table");
    // Horizontal scroll lives INSIDE the bubble, so a wide table never stretches
    // the transcript column.
    expect(table.className).toContain("overflow-x-auto");
    expect(table.className).toContain("max-w-full");
    const head = table.querySelector("th") as HTMLElement;
    expect(head.className).toContain("font-mono");
    expect(head.className).toContain("text-[10.5px]");
    expect(head.className).toContain("uppercase");
    expect(head.className).toContain("text-faint");
    expect(head.className).toContain("border-line");
    const cell = table.querySelector("td") as HTMLElement;
    expect(cell.className).toContain("border-line");
    expect((table.querySelector("table") as HTMLElement).className).toContain("text-[12.5px]");
  });

  it("leaves a line with one pipe alone — a table needs its separator row", () => {
    renderMessages([answerRow({ answer_markdown: "Run 4f2a | waiting for you" })]);
    expect(screen.queryByTestId("assistant-table")).toBeNull();
    expect(screen.getByTestId("assistant-answer").textContent).toContain(
      "Run 4f2a | waiting for you",
    );
  });
});

/**
 * Handoff A4 §4 / finding 8: `used <tool>` for one call, `used <a>, <b> +N` for
 * several, and the judge's verdict beside the names when one verdict covered
 * the turn. Expanding still lists every call.
 */
describe("the tool disclosure line names the tools (walk-through finding 8)", () => {
  const call = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    summary: `did ${name}`,
    ok: true,
    ...extra,
  });

  it("names the single tool the turn used — no count, no 'tools'", () => {
    renderMessages([answerRow({ tool_calls: [call("system.status")] })]);
    const summary = (screen.getByTestId("assistant-tools") as HTMLElement).querySelector(
      "summary",
    ) as HTMLElement;
    expect(summary.textContent).toBe("used system.status");
    expect(summary.textContent).not.toContain("1 tool");
  });

  it("names the judge's verdict on a turn the decision model let through", () => {
    renderMessages([answerRow({ tool_calls: [call("system.status", { judge: "allowed" })] })]);
    const summary = (screen.getByTestId("assistant-tools") as HTMLElement).querySelector(
      "summary",
    ) as HTMLElement;
    expect(summary.textContent).toBe("used system.status · judge allowed");
  });

  it("lists two tools and counts the rest, with every call still on its own row", () => {
    renderMessages([
      answerRow({
        tool_calls: [
          call("workflow.list"),
          call("credential.list"),
          call("project.list"),
          call("run.list"),
        ],
      }),
    ]);
    const details = screen.getByTestId("assistant-tools") as HTMLElement;
    expect(details.querySelector("summary")?.textContent).toBe(
      "used workflow.list, credential.list +2",
    );
    // Expanding still lists each call — the folded line is a summary, not a
    // replacement for the rows.
    expect(within(details).getAllByTestId("assistant-tool-row")).toHaveLength(4);
  });

  it("names a tool called twice once, and keeps both calls", () => {
    renderMessages([answerRow({ tool_calls: [call("run.list"), call("run.list")] })]);
    const details = screen.getByTestId("assistant-tools") as HTMLElement;
    expect(details.querySelector("summary")?.textContent).toBe("used run.list");
    expect(within(details).getAllByTestId("assistant-tool-row")).toHaveLength(2);
  });
});
