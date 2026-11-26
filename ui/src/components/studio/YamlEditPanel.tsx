/**
 * YamlEditPanel — editable YAML panel for an open draft (`?panel=yaml`),
 * wired to Studio's shared `useStudioDraft` state (autosave, conflict
 * handling, lastGood canvas fallback) and draft validation (`POST /drafts/{id}/validate`).
 */
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { DRAFT_STATE, VALIDATION_SOURCE_STATE, stateOf } from "../ds/states";
import { ProblemBanner } from "../Feedback";
import type { DraftStatus, ValidateBody } from "../../lib/pipeline/contract";

export interface YamlEditPanelProps {
  text: string;
  status: DraftStatus;
  dirty: boolean;
  saving: boolean;
  validating: boolean;
  parseError: { error: string; line: number | null } | null;
  verdict: ValidateBody | null;
  validateError: unknown;
  onChange: (next: string) => void;
  onValidate: () => void;
  onGoToNode: (instanceLocation: string | null) => void;
}

export function YamlEditPanel({
  text,
  status,
  dirty,
  saving,
  validating,
  parseError,
  verdict,
  validateError,
  onChange,
  onValidate,
  onGoToNode,
}: YamlEditPanelProps) {
  const busy = saving || validating;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[10px]" data-testid="studio-yaml-panel">
      <div className="flex flex-wrap items-center gap-[8px]">
        <h2 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
          Edit as YAML
        </h2>
        <StatusChip
          state={stateOf(DRAFT_STATE[status])}
          label={
            verdict === null
              ? "never validated"
              : verdict.valid
                ? "valid"
                : `${verdict.errors.length} ${verdict.errors.length === 1 ? "finding" : "findings"}`
          }
          labelProps={{ "data-testid": "studio-yaml-verdict" }}
        />
        {dirty ? (
          <span className="font-mono text-[10.5px] text-faint" data-testid="studio-yaml-dirty">
            unsaved changes
          </span>
        ) : null}
        <Button
          variant="secondary"
          compact
          disabled={busy || parseError !== null}
          onClick={onValidate}
          data-testid="studio-yaml-validate"
          className="ml-auto"
        >
          {validating ? "Validating…" : dirty ? "Validate (saves first)" : "Validate"}
        </Button>
      </div>

      <textarea
        data-testid="studio-yaml"
        aria-label="Workflow YAML"
        value={text}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        rows={18}
        className="min-h-[260px] w-full flex-1 resize-y rounded-[8px] border border-line-strong bg-surface p-[10px] font-mono text-[12px] leading-[18px] text-ink focus-visible:border-accent focus-visible:outline-none"
      />

      {parseError ? (
        <p className="font-mono text-[11px] text-st-failed-pale-fg" data-testid="studio-yaml-error">
          {parseError.error}
          {parseError.line !== null ? ` (line ${parseError.line})` : ""}
        </p>
      ) : null}

      {validateError !== null ? (
        <ProblemBanner
          error={validateError}
          fallback="The draft could not be validated."
          testid="studio-yaml-validate-error"
        />
      ) : null}

      {verdict && verdict.errors.length > 0 ? (
        <ul
          className="divide-y divide-line-soft rounded-[8px] border border-line bg-paper px-[10px]"
          data-testid="studio-yaml-findings"
        >
          {verdict.errors.map((issue, index) => (
            <li
              key={`${issue.source}-${issue.code}-${index}`}
              className="flex items-start gap-[8px] py-[8px]"
              data-testid={`studio-yaml-finding-${index}`}
            >
              <div className="min-w-0 flex-1 space-y-[2px]">
                <div className="flex flex-wrap items-center gap-[6px]">
                  <StatusChip
                    state={stateOf(VALIDATION_SOURCE_STATE[issue.source])}
                    label={issue.source}
                  />
                  <span className="font-mono text-[11px] font-semibold text-ink">{issue.code}</span>
                </div>
                <p className="text-[12px] leading-[16px] text-ink-2">{issue.message}</p>
                {issue.hint ? (
                  <p className="font-mono text-[10.5px] text-muted">hint: {issue.hint}</p>
                ) : null}
              </div>
              {issue.instance_location !== null ? (
                <Button
                  variant="ghost"
                  compact
                  data-testid={`studio-yaml-goto-node-${index}`}
                  onClick={() => onGoToNode(issue.instance_location)}
                >
                  go to node
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
