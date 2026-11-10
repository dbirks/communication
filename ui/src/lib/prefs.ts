/**
 * Preferences client (contract C2 of the app-shell handoff).
 *
 * One endpoint, per principal: `GET/PATCH /api/v1/me/preferences`. The wire
 * document is snake_case; the hooks expose camelCase. The server may not have
 * the endpoint yet (it is written in parallel): a `404` on the GET means the
 * hook degrades to `saved: false`, keeps defaults, and holds optimistic
 * changes in the query cache for the rest of the session.
 *
 * The values are display preferences: they authorize nothing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client";

export type TrustLevel = "ask_all" | "ask_risky" | "no_ask";

/**
 * The `expanded` key that carries the sidebar's collapsed (rail) state.
 *
 * The flag rides the free-form `expanded` map rather than a new `layout`
 * member because the server's layout section is a closed object — unknown
 * members are refused by the decoder with a 400 (`internal/api/preferences.go`)
 * — and adding a member to the public preferences shape is an API change that
 * needs its own ADR. `expanded` is documented as an open key/value map (the
 * tree already stores `project:<id>` and `library:workflows` there), so the
 * rail's state persists today with no wire change. `sidebarCollapsed` is the
 * camelCase name callers use; this key is the wire detail under it.
 */
export const SIDEBAR_COLLAPSED_KEY = "sidebar:collapsed";

/**
 * Display preferences for the app shell's layout (contract C2).
 *
 * Redesign finding 10 cut three of the four settings this section used to
 * carry (`projectsMode`, `askPlacement`, `showWorkflowFolders`): each one was a
 * second sidebar layout to build and test, and the 08/10 decisions fixed the
 * answers — projects are always the tree, Ask is always the floating ⌘J button,
 * workflow folders are a filter on the Workflows page. Only the collapse
 * survives, so the sidebar has two layouts instead of sixteen.
 *
 * The server's `layout` section still stores the three removed fields (its
 * schema is unchanged — that would be an API change needing an ADR). A stored
 * document that still carries them is READ AND IGNORED: `parseLayout` names
 * only what the client uses, so an old row costs nothing. Writes send the
 * fields the client actually owns, and the server's stored values for the
 * others stay untouched (absent patch members mean "unchanged").
 */
export interface LayoutPrefs {
  /** `true` = the 52px rail instead of the 220px column (handoff 2c/3c).
   * The default is the expanded column. */
  sidebarCollapsed: boolean;
  expanded: Record<string, boolean>;
}

export const TRUST_LEVELS: readonly TrustLevel[] = ["ask_all", "ask_risky", "no_ask"];

/** Defaults when the server has never saved a document: the expanded column. */
export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  sidebarCollapsed: false,
  expanded: {},
};

export const DEFAULT_TRUST_LEVEL: TrustLevel = "ask_risky";

/** ADR-0080 defaults: dictation waits in the box; the browser may fall back. */
export const DEFAULT_SPEECH_AUTO_SEND = false;
export const DEFAULT_SPEECH_BROWSER_FALLBACK = true;

/** Wire shape of `GET /api/v1/me/preferences` (contract C2). */
interface PreferencesWire {
  layout?: {
    /** Read and ignored (finding 10): the three removed settings still ride
     * documents the server saved before the cut, and the decoder refuses
     * unknown members, so the shape names them and `parseLayout` drops them. */
    projects_mode?: unknown;
    ask_placement?: unknown;
    show_workflow_folders?: unknown;
    expanded?: unknown;
  };
  assistant?: {
    trust_level?: unknown;
    speech_auto_send?: unknown;
    speech_browser_fallback?: unknown;
  };
  updated_at?: unknown;
}

/** One section of a `PATCH` body; the server deep-merges per section. */
export interface PreferencesPatch {
  layout?: {
    expanded?: Record<string, boolean>;
  };
  assistant?: {
    trust_level?: TrustLevel;
    speech_auto_send?: boolean;
    speech_browser_fallback?: boolean;
  };
}

/** Cached, camelCase state; a `404` is folded into a cache hit, not an error. */
interface PreferencesState {
  /** `false` when the server answered `404`: it does not store preferences. */
  stored: boolean;
  layout: LayoutPrefs;
  trustLevel: TrustLevel;
  /** ADR-0080: send a dictation the moment it finishes (default off). */
  speechAutoSend: boolean;
  /** ADR-0080: fall back to the browser's Web Speech API (default on). */
  speechBrowserFallback: boolean;
  updatedAt: string | null;
  /**
   * `Date.now()` of the last optimistic local change, `0` when the cache holds
   * only what the server last answered. A fetch that *started* before this
   * timestamp read a document from before the change and must not clobber it
   * (the change's PATCH answer is the source of truth).
   */
  localAt: number;
}

export const preferencesQueryKey = ["me", "preferences"] as const;

const PREFERENCES_PATH = "/api/v1/me/preferences";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Unknown enum values fall back to the defaults — the server owns validity. */
function parseLayout(raw: PreferencesWire["layout"] | undefined): LayoutPrefs {
  const all =
    raw?.expanded && typeof raw.expanded === "object"
      ? Object.fromEntries(
          Object.entries(raw.expanded).filter(([, value]) => typeof value === "boolean"),
        )
      : {};
  const expanded = { ...all };
  delete expanded[SIDEBAR_COLLAPSED_KEY];
  return {
    // The rail's state is one key of the map the server already stores; the
    // camelCase field is what callers read, so the key stays out of `expanded`.
    sidebarCollapsed: all[SIDEBAR_COLLAPSED_KEY] === true,
    expanded,
  };
}

function parseTrustLevel(raw: PreferencesWire["assistant"] | undefined): TrustLevel {
  return isString(raw?.trust_level) && TRUST_LEVELS.includes(raw.trust_level as TrustLevel)
    ? (raw.trust_level as TrustLevel)
    : DEFAULT_TRUST_LEVEL;
}

/** Missing or non-boolean values are the contract's defaults (ADR-0080). */
function parseSpeechAutoSend(raw: PreferencesWire["assistant"] | undefined): boolean {
  return raw?.speech_auto_send === true ? true : DEFAULT_SPEECH_AUTO_SEND;
}

function parseSpeechBrowserFallback(raw: PreferencesWire["assistant"] | undefined): boolean {
  return raw?.speech_browser_fallback === false ? false : DEFAULT_SPEECH_BROWSER_FALLBACK;
}

/** Map a wire document into the cached state. */
export function parsePreferences(body: PreferencesWire, stored = true): PreferencesState {
  return {
    stored,
    layout: parseLayout(body.layout),
    trustLevel: parseTrustLevel(body.assistant),
    speechAutoSend: parseSpeechAutoSend(body.assistant),
    speechBrowserFallback: parseSpeechBrowserFallback(body.assistant),
    updatedAt: isString(body.updated_at) ? body.updated_at : null,
    localAt: 0,
  };
}

/**
 * True when `fetched` is older than what the cache already holds and writing
 * it would regress the UI:
 * - the cache holds a document saved after the fetch's, or the same one —
 *   the fetch raced a save and read the pre-save row;
 * - or the document was never saved (both `updated_at` are `null`) and a
 *   local change was made after the fetch started — the fetch read the
 *   pre-change row and the pending PATCH's answer is authoritative.
 */
/**
 * True when `fetched` is older than what the cache already holds and writing
 * it would regress the UI (the fetch raced a local change and read the
 * pre-change row):
 * - the cache carries a local change no server answer has confirmed yet —
 *   a `null` `updated_at` with a non-zero `localAt`; once the PATCH answer
 *   lands it carries a fresh `updated_at` and the timestamp rule below
 *   takes over. The pending change's own answer is the source of truth;
 * - or the cache holds a document saved at or after the fetch's — the
 *   fetch read the pre-save row.
 */
function isStaleFetch(prev: PreferencesState, fetched: PreferencesState): boolean {
  if (prev.updatedAt == null && prev.localAt > 0) return true;
  if (prev.updatedAt && fetched.updatedAt) {
    return Date.parse(fetched.updatedAt) <= Date.parse(prev.updatedAt);
  }
  return false;
}

function toLayoutWire(layout: LayoutPrefs): NonNullable<PreferencesPatch["layout"]> {
  // Only the survivor is written. The server deep-merges per member, so the
  // stored `projects_mode` / `ask_placement` / `show_workflow_folders` values
  // (which no client reads any more) are left exactly as they were — no new
  // wire fields, no server change, no 400 from the closed `layout` object.
  return { expanded: layout.expanded };
}

/**
 * The shared read + write. Optimistic changes land in the query cache, so
 * every consumer sees the same value and a change survives a tab switch.
 */
/** Stable identity across renders so consumers' effects don't churn while the query holds no data. */
const EMPTY_STATE: PreferencesState = {
  stored: true,
  layout: { ...DEFAULT_LAYOUT_PREFS, expanded: {} },
  trustLevel: DEFAULT_TRUST_LEVEL,
  speechAutoSend: DEFAULT_SPEECH_AUTO_SEND,
  speechBrowserFallback: DEFAULT_SPEECH_BROWSER_FALLBACK,
  updatedAt: null,
  localAt: 0,
};

function usePreferencesCore() {
  const queryClient = useQueryClient();
  const query = useQuery<PreferencesState>({
    queryKey: preferencesQueryKey,
    queryFn: async () => {
      try {
        const fetched = parsePreferences(await apiFetch<PreferencesWire>(PREFERENCES_PATH));
        // A fetch that raced a local optimistic change read the pre-change
        // document; the persisted state the user just made keeps winning
        // (its PATCH answer lands in the cache separately).
        const prev = queryClient.getQueryData<PreferencesState>(preferencesQueryKey);
        if (prev && isStaleFetch(prev, fetched)) return prev;
        return fetched;
      } catch (error) {
        // The parallel backend may not ship the endpoint yet: degrade to the
        // in-memory mode instead of treating it as a fault. Keep any change
        // the session already made — a re-fetch must not wipe it.
        if (error instanceof ApiError && error.status === 404) {
          const previous = queryClient.getQueryData<PreferencesState>(preferencesQueryKey);
          return {
            stored: false,
            layout: previous?.layout ?? EMPTY_STATE.layout,
            trustLevel: previous?.trustLevel ?? DEFAULT_TRUST_LEVEL,
            speechAutoSend: previous?.speechAutoSend ?? DEFAULT_SPEECH_AUTO_SEND,
            speechBrowserFallback:
              previous?.speechBrowserFallback ?? DEFAULT_SPEECH_BROWSER_FALLBACK,
            updatedAt: null,
            localAt: previous?.localAt ?? 0,
          };
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: (body: PreferencesPatch) =>
      apiFetch<PreferencesWire>(PREFERENCES_PATH, { method: "PATCH", json: body }),
    // The PATCH answers with the full document: replace the cached state.
    onSuccess: (body) => {
      queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
        ...parsePreferences(body),
        localAt: prev?.localAt ?? 0,
      }));
    },
    // A failed save (400/401/network): drop the "unconfirmed local change"
    // marker so the next read can replace the rolled-back value with the
    // server's truth.
    onError: () => {
      queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) =>
        prev ? { ...prev, localAt: 0 } : prev,
      );
    },
  });

  const state = query.data ?? EMPTY_STATE;

  const applyLayout = (patch: Partial<LayoutPrefs>) => {
    const collapsed = patch.sidebarCollapsed ?? state.layout.sidebarCollapsed;
    // The rail's flag rides `expanded` (see `SIDEBAR_COLLAPSED_KEY`). The
    // server merges that map key by key and never deletes, so the key is sent
    // with its boolean value ONLY when this write changes it: an untouched
    // `false` must not be stamped into every unrelated layout PATCH, and a
    // missing key would not clear a stored `true` when the rail expands.
    const expanded = { ...(patch.expanded ?? state.layout.expanded) };
    if (
      patch.sidebarCollapsed !== undefined &&
      patch.sidebarCollapsed !== state.layout.sidebarCollapsed
    ) {
      expanded[SIDEBAR_COLLAPSED_KEY] = collapsed;
    }
    const next: LayoutPrefs = { ...state.layout, ...patch, sidebarCollapsed: collapsed, expanded };
    // Optimistic: the chevron flips immediately; the server's answer replaces it.
    queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
      stored: prev?.stored ?? true,
      layout: next,
      trustLevel: prev?.trustLevel ?? DEFAULT_TRUST_LEVEL,
      speechAutoSend: prev?.speechAutoSend ?? DEFAULT_SPEECH_AUTO_SEND,
      speechBrowserFallback: prev?.speechBrowserFallback ?? DEFAULT_SPEECH_BROWSER_FALLBACK,
      updatedAt: prev?.updatedAt ?? null,
      localAt: Date.now(),
    }));
    mutation.mutate({ layout: toLayoutWire(next) });
  };

  const applyTrust = (trustLevel: TrustLevel) => {
    queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
      stored: prev?.stored ?? true,
      layout: prev?.layout ?? { ...DEFAULT_LAYOUT_PREFS, expanded: {} },
      trustLevel,
      speechAutoSend: prev?.speechAutoSend ?? DEFAULT_SPEECH_AUTO_SEND,
      speechBrowserFallback: prev?.speechBrowserFallback ?? DEFAULT_SPEECH_BROWSER_FALLBACK,
      updatedAt: prev?.updatedAt ?? null,
      localAt: Date.now(),
    }));
    mutation.mutate({ assistant: { trust_level: trustLevel } });
  };

  /** ADR-0080: the two dictation switches ride the same assistant section and
   * the same PATCH as the trust level; only CHANGED keys are sent, so an
   * untouched switch keeps its stored value (the server merges per field). */
  const applySpeech = (
    patch: Partial<Pick<PreferencesState, "speechAutoSend" | "speechBrowserFallback">>,
  ) => {
    const assistant: NonNullable<PreferencesPatch["assistant"]> = {};
    if (patch.speechAutoSend !== undefined && patch.speechAutoSend !== state.speechAutoSend) {
      assistant.speech_auto_send = patch.speechAutoSend;
    }
    if (
      patch.speechBrowserFallback !== undefined &&
      patch.speechBrowserFallback !== state.speechBrowserFallback
    ) {
      assistant.speech_browser_fallback = patch.speechBrowserFallback;
    }
    if (Object.keys(assistant).length === 0) return;
    queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
      stored: prev?.stored ?? true,
      layout: prev?.layout ?? { ...DEFAULT_LAYOUT_PREFS, expanded: {} },
      trustLevel: prev?.trustLevel ?? DEFAULT_TRUST_LEVEL,
      speechAutoSend: patch.speechAutoSend ?? prev?.speechAutoSend ?? DEFAULT_SPEECH_AUTO_SEND,
      speechBrowserFallback:
        patch.speechBrowserFallback ??
        prev?.speechBrowserFallback ??
        DEFAULT_SPEECH_BROWSER_FALLBACK,
      updatedAt: prev?.updatedAt ?? null,
      localAt: Date.now(),
    }));
    mutation.mutate({ assistant });
  };

  return { state, query, applyLayout, applyTrust, applySpeech, loaded: query.data !== undefined };
}

/**
 * Contract C2: `useLayoutPrefs(): { prefs: LayoutPrefs; update(patch); saved; loaded }`.
 * `saved` is `false` when the server lacks the endpoint (404): the change is
 * then kept in memory for the session. `loaded` is `true` once the document
 * has been read at least once: a component that writes a preference *on its
 * own* (the sidebar auto-expanding the project the route is inside) must wait
 * for it, or its optimistic write makes the in-flight read look stale and the
 * saved document is thrown away.
 */
export function useLayoutPrefs(): {
  prefs: LayoutPrefs;
  update: (patch: Partial<LayoutPrefs>) => void;
  saved: boolean;
  loaded: boolean;
} {
  const { state, applyLayout, loaded } = usePreferencesCore();
  return { prefs: state.layout, update: applyLayout, saved: state.stored, loaded };
}

/** Contract C2: `useAssistantPrefs(): { trustLevel; setTrustLevel; saved }`. */
export function useAssistantPrefs(): {
  trustLevel: TrustLevel;
  setTrustLevel: (trustLevel: TrustLevel) => void;
  saved: boolean;
} {
  const { state, applyTrust } = usePreferencesCore();
  return { trustLevel: state.trustLevel, setTrustLevel: applyTrust, saved: state.stored };
}

/** ADR-0080 (handoff A5/A6): the two dictation switches of Settings →
 * Assistant → Speech, stored in the same `assistant` preference section and
 * PATCHed through the same mutation as the trust level. Defaults when the
 * server has never saved them: auto-send off, browser fallback on. */
export function useAssistantSpeechPrefs(): {
  speechAutoSend: boolean;
  setSpeechAutoSend: (value: boolean) => void;
  speechBrowserFallback: boolean;
  setSpeechBrowserFallback: (value: boolean) => void;
  saved: boolean;
} {
  const { state, applySpeech } = usePreferencesCore();
  return {
    speechAutoSend: state.speechAutoSend,
    setSpeechAutoSend: (value) => applySpeech({ speechAutoSend: value }),
    speechBrowserFallback: state.speechBrowserFallback,
    setSpeechBrowserFallback: (value) => applySpeech({ speechBrowserFallback: value }),
    saved: state.stored,
  };
}

/** The repo page's view choice (design 3a): the mixed List, or the not-yet-
built board of Lanes. */
export type RepoView = "list" | "lanes";

/**
 * The `expanded` key carrying one repository's view choice. Like the rail's
 * collapsed flag (`SIDEBAR_COLLAPSED_KEY`), the flag rides the open-keyed
 * `expanded` map because the server's `layout` section is a closed object —
 * a new member there is an API change needing its own ADR, while `expanded`
 * is documented to take any key. `repo-view:<name>` present (true) means
 * Lanes; its absence is List (the default).
 */
export function repoViewExpandedKey(repositoryName: string): string {
  return `repo-view:${repositoryName}`;
}

/** The List | Lanes choice for one repository, remembered per repo in the
 * user's layout prefs (3a). `saved` is false when the server lacks the
 * endpoint: the choice then lives for the session only.
 *
 * The choice is WRITTEN AS AN EXPLICIT BOOLEAN, not by deleting the key:
 * the server's preferences PATCH merges the `expanded` map key-by-key and
 * never drops one (observed live: a PATCH whose `expanded` omitted
 * `repo-view:app` answered 200 with the stored `true` still in the map), so
 * a delete-based List would never stick and the toggle would be one-way.
 * `false` says List in a word the merge cannot lose. */
export function useRepoView(repositoryName: string): {
  view: RepoView;
  setView: (view: RepoView) => void;
  saved: boolean;
  loaded: boolean;
} {
  const { prefs, update, saved, loaded } = useLayoutPrefs();
  const key = repoViewExpandedKey(repositoryName);
  const view: RepoView = prefs.expanded[key] === true ? "lanes" : "list";
  const setView = (next: RepoView) => {
    if (next === view) return;
    const expanded = { ...prefs.expanded, [key]: next === "lanes" };
    update({ expanded });
  };
  return { view, setView, saved, loaded };
}
