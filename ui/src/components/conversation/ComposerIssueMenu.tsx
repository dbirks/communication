/**
 * The composer's `#` issue menu (design 2e/1h).
 *
 * Typing `#` in the composer, in a repo-scoped chat whose repository is
 * GitHub-hosted (`isGitHubRepository`, the same guard the handoff surface
 * uses), opens this ds `Menu` over the repository's OPEN issues — the
 * existing `useRepoIssues` read (`ui/src/api/issues.ts`), fetched only while
 * the menu is open (the anonymous GitHub budget is 60 requests per replica
 * IP; a chat merely rendered must not spend it). A non-GitHub repository —
 * or a chat that is not repo-scoped — opens nothing: the `#` is just typed.
 *
 * Picking an issue is reported to the caller, which inserts `#<number> ` at
 * the caret. The menu is honest about every non-list: loading, a refused
 * read (a spent budget, a private repository) and an empty tracker each get
 * their own line — never a fake item.
 */
import type { RefObject } from "react";
import type { GitHubIssueList } from "../../api/issues";
import { Menu, type MenuEntry } from "../ds/Menu";

/** The read state the menu is owed — `useRepoIssues`'s own shape, narrowed. */
export interface ComposerIssueMenuState {
  issues: GitHubIssueList | undefined;
  loading: boolean;
  readFailed: boolean;
  /** What the person typed after the `#` — an issue-number prefix filter. */
  filter: string;
}

/** The menu's items: `#<number> <title>` per open issue, or the honest line. */
export function issueMenuItems(
  state: ComposerIssueMenuState,
  onPick: (number: number) => void,
): MenuEntry[] {
  if (state.loading) {
    return [
      {
        id: "loading",
        label: "Loading open issues from GitHub…",
        onSelect: () => {},
        disabled: true,
      },
    ];
  }
  if (state.readFailed) {
    return [
      {
        id: "failed",
        label: "The open issues could not be read from GitHub.",
        onSelect: () => {},
        disabled: true,
      },
    ];
  }
  const open = state.issues?.items ?? [];
  if (open.length === 0) {
    return [
      {
        id: "none",
        label: "This repository has no open issues on GitHub.",
        onSelect: () => {},
        disabled: true,
      },
    ];
  }
  const needle = state.filter;
  const items = open.filter((issue) => String(issue.number).startsWith(needle));
  if (items.length === 0) {
    return [{ id: "no-match", label: "No issue matches.", onSelect: () => {}, disabled: true }];
  }
  return items.map((issue) => ({
    id: String(issue.number),
    label: `#${issue.number} ${issue.title}`,
    testId: `composer-issue-${issue.number}`,
    onSelect: () => onPick(issue.number),
  }));
}

export interface ComposerIssueMenuProps {
  state: ComposerIssueMenuState;
  open: boolean;
  onClose: () => void;
  /** The composer's textarea anchor — the menu parks above it. */
  triggerRef: RefObject<HTMLElement | null>;
  onPick: (number: number) => void;
}

export function ComposerIssueMenu({
  state,
  open,
  onClose,
  triggerRef,
  onPick,
}: ComposerIssueMenuProps) {
  return (
    <Menu
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      side="top"
      width={320}
      caption="OPEN ISSUES"
      ariaLabel="The repository's open issues on GitHub"
      data-testid="composer-issue-menu"
      items={issueMenuItems(state, onPick)}
    />
  );
}
