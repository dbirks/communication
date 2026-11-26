/**
 * Chats — the two-pane Chats screen (redesign R3).
 *
 * Desktop (>= 768px): 300px ChatList on the left, NewChatPane (when no id or
 * `new`) or ChatThread on the right.
 * Phone (< 768px): ChatList alone at `/chats`, NewChatPane / ChatThread alone at
 * `/chats/:id` with a back arrow (`chat-back`) to the list.
 */
import { useParams } from "react-router";
import { ChatList } from "../components/chats/ChatList";
import { ChatThread } from "../components/chats/ChatThread";
import { NewChatPane } from "../components/chats/NewChatPane";
import { useIsNarrow } from "../components/Shell";
import { useScope } from "../lib/scope";

export default function Chats() {
  const { conversationId, projectId } = useParams<{
    conversationId?: string;
    projectId?: string;
  }>();
  const scopeFromPath = useScope();
  const scope = projectId ?? scopeFromPath;
  const narrow = useIsNarrow();

  const hasId = Boolean(conversationId);
  const isNew = !conversationId || conversationId === "new";
  // Keep a single stable wrapper and child slot order so resizing across 768px
  // never unmounts ChatThread / NewChatPane and drops open sheets or drafts.
  const showList = !narrow || !hasId;
  const showDetail = !narrow || hasId;

  return (
    <div
      data-testid="chats"
      className={
        narrow
          ? "h-full min-h-0 bg-surface"
          : "grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] bg-surface"
      }
    >
      {showList ? <ChatList scope={scope} selectedId={!isNew ? conversationId : ""} /> : null}
      {showDetail ? (
        isNew ? (
          <NewChatPane scope={scope} showBack={narrow} />
        ) : (
          <ChatThread conversationId={conversationId!} scope={scope} showBack={narrow} />
        )
      ) : null}
    </div>
  );
}
