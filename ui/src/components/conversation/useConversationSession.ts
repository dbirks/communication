/**
 * One live ACP conversation with controls — the single session behind both the
 * conversation page and the attempt-side conversation panels.
 *
 * Both callers used to compute the same thing inline (the page in
 * `pages/Conversation.tsx`, the attempt pane in
 * `components/m4/AttemptDetail.tsx`): the conversation read, the SSE journal
 * fold, the controller/role bookkeeping, the prompt state and the take /
 * return / stop / decide / send mutations. This hook moves that logic here
 * unchanged so the shared panel in `AgentConversationPanel.tsx` and the page's
 * rail controls read one source of truth. Callers that need the session more
 * than once (the page renders the controls in its context rail) compute it
 * ONCE and pass it down: `useConversationEvents` owns a real socket, so two
 * sessions for one conversation would open two streams.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useActorNames, mergeLookups, nameLookup, type NameHint } from "../../api/actors";
import { humanIdsIn } from "../../api/names";
import { useConversationEvents, type ConnectionState } from "../../api/events";
import {
  useConversation,
  useCancelConversationTurn,
  useDecideConversationPermission,
  useMe,
  useProject,
  useReturnConversationControl,
  useTakeConversationControl,
  usePostConversationMessage,
} from "../../api/queries";
import { describeTurn, projectTranscript, type Transcript } from "../../api/transcript";
import type {
  Conversation,
  ConversationControl,
  ConversationTurn,
  EventEnvelope,
  PermissionOption,
} from "../../api/types";

export interface ConversationSession {
  /** The conversation read, pending and error states included. */
  conversation: ReturnType<typeof useConversation>;
  data: Conversation | undefined;
  activeTurn: Conversation["active_turn"];
  control: ConversationControl | undefined;
  /** The signed-in user drives this conversation. */
  isController: boolean;
  /** The project role has been read (a viewer may watch but not take control). */
  roleKnown: boolean;
  /** A contributor-or-above can ask for control; a viewer may only watch. */
  canRequestControl: boolean;
  /** Merged actor name lookup (directory + hints from the conversation row). */
  nameOf: (userId: string) => string;
  events: EventEnvelope[];
  /** The SSE stream state ("live" | "reconnecting"). */
  status: ConnectionState;
  /** The journal fold: messages, tool calls, permission prompts, turns. */
  transcript: Transcript;
  /**
   * The turn rows this surface holds — today `active_turn`, the one turn whose
   * `submitted_via` the API reports (ADR-0062). The fold and the turn markers
   * join it by id so an unattended turn is not read as a person's typing.
   */
  turnRows: ConversationTurn[];
  /** One description of the turn: its status, its record, whether it is open. */
  described: ReturnType<typeof describeTurn>;
  /** True while a turn is open — a second prompt into it is refused. */
  turnInProgress: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  onSend: (event: FormEvent) => void;
  onDecide: (requestId: string, option: PermissionOption) => void;
  decidingRequestId: string | null;
  sendMessage: ReturnType<typeof usePostConversationMessage>;
  takeControl: ReturnType<typeof useTakeConversationControl>;
  returnControl: ReturnType<typeof useReturnConversationControl>;
  cancelTurn: ReturnType<typeof useCancelConversationTurn>;
  decide: ReturnType<typeof useDecideConversationPermission>;
}

export function useConversationSession(
  conversationId: string,
  projectId: string,
): ConversationSession {
  const conversation = useConversation(conversationId);
  const me = useMe();
  const { events, status } = useConversationEvents(conversationId);
  const sendMessage = usePostConversationMessage(conversationId);
  const takeControl = useTakeConversationControl(conversationId);
  const returnControl = useReturnConversationControl(conversationId);
  const cancelTurn = useCancelConversationTurn(conversationId);
  const decide = useDecideConversationPermission(conversationId);
  const [prompt, setPrompt] = useState("");
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);

  const data = conversation.data;
  const activeTurn = data?.active_turn;
  const isController = Boolean(
    data && me.data && data.control.kind === "human" && data.control.user_id === me.data.id,
  );
  // Conversation routes do not report the caller's project role, so ask the
  // project (already cached by the page this one was reached from): a viewer may
  // watch but may not take control (`06`, ADR-0016 §8).
  const project = useProject(projectId);
  // While the role is still loading the button renders disabled rather than
  // appearing and vanishing; a viewer never gets an enabled one.
  const roleKnown = project.data !== undefined;
  const canRequestControl = roleKnown ? project.data.my_role !== "viewer" : true;

  // Names come from the shared actor directory (me, users, members) merged with
  // the hints this conversation row holds (creator, controller, the turn's
  // submitter) — those three carry a server-resolved `display_name`, so they
  // need no lookup at all. The last resort is "someone (short-id)", never a
  // bare uuid.
  const localHints = useMemo<NameHint[]>(
    () => [
      ...(data?.created_by_display_name
        ? ([[data.created_by, data.created_by_display_name]] as const)
        : []),
      ...(data?.control.display_name && data.control.user_id
        ? ([[data.control.user_id, data.control.display_name]] as const)
        : []),
      // An automation turn's submitter is named by the turn row itself, which
      // joins `users.display_name` server-side (ADR-0062).
      ...(activeTurn?.submitted_by_display_name
        ? ([[activeTurn.submitted_by, activeTurn.submitted_by_display_name]] as const)
        : []),
    ],
    [data, activeTurn],
  );
  const localNames = useMemo(() => nameLookup(localHints), [localHints]);

  // The ids the row cannot name itself are questions for the directory, and
  // `useActorNames` keeps asking until it can answer them: the journal names
  // people by id only, so a viewer whose directory request was lost mid-restart
  // would otherwise read a colleague as "someone (abc12345)" for the rest of the
  // page's life while a second viewer read their name (ADR-0016 §7 — one
  // journal, one reading of it).
  const actorIds = useMemo(
    () =>
      humanIdsIn(events, [
        data && data.control.kind === "human" ? data.control.user_id : null,
        data?.created_by,
        activeTurn?.submitted_by,
      ]).filter((id) => localNames(id) === null),
    [events, localNames, data, activeTurn],
  );
  const actors = useActorNames(projectId, actorIds);
  const nameOf = useMemo(() => {
    const merged = mergeLookups(localNames, actors.lookup);
    return (userId: string) => merged(userId) ?? actors.nameOf(userId);
  }, [actors, localNames]);

  // The one turn row the conversation read carries. It is the only source of
  // `submitted_via` on the wire, and the fold needs it stable — a fresh array
  // each render would re-project the journal on every keystroke.
  const turnRows = useMemo(() => (activeTurn ? [activeTurn] : []), [activeTurn]);

  // The fold names the people it mentions, so it re-projects when the actor
  // directory lands — an id in a sentence nobody can act on is not information.
  const transcript = useMemo(
    () => projectTranscript(events, nameOf, turnRows),
    [events, nameOf, turnRows],
  );

  // `active` is set only while nobody has proved the turn is over: a terminal
  // journal record clears it immediately (the DB would refuse a competing
  // prompt anyway — one active turn per conversation, migration 00003).
  const described = describeTurn(transcript.turns, activeTurn);
  const turnInProgress = Boolean(described.active);

  const onSend = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;
    sendMessage.mutate(
      { prompt: trimmed },
      { onSuccess: () => setPrompt("") }, // the reply arrives on the stream, not here
    );
  };

  const onDecide = (requestId: string, option: PermissionOption) => {
    setDecidingRequestId(requestId);
    decide.mutate(
      { requestId, body: { option_id: option.option_id } },
      {
        // The transcript card closes when `conversation.permission.decided`
        // arrives; keeping the id lets a failure name the prompt it belongs to.
        onSuccess: () => setDecidingRequestId(null),
        onError: () => setDecidingRequestId(null),
      },
    );
  };

  return {
    conversation,
    data,
    activeTurn,
    control: data?.control,
    isController,
    roleKnown,
    canRequestControl,
    nameOf,
    events,
    status,
    transcript,
    turnRows,
    described,
    turnInProgress,
    prompt,
    setPrompt,
    onSend,
    onDecide,
    decidingRequestId,
    sendMessage,
    takeControl,
    returnControl,
    cancelTurn,
    decide,
  };
}
