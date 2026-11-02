/**
 * Threads (routes `/threads`, design 1g) — the 320px list pane beside the
 * thread that is open. The list lives in `components/threads/ThreadListPane`
 * and the same pane stands next to an open thread at `/threads/:id` (the
 * Conversation page mounts it), so moving between threads never leaves the
 * page. A project's Threads tab can mount `ThreadsView` with `projectId` set
 * later; nothing here is wired to it yet.
 *
 * What the right column holds at `/threads` itself: the honest "no thread
 * selected" prompt while there are rows to pick, and NOTHING but empty paper
 * while the cross-project read has failed — the refusal (a server without the
 * ADR-0047 endpoint, or any failed read) is said once, in the list column that
 * failed, and this column must not invite a pick that cannot be made.
 *
 * Honesty: no design value is faked — the list endpoint carries neither the
 * repository of a row nor the agent's last line, so the rows say what the
 * wire says (see the pane's header comment for the exact gap).
 */
import { Suspense, lazy } from "react";
import { useParams } from "react-router";
import { useConversation } from "../api/queries";
import { Spinner } from "../components/Feedback";
import { ThreadListPane, useThreadList } from "../components/threads/ThreadListPane";

/**
 * The open thread lives in its own chunk (shared with `App.tsx`'s
 * project-scoped conversation route — same module, so same chunk). gh-69:
 * the chunk starts loading when THIS module evaluates — arriving on `/threads`
 * or the project's Threads tab already has it in hand — instead of waiting
 * for the conversation read to resolve before the import was even issued
 * (the old deep-link gate stacked a data waterfall on a chunk waterfall, and
 * every spinner in between replaced the already-painted screen).
 */
const loadConversationPage = () => import("./Conversation");
const ConversationPage = lazy(loadConversationPage);
void loadConversationPage();

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
 * column does not repeat it (review: the failure was shown twice) and does not
 * invite picking a thread either — with no rows to pick, "Pick a thread on the
 * left" contradicted the banner beside it (independent review, 1g
 * server-error at 1280). The column stays drawn as empty paper (the layout
 * stands, per pass review 1g defect 5) but says nothing while the read failed.
 */
export interface ThreadsDetailColumnProps {
  /** The list read failed: there is nothing to pick, so the column keeps its
   *  paper and height but holds no prompt (the refusal is the ONE loud banner
   *  in the list column). */
  listError?: boolean;
}

/**
 * The right-hand thread column of the 1g layout, at rest: the honest "no
 * thread selected" prompt. `/threads` draws it beside its own list, and a
 * project's Threads tab (design 1b) draws the SAME column beside the SAME
 * pane filtered to the project — it is the identical at-rest state of the
 * open-thread column, so it lives here once. The host hides the column only
 * below `lg`, where the phone's path to a thread is tapping a row. While the
 * list read is in its error state the column is passed `listError` and holds
 * NOTHING: the pane on the left is showing a refusal and a Retry, so inviting
 * the reader to pick a row there would be a lie (independent review, 1g
 * server-error at 1280). The empty paper column still stands — the layout
 * never collapses to a blank screen (pass review 1g defect 5) — and the one
 * loud refusal stays in the list column.
 */
export function ThreadsDetailColumn({ listError = false }: ThreadsDetailColumnProps) {
  return (
    <div
      className="hidden min-h-0 min-w-0 flex-1 flex-col bg-paper lg:flex"
      data-testid="threads-detail-column"
    >
      <div className="flex flex-1 items-center justify-center p-8">
        {listError ? null : (
          <div className="max-w-[380px] space-y-2 text-center" data-testid="threads-no-selection">
            <h2 className="text-title-m font-semibold">No thread selected</h2>
            <p className="text-[12.5px] text-muted">
              Pick a thread on the left to read it here — or start one with New thread.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

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
      <ThreadsDetailColumn listError={list.isError} />
    </div>
  );
}

/**
 * The stable loading frame (gh-69). The old deep-link route answered a cold
 * conversation read with a bare one-line `Spinner`, which REPLACED the whole
 * painted screen — the 320px list pane gone, the two-column height collapsed
 * to one line, the page flashing as the thread landed. This frame is the
 * exact `ThreadsView` silhouette: the list pane mounts in its column (same
 * query key as the list page, so it paints from cache with no round trip) and
 * the thread column holds the announced spinner at the column's own size.
 * The reader sees one steady layout from the click to the thread.
 */
export function ThreadScreenLoading({ conversationId }: { conversationId: string }) {
  return (
    <div
      className="flex h-[calc(100vh-44px)] min-w-0 flex-col overflow-hidden md:h-screen lg:flex-row"
      data-testid="threads-view"
    >
      <div className="flex min-h-0 w-full flex-1 border-b border-line-strong bg-surface lg:w-[320px] lg:flex-none lg:border-b-0 lg:border-r">
        <ThreadListPane selectedId={conversationId} />
      </div>
      <div
        className="hidden min-h-0 min-w-0 flex-1 flex-col bg-paper lg:flex"
        data-testid="threads-detail-column"
      >
        <div className="flex flex-1 items-center justify-center p-8">
          <Spinner label="Loading conversation" />
        </div>
      </div>
    </div>
  );
}

/**
 * One screen for `/threads` and `/threads/:conversationId` (the route is a
 * single optional-param path — gh-69). No id: the list beside the honest
 * at-rest column. An id: the thread, with the read's state deciding what the
 * thread column holds — `useConversation` keeps the previous thread as
 * placeholder data, so switching between opened threads paints the previous
 * content until the next arrives; only a truly cold open (no previous answer)
 * shows the same-size frame, and the Suspense fallback for the chunk is that
 * frame too, so no fallback ever redraws a smaller layout over a painted one.
 */
export function ThreadScreen() {
  const { conversationId = "" } = useParams();
  const conversation = useConversation(conversationId);
  if (conversationId.length === 0) return <ThreadsView />;
  if (conversation.isPending) {
    return <ThreadScreenLoading conversationId={conversationId} />;
  }
  return (
    <Suspense fallback={<ThreadScreenLoading conversationId={conversationId} />}>
      <ConversationPage projectId={conversation.data?.project_id ?? ""} />
    </Suspense>
  );
}

export default function Threads() {
  return <ThreadScreen />;
}
