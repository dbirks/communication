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
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { useActorNames, mergeLookups, nameLookup, type NameHint } from "../../api/actors";
import { humanIdsIn } from "../../api/names";
import { M2_EVENT_TYPES, useEventStream, type ConnectionState } from "../../api/events";
import {
  invalidateConversation,
  queryKeys,
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
import { useAgentProfiles } from "../../api/queries";
import { launcherNameResolver, launcherNameSource } from "./agentNames";
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
  /**
   * ADR-0068: `POST .../switch-agent` — set the agent profile the NEXT turn
   * runs on. Controller only, between turns; a non-controller is `403`, an
   * open turn `409`, and the landed switch journalls the divider row. On
   * success the response (the fresh conversation, `agents` ranges included)
   * replaces the cached read.
   */
  switchAgent: UseMutationResult<Conversation, Error, { agent_profile_id: string }>;
  takeControl: ReturnType<typeof useTakeConversationControl>;
  returnControl: ReturnType<typeof useReturnConversationControl>;
  cancelTurn: ReturnType<typeof useCancelConversationTurn>;
  decide: ReturnType<typeof useDecideConversationPermission>;
}

/**
 * The stream types this session listens to: the shared M2 transcript list
 * plus `conversation.agent.switched` (ADR-0068, main 219faf5). The hook in
 * `api/events.ts` pins its own `M2_EVENT_TYPES`, and an `EventSource`
 * delivers a named type only to a registered listener — so until that
 * whitelist is widened at its own file, a consumer of `useConversationEvents`
 * would never see the divider frame at all. This composes the same stream
 * with the same rules plus the ADR-0068 row; when `api/events.ts` lands the
 * type, this list and `useConversationEvents` can collapse back into one.
 */
const CONVERSATION_STREAM_TYPES: readonly string[] = [
  ...M2_EVENT_TYPES,
  "conversation.agent.switched",
];

/**
 * The types that change the `Conversation` resource itself — the same rule
 * `useConversationEvents` applies (transcript chunks deliberately do not
 * refetch; a frame storm would). `conversation.agent.switched` joins it: it
 * moved the next-turn profile and re-derived the `agents` ranges.
 */
const CONVERSATION_RESOURCE_TYPES = new Set<string>([
  "conversation.created",
  "conversation.control.transferred",
  "conversation.permission.requested",
  "conversation.permission.decided",
  "conversation.turn.started",
  "conversation.turn.completed",
  "conversation.turn.cancelled",
  "conversation.turn.failed",
  "conversation.turn.interrupted",
  "agent.session.connected",
  "agent.session.disconnected",
  "conversation.agent.switched",
  // ADR-0072: asked and answered both rewrite the detail's linked_chats
  // list, and the answered row is what flips a transcript mail card from
  // “asked” to its answer.
  "conversation.mail.asked",
  "conversation.mail.answered",
]);

export function useConversationSession(
  conversationId: string,
  projectId: string,
): ConversationSession {
  const queryClient = useQueryClient();
  const conversation = useConversation(conversationId);
  const me = useMe();
  const { events, status } = useEventStream({
    url: conversationId ? `/api/v1/conversations/${conversationId}/events` : "",
    types: CONVERSATION_STREAM_TYPES,
    keys: [conversationId],
    onEvent: (event) => {
      if (CONVERSATION_RESOURCE_TYPES.has(event.type)) {
        invalidateConversation(
          queryClient,
          event.conversation_id ?? conversationId,
          event.project_id,
        );
      }
    },
  });
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
  //
  // Review 2e: it also names the AGENT. `agent.session.connected` carries the
  // launcher id (`claude`), which is the executable the worker spawns, not the
  // agent the person chose (`Claude Code`). The conversation's own profile row
  // answers that for the live session; the org's profile list (the SAME cached
  // read the composer chip makes, `queryKeys.agentProfiles` — not a second
  // request) answers it for a session on another profile, and only when
  // exactly one row carries that launcher: two profiles on one executable name
  // nothing, and the fold then prints the launcher id it was given rather than
  // guessing which profile ran.
  const agentProfiles = useAgentProfiles();
  const agentNameForEvent = useMemo(() => {
    const resolve = launcherNameResolver(
      launcherNameSource(data, events, agentProfiles.data?.items ?? []),
    );
    return (launcherId: string): string => resolve(launcherId) ?? launcherId ?? "the agent";
  }, [agentProfiles.data, data, events]);
  const transcript = useMemo(
    () => projectTranscript(events, nameOf, turnRows, agentNameForEvent),
    [events, nameOf, turnRows, agentNameForEvent],
  );

  // `active` is set only while nobody has proved the turn is over: a terminal
  // journal record clears it immediately (the DB would refuse a competing
  // prompt anyway — one active turn per conversation, migration 00003).
  const described = describeTurn(transcript.turns, activeTurn);
  const turnInProgress = Boolean(described.active);

  // Design 1g, pass review defect 1: a thread whose turn is open must sit
  // under LIVE in the list pane beside this page too. That pane groups rows
  // off the CROSS-project summary read (ADR-0047, the
  // `["conversations", "cross-project", …]` cache) — the one conversation
  // list `invalidateConversation` (api/events.ts, every SSE frame) does not
  // name: it marks the detail row and the PROJECT's lists stale, never the
  // shell-wide shelf. So the row for the thread opened HERE kept its
  // page-load shape: a prompt sent on this page left the row under EARLIER
  // (status still `idle`, `has_active_turn` still absent) until the pane
  // remounted. The two facts that move that row's shelf are the open turn
  // and the agent's first sentence (LIVE rows print its last line) — when
  // either flips, the pane's shelf is recomputed. The prefix key covers
  // every keyset page of the cross-project read.
  const agentSpoken = transcript.items.some((item) => item.kind === "agent");
  useEffect(() => {
    if (!conversationId) return;
    void queryClient.invalidateQueries({ queryKey: ["conversations", "cross-project"] });
  }, [conversationId, turnInProgress, agentSpoken, queryClient]);

  const switchAgent = useMutation<Conversation, Error, { agent_profile_id: string }>({
    mutationFn: (body) =>
      apiFetch<Conversation>(`/api/v1/conversations/${conversationId}/switch-agent`, {
        method: "POST",
        json: body,
      }),
    onSuccess: (fresh) => {
      // The response IS the fresh conversation view (ADR-0068 § 2); writing
      // it into the cache updates the chip and the side panel's agent ranges
      // without a second read. The divider itself arrives on the stream — the
      // journal row is its only source.
      queryClient.setQueryData(queryKeys.conversation(conversationId), fresh);
    },
  });

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
    switchAgent,
    takeControl,
    returnControl,
    cancelTurn,
    decide,
  };
}
