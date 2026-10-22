/**
 * One issue-trigger row of the Triggers section's "Issue triggers" sub-list
 * (ADR-0056 part 2): the watched repository, when an open GitHub issue fires,
 * the any-of label set, the poll bookkeeping, and the enabled toggle. The row
 * answers "what is it watching, and what did it last say?" from the trigger row
 * alone — the poller writes the cursor/last_error and the UI never guesses.
 */
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { formatRemaining } from "../../lib/format";
import { usePatchIssueTrigger } from "../../api/useIssueTriggers";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import type { Repository } from "../../api/types";
import type { TriggerGroup } from "./Triggers";
import { patchErrorText } from "./Triggers";

/** `owner/repo` from a repository's git URL — the shape GitHub's issue
 * endpoints address (`https://github.com/<owner>/<repo>/issues/<N>`). A git URL
 * without a second path segment falls back to the repository name rather than
 * inventing an owner. */
export function repoRefOf(repository: Repository): string {
  const trimmed = repository.git_url.trim().replace(/\/+$/, "");
  const scp = /^[^@/\s]+@([^:\s]+):(.+)$/.exec(trimmed);
  const remote = scp
    ? `${scp[1]}/${scp[2]}`.replace(/\.git$/, "")
    : trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\.git$/, "");
  const parts = remote.split("/").filter((part) => part.length > 0);
  const owner = parts.length >= 2 ? parts[parts.length - 2] : repository.name;
  const repo = parts.length >= 2 ? parts[parts.length - 1] : repository.name;
  return `${owner}/${repo}`;
}

/** The event line, in the wording the product owner asked for: "when an issue
 * is opened" / "when an issue is labeled". */
export function issueEventText(event: IssueTrigger["event"]): string {
  return event === "opened" ? "when an issue is opened" : "when an issue is labeled";
}

export interface IssueTriggerRowProps {
  group: TriggerGroup;
  trigger: IssueTrigger;
  /** The row's edit action; the dialog opens with this trigger pre-filled. */
  onEdit: (trigger: IssueTrigger) => void;
}

/** One row: the watched repo, the fired condition, the any-of labels, the
 * last poll, the last error, and — for a caller who may write — the enabled
 * toggle and the edit action. */
export function IssueTriggerRow({ group, trigger, onEdit }: IssueTriggerRowProps) {
  const patch = usePatchIssueTrigger(group.project.id);
  const repository =
    group.repositories.find((candidate) => candidate.id === trigger.repository_id) ?? null;
  const repoRef = repository ? repoRefOf(repository) : "repository unavailable";
  const stateText = trigger.enabled ? "on" : "paused";
  const polled = trigger.last_polled_at
    ? `polled ${formatRemaining(trigger.last_polled_at, Date.now())}`
    : "never polled";

  return (
    <li
      className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]"
      data-testid={`trigger-issue-row-${trigger.id}`}
    >
      <code
        className="rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[11.5px] text-ink"
        data-testid={`trigger-issue-repo-${trigger.id}`}
      >
        {repoRef}
      </code>
      <span
        className="font-mono text-[11px] text-ink-2"
        data-testid={`trigger-issue-event-${trigger.id}`}
      >
        {issueEventText(trigger.event)}
      </span>
      {trigger.labels.length > 0 ? (
        <span
          className="flex items-center gap-[4px]"
          data-testid={`trigger-issue-labels-${trigger.id}`}
        >
          {trigger.labels.map((label) => (
            <span
              key={label}
              className="rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10.5px] text-ink-2"
              data-testid={`trigger-issue-label-${trigger.id}`}
            >
              {label}
            </span>
          ))}
        </span>
      ) : (
        <StatusChip
          state="info"
          label="any label"
          labelProps={{ "data-testid": `trigger-issue-labels-${trigger.id}` }}
        />
      )}
      <span
        className="font-mono text-[11px] text-faint"
        data-testid={`trigger-issue-polled-${trigger.id}`}
      >
        {polled}
      </span>
      {trigger.last_error ? (
        <p
          role="alert"
          className="font-mono text-[11px] text-st-failed-pale-fg"
          data-testid={`trigger-issue-last-error-${trigger.id}`}
        >
          <span aria-hidden="true">×</span> {trigger.last_error}
        </p>
      ) : null}
      {group.canManage ? (
        <label className="flex items-center gap-[6px] font-mono text-[11px] text-ink">
          <input
            type="checkbox"
            className="size-3 accent-accent"
            checked={trigger.enabled}
            aria-label={`issue trigger ${trigger.id} enabled`}
            data-testid={`trigger-issue-enabled-${trigger.id}`}
            onChange={(event) =>
              patch.mutate({
                issueTriggerId: trigger.id,
                body: { version: trigger.version, enabled: event.target.checked },
              })
            }
          />
          <span data-testid={`trigger-issue-state-${trigger.id}`}>{stateText}</span>
        </label>
      ) : (
        <StatusChip
          state={trigger.enabled ? "info" : "interrupted"}
          label={stateText}
          labelProps={{ "data-testid": `trigger-issue-state-${trigger.id}` }}
        />
      )}
      {group.canManage ? (
        <Button
          variant="secondary"
          compact
          data-testid={`trigger-issue-edit-${trigger.id}`}
          onClick={() => onEdit(trigger)}
        >
          Edit
        </Button>
      ) : null}
      {patch.isError ? (
        <Alert
          state="failed"
          label="FAILED"
          role="alert"
          testid={`trigger-issue-error-${trigger.id}`}
        >
          {patchErrorText(patch.error)}
        </Alert>
      ) : null}
    </li>
  );
}
