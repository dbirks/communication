/**
 * The paper column the project page's *unusable* states sit in.
 *
 * `/p/:projectId` and `/p/:projectId/members` are full-bleed routes (`App.tsx`):
 * the shell gives them the whole content column — no `max-w-5xl`, no `px-4 py-6`
 * — because the design-1b header band must run edge to edge and seat its tabs on
 * its own bottom border. That padding used to be the shell's gift to every page;
 * here the page carries it itself, inside `ProjectHeader`.
 *
 * The loading / not-found / error branches mount no header band, so before this
 * wrapper their single line landed flush against the sidebar at x=240, y=0 — a
 * page that looked like a hole in the shell rather than an answer (verified with
 * a browser shot of a random-UUID `/p/<uuid>`). The wrapper gives those branches
 * the band's own padding — `22px` horizontally and `20px` above, `28px` from `md`
 * up, the handoff's `20px 28px 0` — plus the page's paper background and its
 * full-height column, so a refusal reads as a page.
 *
 * It is deliberately *not* a white band with a bottom border: there is no title
 * row to band, and a border across the viewport with nothing under it is the
 * shell artefact this fixes rather than a design element.
 */
import type { ReactNode } from "react";

/**
 * The header band's padding, in one place: `ProjectHeader`'s band, the members
 * page's band and this column all draw the same inset, and a test asserts they
 * still do. The handoff's page header is `20px 28px 0` (`22px` below `md`).
 */
export const PROJECT_PAGE_PAD = "px-[22px] pt-[20px] md:px-[28px]";

export interface ProjectPageShellProps {
  /** Test handle, so a test can tell the page's unusable branches apart. */
  testid: string;
  children: ReactNode;
}

export function ProjectPageShell({ testid, children }: ProjectPageShellProps) {
  return (
    <div className="flex min-h-full flex-col bg-paper" data-testid={testid}>
      <div className={`${PROJECT_PAGE_PAD} pb-[22px]`}>{children}</div>
    </div>
  );
}
