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
  };
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
function usePreferencesCore() {
  const queryClient = useQueryClient();
  const query = useQuery<PreferencesState>({
    queryKey: preferencesQueryKey,
    queryFn: async () => {
      try {
        return parsePreferences(await apiFetch<PreferencesWire>(PREFERENCES_PATH));
      } catch (error) {
        // The parallel backend may not ship the endpoint yet: degrade to the
        // in-memory mode instead of treating it as a fault. Keep any change
        // the session already made — a re-fetch must not wipe it.
        if (error instanceof ApiError && error.status === 404) {
          const previous = queryClient.getQueryData<PreferencesState>(preferencesQueryKey);
          return {
            stored: false,
            layout: previous?.layout ?? { ...DEFAULT_LAYOUT_PREFS, expanded: {} },
            trustLevel: previous?.trustLevel ?? DEFAULT_TRUST_LEVEL,
            updatedAt: null,
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
      queryClient.setQueryData(preferencesQueryKey, parsePreferences(body));
    },
  });

  const state = query.data ?? {
    stored: true,
    layout: { ...DEFAULT_LAYOUT_PREFS, expanded: {} },
    trustLevel: DEFAULT_TRUST_LEVEL,
    updatedAt: null,
  };

  const applyLayout = (patch: Partial<LayoutPrefs>) => {
    const next = { ...state.layout, ...patch, expanded: patch.expanded ?? state.layout.expanded };
    // Optimistic: the radio flips immediately; the server's answer replaces it.
    queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
      stored: prev?.stored ?? true,
      layout: next,
      trustLevel: prev?.trustLevel ?? DEFAULT_TRUST_LEVEL,
      updatedAt: prev?.updatedAt ?? null,
    }));
    mutation.mutate({ layout: toLayoutWire(next) });
  };

  const applyTrust = (trustLevel: TrustLevel) => {
    queryClient.setQueryData<PreferencesState>(preferencesQueryKey, (prev) => ({
      stored: prev?.stored ?? true,
      layout: prev?.layout ?? { ...DEFAULT_LAYOUT_PREFS, expanded: {} },
      trustLevel,
      updatedAt: prev?.updatedAt ?? null,
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
