/**
 * The composer's `#` issue menu (design 2e/1h).
 *
 * The menu lists the repository's OPEN issues from the existing
 * `useRepoIssues` read (`ui/src/api/issues.ts`): `#<number> <title>` per
 * issue, picking one reports the number to the caller, which inserts
 * `#<number> ` at the caret. The menu is honest about every state without a
 * list — a pending read, a refused read (a spent GitHub budget, a private
 * repository) and an empty tracker each get their own line, never a fake
 * item. The GitHub-hosted guard itself is proven in
 * `ui/src/api/issues.test.ts`; this menu only ever receives issues the read
 * answered.
 */
import type { RefObject } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssueList } from "../../api/issues";
import { ComposerIssueMenu, issueMenuItems } from "./ComposerIssueMenu";

afterEach(cleanup);

const issue = (number: number, title: string) => ({
  number,
  title,
  body: "",
  labels: [] as string[],
  html_url: `https://github.com/example/backend/issues/${number}`,
  state: "open" as const,
  updated_at: "2026-10-14T18:00:00Z",
  body_truncated: false,
});

const list = (items: GitHubIssueList["items"]): GitHubIssueList => ({
  repository: "example/backend",
  state: "open",
  items,
});

const anchor = (): RefObject<HTMLElement> => ({ current: document.createElement("span") });

describe("issueMenuItems", () => {
  it("lists the open issues as `#<number> <title>`", () => {
    const items = issueMenuItems(
      {
        issues: list([issue(7, "Search pagination"), issue(12, "Mirror timeout")]),
        loading: false,
        readFailed: false,
        filter: "",
      },
      () => {},
    );
    expect(items.map((item) => ("separator" in item ? null : item.label))).toEqual([
      "#7 Search pagination",
      "#12 Mirror timeout",
    ]);
  });

  it("separates the honest states: loading, a refused read, an empty tracker", () => {
    const loading = issueMenuItems(
      { issues: undefined, loading: true, readFailed: false, filter: "" },
      () => {},
    );
    expect(String((loading[0] as { label: unknown }).label)).toContain("Loading");
    const failed = issueMenuItems(
      { issues: undefined, loading: false, readFailed: true, filter: "" },
      () => {},
    );
    expect(String((failed[0] as { label: unknown }).label)).toContain("could not be read");
    const empty = issueMenuItems(
      { issues: list([]), loading: false, readFailed: false, filter: "" },
      () => {},
    );
    expect(String((empty[0] as { label: unknown }).label)).toContain("no open issues");
  });
});

describe("the menu", () => {
  it("shows the issues in the ds menu and reports the picked number", () => {
    const onPick = vi.fn();
    render(
      <ComposerIssueMenu
        state={{
          issues: list([issue(7, "Search pagination"), issue(12, "Mirror timeout")]),
          loading: false,
          readFailed: false,
          filter: "",
        }}
        open
        onClose={() => {}}
        triggerRef={anchor()}
        onPick={onPick}
      />,
    );
    const menu = screen.getByTestId("composer-issue-menu");
    expect(within(menu).getByTestId("composer-issue-7").textContent).toBe("#7 Search pagination");
    fireEvent.click(within(menu).getByTestId("composer-issue-12"));
    expect(onPick).toHaveBeenCalledWith(12);
  });

  it("prints the honest line, not a fake item", () => {
    render(
      <ComposerIssueMenu
        state={{ issues: list([]), loading: false, readFailed: false, filter: "" }}
        open
        onClose={() => {}}
        triggerRef={anchor()}
        onPick={() => {}}
      />,
    );
    const menu = screen.getByTestId("composer-issue-menu");
    expect(menu.textContent).toContain("This repository has no open issues on GitHub.");
    expect(screen.queryByTestId("composer-issue-7")).toBeNull();
  });
});
