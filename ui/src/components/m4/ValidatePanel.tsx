/**
 * The "Validate" panel — `docs/m4-contract.md` § 7.2 row W8.
 *
 * A textarea plus a button. It is deliberately **not** an editor: no syntax
 * highlighting, no autocomplete, no keybindings, no dirty-file semantics —
 * in-browser authoring is M5's scope and this panel must not pre-empt it. What
 * it does is turn pasted YAML into the server's verdict by walking the routes
 * that already exist: `POST /pipelines/{id}/drafts` (one scratch draft per
 * panel), `PUT /drafts/{id}` when the text changed, then
 * `POST /drafts/{id}/validate`, whose § 2.2 body is rendered verbatim.
 *
 * Three rules the rendering must keep (§ 2.2, ADR-0021 Security):
 * the sources are **ordered, never merged** — loader, then schema, then
 * compiler, in the server's own order within each; every row carries its
 * `instance_location`, its `source` and its `hint`; and a
 * `secret_literal_detected` row shows only what the server sent, never the
 * textarea's raw value re-read back into the row.
 * `kind_not_implemented` is a validate-time refusal whose whole point is the
 * milestone (ADR-0024), so the row surfaces the milestone the *response* names.
 */
import { useEffect, useMemo, useState } from "react";
import { ProblemBanner } from "../Feedback";
import { Button } from "../ds/Button";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { VALIDATION_SOURCE_STATE, stateOf } from "../ds/states";
import {
  draftConflictOf,
  useCreateDraft,
  usePutDraft,
  useValidateDraft,
} from "../../api/pipelines";
import { viewValidate } from "../../api/m4view";
import type { ValidateBody, ValidationIssue } from "../../lib/pipeline/contract";
import { YamlView } from "./YamlView";

/** A pipeline the panel may open a scratch draft against. */
export interface ValidatePanelOption {
  id: string;
  slug: string;
  displayName: string;
}

export interface ValidatePanelProps {
  /** The org library, ordered as the caller shows it. */
  pipelines: ValidatePanelOption[];
  /**
   * Whether the caller holds the library role — drafts and validation are the
   * library surface (`01` "Publish shared pipeline revision"), and only org
   * admins hold it. `false` renders the honest reason instead of a button that
   * would only produce a `403`.
   */
  canValidate: boolean;
  /** Text to seed the textarea with (a revision the page already has). */
  initialText?: string;
  headingId?: string;
  className?: string;
}

/** The draft this panel is using as its scratch pad. */
interface ScratchDraft {
  pipelineId: string;
  id: string;
  version: number;
}

/** `M5` / `M6` as the compiler names them in a message or hint (ADR-0024). */
const MILESTONE_IN_TEXT = /\b(M\d+)\b/;

export function ValidatePanel({
  pipelines,
  canValidate,
  initialText = "",
  headingId = "validate-panel-heading",
  className = "",
}: ValidatePanelProps) {
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? "");
  const [text, setText] = useState(initialText);
  const [draft, setDraft] = useState<ScratchDraft | null>(null);
  /** Set when a write has landed and the validate call may now be made against
   * a hook bound to the current draft id (a fresh create only exists after the
   * re-render, so the call is deferred one effect). */
  const [awaitingValidate, setAwaitingValidate] = useState(false);
  /** The text the served `result` describes — what the YamlView marks. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [result, setResult] = useState<ValidateBody | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const create = useCreateDraft(pipelineId);
  const put = usePutDraft(draft?.id ?? "");
  const validate = useValidateDraft(draft?.id ?? "");

  useEffect(() => {
    if (!awaitingValidate || !draft) return;
    setAwaitingValidate(false);
    validate
      .mutateAsync()
      .then((body) => setResult(viewValidate(body)))
      .catch((error: unknown) => setFailure(error));
  }, [awaitingValidate, draft, validate]);

  const busy = create.isPending || put.isPending || validate.isPending;
  const selectedOption = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null;
  const dirty = draft === null || draft.pipelineId !== pipelineId || text !== submitted;

  async function runValidate() {
    setSelected(null);
    setFailure(null);
    try {
      if (!draft || draft.pipelineId !== pipelineId) {
        const created = await create.mutateAsync({ document_yaml: text });
        setDraft({ pipelineId, id: created.id, version: created.version });
        setSubmitted(text);
        setAwaitingValidate(true);
        return;
      }
      if (text !== submitted) {
        const replaced = await put.mutateAsync({ document_yaml: text, version: draft.version });
        setDraft({ pipelineId, id: replaced.id, version: replaced.version });
        setSubmitted(text);
        setAwaitingValidate(true);
        return;
      }
      setResult(viewValidate(await validate.mutateAsync()));
    } catch (error) {
      adoptConflict(error);
      setFailure(error);
    }
  }

  /** A `stale_draft_version` carries the truth (`current_version`): adopt it so
   * the next write is a CAS against what the server holds, never a guess. */
  function adoptConflict(error: unknown) {
    const conflict = draftConflictOf(error);
    const version = conflict?.current_version;
    if (!conflict || typeof version !== "number") return;
    const draftId = conflict.draft_id;
    setDraft((current) => (current ? { ...current, id: draftId, version } : current));
  }

  if (!canValidate) {
    return (
      <Panel title="VALIDATE YAML" headingId={headingId} headingLevel={2} className={className}>
        <p className="p-[10px] text-[12.5px] text-muted" data-testid="validate-panel-needs-role">
          Validating runs against a draft, and drafts belong to the library surface: you need the
          library role (organization admins hold it) to validate YAML. Published revisions above are
          read-only for you.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="VALIDATE YAML"
      headingId={headingId}
      headingLevel={2}
      state={result && !result.valid ? "failed" : undefined}
      meta={
        <span className="font-mono text-[10px] font-normal" data-testid="validate-panel-meta">
          {draft
            ? `scratch draft ${draft.id} · v${draft.version}`
            : "no draft yet — validating creates one"}
        </span>
      }
      className={className}
    >
      <div className="space-y-[10px] p-[10px]">
        <label className="flex items-center gap-[8px] text-[12.5px]">
          <span className="font-mono text-[10.5px] text-muted">pipeline</span>
          <select
            value={pipelineId}
            onChange={(event) => setPipelineId(event.target.value)}
            className="h-[26px] rounded-[3px] border border-line bg-surface px-[6px] font-mono text-[11.5px]"
            data-testid="validate-panel-pipeline"
          >
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.displayName} · {pipeline.slug}
              </option>
            ))}
          </select>
        </label>
        <p className="font-mono text-[10.5px] text-faint" data-testid="validate-panel-not-editor">
          not an editor: paste YAML and validate it. In-browser authoring is M5 — this box only
          turns text into the server&apos;s verdict through a scratch draft.
        </p>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          aria-label="Pipeline YAML to validate"
          rows={10}
          className="w-full resize-y rounded-[3px] border border-line bg-surface p-[8px] font-mono text-[11.5px] leading-[17px]"
          data-testid="validate-panel-input"
        />
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button
            variant="primary"
            onClick={runValidate}
            disabled={busy || text.trim() === "" || selectedOption === null}
            data-testid="validate-panel-submit"
          >
            {busy ? "Validating…" : dirty ? "Validate (writes the draft)" : "Validate again"}
          </Button>
          {result ? (
            result.valid ? (
              <StatusChip
                state="done"
                label="valid"
                labelProps={{ "data-testid": "validate-panel-verdict" }}
              />
            ) : (
              <StatusChip
                state="failed"
                label={`${result.errors.length} findings`}
                labelProps={{ "data-testid": "validate-panel-verdict" }}
              />
            )
          ) : (
            <span className="font-mono text-[10.5px] text-faint" data-testid="validate-panel-idle">
              nothing validated yet
            </span>
          )}
        </div>
        {failure ? (
          <ProblemBanner
            error={failure}
            fallback="Validation could not be run."
            testid="validate-panel-error"
          />
        ) : null}
        {result && !result.valid ? (
          <FindingList body={result} selected={selected} onSelect={setSelected} />
        ) : null}
        {result ? (
          <p className="font-mono text-[10.5px] text-muted" data-testid="validate-panel-notes">
            {result.notes.length > 0 ? result.notes.join(" · ") : "no notes from the server"}
          </p>
        ) : null}
      </div>
      {submitted !== null ? (
        <YamlView
          text={submitted}
          label={`the text you validated · ${selectedOption?.slug ?? pipelineId}`}
          validation={result}
          highlightPointer={selected}
          headingId={`${headingId}-yaml`}
        />
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * The ordered findings list: loader first (it gates the JSON the schema sees),
 * then schema, then compiler — the server's order inside each group, never a
 * merged re-sort (§ 2.2). One row per error, clickable, so the YamlView below
 * can mark the location the row names.
 */
function FindingList({
  body,
  selected,
  onSelect,
}: {
  body: ValidateBody;
  selected: string | null;
  onSelect: (pointer: string | null) => void;
}) {
  const grouped = useMemo(() => orderSources(body.errors), [body.errors]);
  let ordinal = -1;
  return (
    <div className="space-y-[6px]" data-testid="validate-panel-findings">
      {(["loader", "schema", "compiler"] as const).map((source) => (
        <div key={source} data-testid={`validate-panel-group-${source}`}>
          <p className="font-mono text-[10px] uppercase tracking-[.04em] text-muted">
            {source} · {grouped[source].length}
          </p>
          <ul className="mt-[3px] space-y-[4px]">
            {grouped[source].map((issue) => {
              ordinal += 1;
              const index = ordinal;
              const active = selected !== null && selected === issue.instance_location;
              return (
                <li key={`${issue.source}-${issue.code}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(active ? null : issue.instance_location)}
                    disabled={!issue.instance_location}
                    aria-pressed={active}
                    className={`w-full rounded-[3px] border bg-surface p-[8px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                      active ? "border-accent" : "border-line hover:border-line-strong"
                    }`}
                    data-testid={`validate-panel-row-${index}`}
                  >
                    <FindingRow issue={issue} index={index} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** One finding, as the server described it: source, code, the milestone a
 * deferred kind names, the message, the pointer and the hint. */
function FindingRow({ issue, index }: { issue: ValidationIssue; index: number }) {
  const milestone = issue.code === "kind_not_implemented" ? milestoneOf(issue) : null;
  return (
    <>
      <span className="flex flex-wrap items-center gap-[6px]">
        <StatusChip
          state={stateOf(VALIDATION_SOURCE_STATE[issue.source])}
          label={issue.source}
          labelProps={{ "data-testid": `validate-panel-source-${index}` }}
        />
        <span
          className="font-mono text-[11px] font-semibold"
          data-testid={`validate-panel-code-${index}`}
        >
          {issue.code}
        </span>
        {milestone ? (
          <span
            className="font-mono text-[10px] text-accent-text"
            data-testid={`validate-panel-milestone-${index}`}
          >
            lands in {milestone}
          </span>
        ) : null}
      </span>
      <span
        className="mt-[3px] block text-[12.5px] leading-[18px]"
        data-testid={`validate-panel-message-${index}`}
      >
        {issue.message}
        {issue.code === "secret_literal_detected" ? (
          // Only the server's redacted words are shown — the textarea's raw
          // value is never re-read into a row (ADR-0021 Security invariant 5).
          <span className="text-faint" data-testid={`validate-panel-redacted-${index}`}>
            {" "}
            <span
              className="mx-[3px] inline-block h-[13px] w-[72px] translate-y-[2px] rounded-[2px] bg-redacted-fill align-middle"
              role="img"
              aria-label="value never shown"
              title="value never shown"
            />
            value never shown
          </span>
        ) : null}
      </span>
      <span className="mt-[3px] flex flex-col font-mono text-[10.5px] text-ink-2">
        <span className="flex gap-[6px]">
          <span className="text-muted">instance</span>
          <span data-testid={`validate-panel-location-${index}`}>
            {issue.instance_location ?? "no location served"}
          </span>
        </span>
        {issue.schema_location ? (
          <span className="flex gap-[6px]">
            <span className="text-muted">schema</span>
            <span>{issue.schema_location}</span>
          </span>
        ) : null}
      </span>
      {issue.hint ? (
        <span
          className="mt-[3px] block text-[12.5px] text-ink-2"
          data-testid={`validate-panel-hint-${index}`}
        >
          <span className="font-mono text-[10.5px] text-muted">hint</span> {issue.hint}
        </span>
      ) : null}
    </>
  );
}

/** loader → schema → compiler, server order kept inside each group. */
function orderSources(errors: ValidationIssue[]): Record<string, ValidationIssue[]> {
  const grouped: Record<string, ValidationIssue[]> = { loader: [], schema: [], compiler: [] };
  for (const issue of errors) {
    (grouped[issue.source] ?? (grouped[issue.source] = [])).push(issue);
  }
  return grouped;
}

/** The milestone a `kind_not_implemented` names — read off the response, never
 * a UI-side table that could drift from ADR-0024. */
function milestoneOf(issue: ValidationIssue): string | null {
  const text = `${issue.message} ${issue.hint ?? ""}`;
  return MILESTONE_IN_TEXT.exec(text)?.[1] ?? null;
}
