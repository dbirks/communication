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
import { ProblemBanner } from "../components/Feedback";

export interface ThreadsViewProps {
  /** Restrict the list to one project (a project's Threads tab); empty means
   *  every project the caller is a member of. */
  projectId?: string;
}

/** The whole screen: list pane + the thread column. Selected thread lives in
 *  the URL (`/threads/:id`), which is what marks a row selected. */
export function ThreadsView({ projectId = "" }: ThreadsViewProps) {
  // The pane reads the same query key, so this is a second pair of eyes on
  // one round trip — the right column needs only the read's state.
  const list = useThreadList(projectId, null);
  return (
    <div
      className="-mx-4 flex min-w-0 flex-col lg:-my-6 lg:flex-row lg:min-h-[calc(100vh-48px)]"
      data-testid="threads-view"
    >
      <div className="w-full shrink-0 border-b border-line-strong lg:w-[320px] lg:border-b-0 lg:border-r">
        <ThreadListPane projectId={projectId} />
      </div>
      <div className="hidden min-w-0 flex-1 flex-col lg:flex" data-testid="threads-detail-column">
        {list.isError ? (
          <div className="max-w-[620px] p-7">
            <ProblemBanner
              error={list.error}
              fallback="The cross-project thread list could not be loaded — newer servers carry it; open threads from a project's Threads tab until then."
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-[380px] space-y-2 text-center" data-testid="threads-no-selection">
              <h2 className="text-title-m font-semibold">No thread selected</h2>
              <p className="text-[12.5px] text-muted">
                Pick a thread on the left to read it here — or start one with New thread.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Threads() {
  return <ThreadsView />;
}
