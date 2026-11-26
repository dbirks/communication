/**
 * DEFAULT AGENT — the one line the project home's right column carries about
 * this project's default agent (ADR-0086; docs/design/redesign/CONTRACT.md
 * "Agents & models" 3), and the same line on the project's Manage detail page.
 *
 * What it says is the joined name the `Project` resource already carries
 * (`default_agent_profile_name`) — never a name the id does not point at, and
 * no default reads honestly as "none yet".
 *
 * Only a person who may manage the project (the same `my_role === "maintainer"`
 * check the editable settings use) gets the writes: the shared `AgentPicker`
 * (CONTRACT "The agent chip is a profile picker everywhere", opened
 * `side="bottom"`), which is the `change` control and prints the profile's own
 * name on its chip, and — because the picker offers profiles and never a clear
 * item — a small `use no default` button beside it. `AgentPicker` owns its
 * trigger: the same name cannot be static text AND anchor that popover without
 * editing a component outside this brief, so a maintainer reads the name from
 * the chip while a read-only member reads the static text, and nothing is
 * printed twice.
 *
 * Both writes are the project's optimistic PATCH (`useSetProjectDefaultAgent`):
 * the label moves at once and moves BACK when the write is refused, with the
 * server's fact as the one line under it (`role="alert"`) — a lost CAS or a
 * profile outside the project's organization is never dressed up as saved.
 */
import { useState } from "react";
import { defaultAgentSaveSentence, useSetProjectDefaultAgent } from "../../api/queries";
import type { Project } from "../../api/types";
import { AgentPicker } from "../shell/AgentPicker";
import { ColumnHeading } from "./SectionLabel";

export interface DefaultAgentLineProps {
  project: Project;
}

/** The one line under the settings a failure refused. */
export function defaultAgentSaveLine(error: unknown): string {
  return defaultAgentSaveSentence(error) ?? "The default agent could not be saved.";
}

export function DefaultAgentLine({ project }: DefaultAgentLineProps) {
  const setDefault = useSetProjectDefaultAgent(project.id);
  // The pick whose PATCH is in flight. `AgentPicker` prints the name of the id
  // it is given, so the chip moves at once; when the write is refused the chip
  // falls back to the id the project read carries.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canManage = project.my_role === "maintainer";
  // "no default" is the id, and only the id: the joined name rides it, so a
  // row that ever carries a name with no id still reads "none yet".
  const savedId = project.default_agent_profile_id ?? null;
  const shownId = pending ? pendingId : savedId;
  const shownName = savedId ? (project.default_agent_profile_name ?? null) : null;

  const save = (profileId: string | null) => {
    setPendingId(profileId);
    setPending(true);
    setDefault.mutate(
      { default_agent_profile_id: profileId, version: project.version },
      {
        onSuccess: () => setPending(false),
        // Rollback: the label is the project's own value again, and the
        // server's reason is the one sentence printed under the line.
        onError: () => setPending(false),
      },
    );
  };

  const sentence = setDefault.error ? defaultAgentSaveLine(setDefault.error) : null;

  return (
    <section className="min-w-0" aria-label="Default agent" data-testid="project-default-agent">
      <ColumnHeading testid="project-default-agent-label">Default agent</ColumnHeading>
      <div
        className="flex flex-wrap items-baseline gap-x-[8px]"
        data-testid="project-default-agent-line"
      >
        {canManage ? (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-[8px]">
            <AgentPicker
              value={shownId}
              onChange={save}
              side="bottom"
              testid="project-default-agent-change"
              disabled={setDefault.isPending}
              disabledReason="Saving the choice…"
            />
            {savedId ? (
              <button
                type="button"
                data-testid="project-default-agent-clear"
                disabled={setDefault.isPending}
                title="No default: the agent chip falls back to your last choice"
                onClick={() => save(null)}
                className="cursor-pointer text-[12.5px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:text-disabled-fg"
              >
                use no default
              </button>
            ) : null}
          </span>
        ) : shownName ? (
          <span
            className="text-[13.5px] font-semibold text-ink"
            data-testid="project-default-agent-name"
          >
            {shownName}
          </span>
        ) : (
          <span className="text-[13.5px] text-muted" data-testid="project-default-agent-none">
            none yet
          </span>
        )}
      </div>
      {sentence ? (
        <p
          role="alert"
          className="m-0 pt-[4px] text-[12.5px] text-st-failed-tag-fg"
          data-testid="project-default-agent-error"
        >
          {sentence}
        </p>
      ) : null}
    </section>
  );
}

export default DefaultAgentLine;
