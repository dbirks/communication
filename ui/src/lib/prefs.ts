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

export type ProjectsMode = "tree" | "switcher";
export type AskPlacement = "sidebar" | "floating";
export type TrustLevel = "ask_all" | "ask_risky" | "no_ask";

/** Display preferences for the app shell's layout (contract C2). */
export interface LayoutPrefs {
  projectsMode: ProjectsMode;
  askPlacement: AskPlacement;
  showWorkflowFolders: boolean;
  expanded: Record<string, boolean>;
}

const PROJECTS_MODES: readonly ProjectsMode[] = ["tree", "switcher"];
const ASK_PLACEMENTS: readonly AskPlacement[] = ["sidebar", "floating"];
export const TRUST_LEVELS: readonly TrustLevel[] = ["ask_all", "ask_risky", "no_ask"];

/** Defaults when the server has never saved a document (README decision; tree wins over 3g). */
export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  projectsMode: "tree",
  askPlacement: "sidebar",
  showWorkflowFolders: true,
  expanded: {},
};

export const DEFAULT_TRUST_LEVEL: TrustLevel = "ask_risky";

/** Wire shape of `GET /api/v1/me/preferences` (contract C2). */
interface PreferencesWire {
  layout?: {
    projects_mode?: unknown;
    ask_placement?: unknown;
    show_workflow_folders?: unknown;
    expanded?: unknown;
  };
  assistant?: { trust_level?: unknown };
  updated_at?: unknown;
}

/** One section of a `PATCH` body; the server deep-merges per section. */
export interface PreferencesPatch {
  layout?: {
    projects_mode?: ProjectsMode;
    ask_placement?: AskPlacement;
    show_workflow_folders?: boolean;
    expanded?: Record<string, boolean>;
  };
  assistant?: { trust_level?: TrustLevel };
}

/** Cached, camelCase state; a `404` is folded into a cache hit, not an error. */
interface PreferencesState {
  /** `false` when the server answered `404`: it does not store preferences. */
  stored: boolean;
  layout: LayoutPrefs;
  trustLevel: TrustLevel;
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
  const expanded =
    raw?.expanded && typeof raw.expanded === "object"
      ? Object.fromEntries(
          Object.entries(raw.expanded).filter(([, value]) => typeof value === "boolean"),
        )
      : {};
  return {
    projectsMode:
      isString(raw?.projects_mode) && PROJECTS_MODES.includes(raw.projects_mode as ProjectsMode)
        ? (raw.projects_mode as ProjectsMode)
        : DEFAULT_LAYOUT_PREFS.projectsMode,
    askPlacement:
      isString(raw?.ask_placement) && ASK_PLACEMENTS.includes(raw.ask_placement as AskPlacement)
        ? (raw.ask_placement as AskPlacement)
        : DEFAULT_LAYOUT_PREFS.askPlacement,
    showWorkflowFolders:
      typeof raw?.show_workflow_folders === "boolean"
        ? raw.show_workflow_folders
        : DEFAULT_LAYOUT_PREFS.showWorkflowFolders,
    expanded,
  };
}

function parseTrustLevel(raw: PreferencesWire["assistant"] | undefined): TrustLevel {
  return isString(raw?.trust_level) && TRUST_LEVELS.includes(raw.trust_level as TrustLevel)
    ? (raw.trust_level as TrustLevel)
    : DEFAULT_TRUST_LEVEL;
}

/** Map a wire document into the cached state. */
export function parsePreferences(body: PreferencesWire, stored = true): PreferencesState {
  return {
    stored,
    layout: parseLayout(body.layout),
    trustLevel: parseTrustLevel(body.assistant),
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
  return {
    projects_mode: layout.projectsMode,
    ask_placement: layout.askPlacement,
    show_workflow_folders: layout.showWorkflowFolders,
    expanded: layout.expanded,
  };
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
    const next = { ...state.layout, ...patch, expanded: patch.expanded ?? state.layout.expanded };
    // Optimistic: the chevron flips immediately; the server's answer replaces it.
    queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
      stored: prev?.stored ?? true,
      layout: next,
      trustLevel: prev?.trustLevel ?? DEFAULT_TRUST_LEVEL,
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
      updatedAt: prev?.updatedAt ?? null,
      localAt: Date.now(),
    }));
    mutation.mutate({ assistant: { trust_level: trustLevel } });
  };

  return { state, query, applyLayout, applyTrust };
}

/**
 * Contract C2: `useLayoutPrefs(): { prefs: LayoutPrefs; update(patch); saved }`.
 * `saved` is `false` while the server lacks the endpoint (404): the change is
 * then kept in memory for the session.
 */
export function useLayoutPrefs(): {
  prefs: LayoutPrefs;
  update: (patch: Partial<LayoutPrefs>) => void;
  saved: boolean;
} {
  const { state, applyLayout } = usePreferencesCore();
  return { prefs: state.layout, update: applyLayout, saved: state.stored };
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
