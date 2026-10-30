/**
 * Threads (routes `/threads`, design 1g) — the 320px list pane beside the
 * thread that is open. The list lives in `components/threads/ThreadListPane`
 * and the same pane stands next to an open thread at `/threads/:id` (the
 * Conversation page mounts it), so moving between threads never leaves the
 * page. A project's Threads tab can mount `ThreadsView` with `projectId` set
 * later; nothing here is wired to it yet.
 *
 * What the right column holds at `/threads` itself: the honest "no thread
 * selected" prompt, or the read's refusal when the cross-project list is
 * unavailable (a server without the ADR-0047 endpoint) — the pane's quiet
 * line plus this banner, said once where the reader looks.
 *
 * Honesty: no design value is faked — the list endpoint carries neither the
 * repository of a row nor the agent's last line, so the rows say what the
 * wire says (see the pane's header comment for the exact gap).
 */
import { ThreadListPane, useThreadList } from "../components/threads/ThreadListPane";

export interface ThreadsViewProps {
  /** Restrict the list to one project (a project's Threads tab); empty means
   *  every project the caller is a member of. */
  projectId?: string;
}

/**
 * The whole screen: list pane + the thread column. Selected thread lives in
 * the URL (`/threads/:id`), which is what marks a row selected. The routes
 * are full-bleed (App's predicate), so the screen owns the content column's
 * full height: the 320px list scrolls itself, the open thread (or this
 * page's prompt) fills the rest, and the document never scrolls.
 *
 * Below `lg` there is no room for two panes, and the phone's path to a thread
 * is tapping a row (which navigates to `/threads/:id`, where the thread takes
 * the whole screen — see the Conversation pane). So below `lg` this page shows
 * ONLY the list: the empty "No thread selected" column is desktop-only content
 * whose phone path is opening a thread, and drawing it under the list just left
 * a blank pane (pass-2 review, 390). It is the same master-detail collapse the
 * emulator already allowlists for `thread-list-pane`; the reflow allowlist needs
 * a matching entry for `threads-detail-column` so the empty prompt (present at
 * 1280, collapsed at 390) is not reported as lost content.
 * On a server failure the list column itself carries the single loud banner
 * (`ThreadListPane ownsError`) so the error still reaches the phone; the thread
 * column does not repeat it (review: the failure was shown twice).
 */
export function ThreadsView({ projectId = "" }: ThreadsViewProps) {
  // The pane reads the same query key, so this is a second pair of eyes on
  // one round trip — the thread column needs only the read's state to stay
  // quiet while the read failed (the pane is the single loud banner).
  const list = useThreadList(projectId, null);
  return (
    <div
      className="flex h-[calc(100vh-44px)] min-w-0 flex-col overflow-hidden md:h-screen lg:flex-row"
      data-testid="threads-view"
    >
      <div className="flex min-h-0 w-full flex-1 border-b border-line-strong bg-surface lg:w-[320px] lg:flex-none lg:border-b-0 lg:border-r">
        <ThreadListPane projectId={projectId} ownsError={list.isError} />
      </div>
      {list.isError ? null : (
        <div
          className="hidden min-h-0 min-w-0 flex-1 flex-col bg-paper lg:flex"
          data-testid="threads-detail-column"
        >
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-[380px] space-y-2 text-center" data-testid="threads-no-selection">
              <h2 className="text-title-m font-semibold">No thread selected</h2>
              <p className="text-[12.5px] text-muted">
                Pick a thread on the left to read it here — or start one with New thread.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Threads() {
  return <ThreadsView />;
}
