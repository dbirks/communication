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

  if (narrow) {
    return (
      <div data-testid="chats" className="h-full min-h-0 bg-surface">
        {!hasId ? (
          <ChatList scope={scope} />
        ) : isNew ? (
          <NewChatPane scope={scope} showBack />
        ) : (
          <ChatThread conversationId={conversationId!} scope={scope} showBack />
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="chats"
      className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] bg-surface"
    >
      <ChatList scope={scope} selectedId={!isNew ? conversationId : ""} />
      {isNew ? (
        <NewChatPane scope={scope} />
      ) : (
        <ChatThread conversationId={conversationId!} scope={scope} />
      )}
    </div>
  );
}
