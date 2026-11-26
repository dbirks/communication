/**
 * Which agent the chip starts on (ADR-0086).
 *
 * A project may name a default agent profile; a person may also have picked an
 * agent here before. The one rule the agent chip follows in every composer
 * (`HomePrompt`, `NewChatPane`) is:
 *
 * 1. the choice this person last made in this project — it is theirs, and a
 *    project default never overwrites a pick they already made;
 * 2. else the project's default profile, but only while that profile is still
 *    offered: a profile deleted server-side clears the project's own row, and a
 *    profile that simply is not in this list anymore cannot be chosen either;
 * 3. else the first profile of the list.
 *
 * Null only when there is no profile to pick at all — nothing is invented.
 */
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { updateConfig, type OpResult } from "./pipeline/graphDoc";
import type { AgentProfile } from "../api/types";

/** The profile's id when the list really carries it, else null. */
function offered(profiles: AgentProfile[], id: string | null | undefined): string | null {
  if (!id) return null;
  return profiles.some((profile) => profile.id === id) ? id : null;
}

export interface DefaultAgentChoice {
  /** The stored pick for this project (localStorage), or null. */
  stored: string | null | undefined;
  /** `project.default_agent_profile_id`, or null when the project names none. */
  projectDefault: string | null | undefined;
  /** The profiles the chip may offer. */
  profiles: AgentProfile[];
}

/** The id the agent chip starts on, per the order above. */
export function pickDefaultAgent({
  stored,
  projectDefault,
  profiles,
}: DefaultAgentChoice): string | null {
  return offered(profiles, stored) ?? offered(profiles, projectDefault) ?? profiles[0]?.id ?? null;
}

/** The localStorage key carrying this person's agent pick for one project —
 * one browser's memory, never a server fact. */
export function homeAgentKey(projectId: string): string {
  return `communication.home.agent.${projectId}`;
}

/** The pick stored for a project, or null (private mode reads as "never
 * chosen here", which is what it is). */
export function storedAgentChoice(projectId: string): string | null {
  if (!projectId) return null;
  try {
    return localStorage.getItem(homeAgentKey(projectId));
  } catch {
    return null;
  }
}

/** Store a pick for a project. A storage that refuses (private mode) keeps the
 * choice in component state only, which is the behaviour before it was stored. */
export function rememberAgentChoice(projectId: string, profileId: string): void {
  if (!projectId) return;
  try {
    localStorage.setItem(homeAgentKey(projectId), profileId);
  } catch {
    /* nothing to do: the pick lives for this box */
  }
}

/**
 * The profile a step the editor just added starts on (ADR-0086): the project's
 * default agent, written into the new step only when that step names no profile
 * yet — which is what `addNode`'s skeleton always leaves. An existing step, or
 * a document where the named step already carries one, is returned untouched:
 * this is a starting value, never an overwrite.
 *
 * The result's `changed` list is the adding op's own, so what the canvas selects
 * after the add is unchanged by this write.
 */
export function withProjectDefaultAgent(
  result: OpResult,
  kind: string,
  profileId: string | null,
): OpResult {
  if (!result.ok || kind !== "agent.acp" || !profileId || result.changed.length === 0) {
    return result;
  }
  const [addedId] = result.changed;
  if (stepNamesProfile(result.text, addedId)) return result;
  const written = updateConfig(result.text, addedId, { profile: profileId });
  return written.ok ? { ok: true, text: written.text, changed: result.changed } : result;
}

/** Does the step with this id already name a `config.profile`? Read off the
 * document itself (ids are unique across every scope of a pipeline document),
 * never off a guess. */
export function stepNamesProfile(text: string, id: string): boolean {
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch {
    return true; // cannot read it: change nothing
  }
  if (doc.errors.length > 0) return true;
  const found = findStep(doc.contents, id);
  if (!isMap(found)) return false;
  const profile = (found.get("config") as YAMLMap | undefined)?.get("profile");
  return typeof profile === "string" ? profile.trim() !== "" : profile != null;
}

/** Depth-first search of every `nodes` collection for the step with this id. */
function findStep(value: unknown, id: string): YAMLMap | null {
  if (isMap(value)) {
    const map = value as YAMLMap;
    if (map.get("id") === id && map.get("kind") != null) return map;
    for (const key of ["spec", "nodes", "body", "config"]) {
      const nested = findStep(map.get(key), id);
      if (nested) return nested;
    }
    return null;
  }
  if (isSeq(value)) {
    for (const item of value.items) {
      const nested = findStep(item, id);
      if (nested) return nested;
    }
  }
  return null;
}
