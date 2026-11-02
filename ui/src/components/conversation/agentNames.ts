/**
 * Naming the agent a `launcher_id` points at, in the words a person chose
 * (reviews 2e and 3d).
 *
 * The journal identifies an agent by its LAUNCHER (`claude`) — the executable
 * the worker spawns. A member chooses a PROFILE ("Claude Code", or "Claude Code
 * · opus"), and the two are not the same word: a transcript line that prints
 * `claude` where the composer chip prints `Claude Code` reads like a second
 * agent, and a mail card reading "← server · claude" names the binary rather
 * than the agent that answered.
 *
 * One resolver, and every reading of it goes through these rules:
 *
 * - the conversation's OWN profile row answers for the session it is running
 *   (the live binding launches from it);
 * - a `conversation.agent.switched` frame is the journal's own statement that
 *   a named profile runs on a named launcher, so it answers for a profile the
 *   conversation moved to — this is why the line names the right agent after a
 *   switch with no second read at all;
 * - the organization's profile list answers only when EXACTLY ONE row carries
 *   that launcher. Two profiles on one executable ("Claude Code" and "Claude
 *   Code · opus") name nothing: picking one would misattribute an answer.
 *
 * With no read naming the launcher the caller gets `null` and prints the
 * launcher id it was given — the machine's word, honestly labelled, never an
 * invented product name.
 */
import type { EventEnvelope } from "../../api/types";

/** What a read knows about the agent behind one launcher id. */
export interface AgentDisplay {
  name: string;
  /** The profile's pinned display model; null when it names none. */
  model?: string | null;
}

export interface LauncherNameSource {
  /** The conversation's next-turn launcher (`Conversation.launcher_id`). */
  currentLauncherId?: string | null;
  /** Its display name (`Conversation.agent_profile_name`). */
  currentProfileName?: string | null;
  /** And its pinned model, when the profile carries one. */
  currentProfileModel?: string | null;
  /** Launcher → profile-name pairs the switch dividers in this stream named. */
  switchNames?: readonly { launcherId: string; profileName: string }[];
  /** The organization's profile list, when the surface holds one. */
  profiles?: readonly { launcherId: string; name: string; model?: string | null }[];
}

/** The display facts for a launcher id, or null when no read names it. */
export function agentDisplayForLauncher(
  launcherId: string,
  source: LauncherNameSource,
): AgentDisplay | null {
  if (!launcherId) return null;
  if (source.currentLauncherId === launcherId && source.currentProfileName) {
    return { name: source.currentProfileName, model: source.currentProfileModel ?? null };
  }
  const switched = (source.switchNames ?? []).filter((row) => row.launcherId === launcherId);
  if (switched.length > 0) {
    // The newest divider is the truth about that launcher — an older one
    // described the profile that moved. Its model comes from the profile list
    // only when the name matches exactly one row.
    const name = switched[switched.length - 1].profileName;
    const rows = (source.profiles ?? []).filter(
      (profile) => profile.launcherId === launcherId && profile.name === name,
    );
    return { name, model: rows.length === 1 ? (rows[0].model ?? null) : null };
  }
  const named = (source.profiles ?? []).filter((profile) => profile.launcherId === launcherId);
  return named.length === 1 ? { name: named[0].name, model: named[0].model ?? null } : null;
}

/** A resolver for one surface: the launcher's display name, or null. */
export function launcherNameResolver(
  source: LauncherNameSource,
): (launcherId: string) => string | null {
  return (launcherId: string) => agentDisplayForLauncher(launcherId, source)?.name ?? null;
}

/**
 * The source built from a conversation read, its stream and the org's profiles.
 *
 * `events` is scanned for switch dividers only. `conversation.created` names
 * the profile the thread OPENED on, which the read already carries as
 * `agent_profile_name`; a divider is the only frame that pairs a NEW profile
 * name with its launcher, so it is the only one worth reading here.
 */
export function launcherNameSource(
  data:
    | {
        launcher_id?: string | null;
        agent_profile_name?: string | null;
        agent_profile_model?: string | null;
      }
    | undefined,
  events: readonly EventEnvelope[],
  profiles: readonly { launcher_id: string; name: string; model?: string | null }[],
): LauncherNameSource {
  return {
    currentLauncherId: data?.launcher_id ?? null,
    currentProfileName: data?.agent_profile_name ?? null,
    currentProfileModel: data?.agent_profile_model ?? null,
    switchNames: events.flatMap((event) => {
      if (event.type !== "conversation.agent.switched") return [];
      const launcher = event.payload?.to_launcher_id;
      const name = event.payload?.to_profile_name;
      return typeof launcher === "string" && typeof name === "string" && launcher && name
        ? [{ launcherId: launcher, profileName: name }]
        : [];
    }),
    profiles: profiles.map((profile) => ({
      launcherId: profile.launcher_id,
      name: profile.name,
      model: profile.model ?? null,
    })),
  };
}
