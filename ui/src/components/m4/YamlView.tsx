/**
 * The YAML view — read-only by decision. This shows text and lands findings
 * on it; it does not accept keystrokes. Authoring happens in `DraftEditor`
 * (a textarea on a draft): a published revision is immutable, so the only
 * edit path is draft → validate → publish as a new revision. The W8 case
 * pastes into a *validate panel*, which is a different component with a
 * button on it, not this one.
 *
 * Validation findings carry a JSON pointer (`instance_location`);
 * `lib/pipeline/yamlPointer` resolves it to a line, and where the pointer sits
 * inside flow-style content the resolution is deliberately *inexact* and the
 * finding says so, because a marker on the wrong line is worse than none.
 */
import { useMemo, useState } from "react";
import type { ValidateBody, ValidationIssue } from "../../lib/pipeline/contract";
import { indexPointers, resolvePointer } from "../../lib/pipeline/yamlPointer";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { VALIDATION_SOURCE_STATE, stateOf } from "../ds/states";

/** Lines rendered before the "show more" affordance: a 200 KB document must
 * not put 6,000 nodes in the DOM to show a finding on line 40. */
const LINE_WINDOW = 220;

export interface YamlViewProps {
  /** The document text — `document_text` from a revision, `document_yaml` from
   * a draft, or the regenerated canonical export. */
  text: string;
  /** Identity line for the bar: `revision 7 · sha256:3f2f6e… (canonical)`. */
  label?: string;
  /** Server findings to mark, in the server's order. */
  validation?: ValidateBody | null;
  /** A node selected elsewhere (the graph) highlights its block here. */
  highlightPointer?: string | null;
  /** Called with the pointer of a line the reader clicked, so a parent can
   * select the matching graph node. */
  onSelectPointer?: (pointer: string) => void;
  headingId?: string;
  className?: string;
}

export function YamlView({
  text,
  label,
  validation,
  highlightPointer = null,
  onSelectPointer,
  headingId = "yaml-view-heading",
  className = "",
}: YamlViewProps) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const pointers = useMemo(() => indexPointers(text), [text]);
  const [visible, setVisible] = useState(LINE_WINDOW);

  const findings = useMemo(
    () =>
      (validation?.errors ?? []).map((issue, index) => ({
        issue,
        index,
        location: resolvePointer(text, issue.instance_location),
      })),
    [validation, text],
  );
  const markedLines = new Map<number, ValidationIssue[]>();
  for (const finding of findings) {
    if (!finding.location) continue;
    const list = markedLines.get(finding.location.line) ?? [];
    list.push(finding.issue);
    markedLines.set(finding.location.line, list);
  }

  const highlightRange = useMemo(
    () => (highlightPointer ? blockRange(lines, pointers, highlightPointer) : null),
    [highlightPointer, lines, pointers],
  );

  return (
    <Panel
      title="YAML (READ-ONLY)"
      headingId={headingId}
      headingLevel={2}
      state={validation && !validation.valid ? "failed" : undefined}
      meta={
        label ? (
          <span className="font-mono text-[10.5px]" data-testid="yaml-view-label">
            {label}
          </span>
        ) : undefined
      }
      className={className}
    >
      <div className="grid items-start gap-[10px] p-[10px] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          {/* A code block, not an editor: no role="textbox", no tabIndex on the
              pre, so nothing pretends to be editable. Scroll is on the region. */}
          <pre
            data-testid="yaml-view"
            aria-label={label ? `Pipeline document: ${label}` : "Pipeline document"}
            className="max-h-[460px] overflow-auto rounded-[3px] border border-line bg-surface font-mono text-[11.5px] leading-[17px]"
          >
            <code>
              {lines.slice(0, visible).map((line, index) => {
                const number = index + 1;
                const issues = markedLines.get(number);
                const highlighted =
                  highlightRange !== null &&
                  number >= highlightRange.from &&
                  number <= highlightRange.to;
                return (
                  <span
                    key={number}
                    data-testid={`yaml-line-${number}`}
                    className={`flex ${issues ? "bg-st-failed-pale-body" : highlighted ? "bg-accent-wash" : ""}`}
                  >
                    <span
                      aria-hidden
                      className="sticky left-0 w-[3.5rem] shrink-0 select-none border-r border-line bg-fill px-[6px] text-right text-[10.5px] text-muted"
                    >
                      {number}
                    </span>
                    <span
                      className={`px-[8px] whitespace-pre ${issues ? "border-l-2 border-l-st-failed-strong" : highlighted ? "border-l-2 border-l-accent" : "border-l-2 border-l-transparent"}`}
                    >
                      {line === "" ? "\u00a0" : line}
                    </span>
                    {issues ? (
                      <span
                        className="ml-auto shrink-0 px-[8px] font-mono text-[10px] text-st-failed-tag-fg"
                        data-testid={`yaml-error-marker-${issues.map((issue) => issue.code).join(",")}`}
                      >
                        × {issues.map((issue) => issue.code).join(", ")}
                      </span>
                    ) : null}
                    {onSelectPointer ? (
                      <PointerButton
                        pointer={pointerAtLine(pointers, number)}
                        onSelect={onSelectPointer}
                      />
                    ) : null}
                  </span>
                );
              })}
            </code>
          </pre>
          {visible < lines.length ? (
            <button
              type="button"
              onClick={() => setVisible((current) => current + LINE_WINDOW)}
              className="mt-[6px] font-mono text-[11px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid="yaml-view-more"
            >
              show {Math.min(LINE_WINDOW, lines.length - visible)} more of {lines.length} lines
            </button>
          ) : null}
          <p
            className="mt-[6px] font-mono text-[10.5px] text-faint"
            data-testid="yaml-view-readonly-note"
          >
            read-only: a published revision is immutable — edits go through a draft, which publishes
            as a new revision.
          </p>
        </div>
        <ValidationFindings validation={validation} findings={findings} />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- fragments */

function PointerButton({
  pointer,
  onSelect,
}: {
  pointer: string | null;
  onSelect: (pointer: string) => void;
}) {
  if (!pointer) return null;
  return (
    <button
      type="button"
      className="sr-only"
      onClick={() => onSelect(pointer)}
      data-testid="yaml-line-pointer"
    >
      select the node defined on this line ({pointer})
    </button>
  );
}

/** Findings grouped by the three sources, in the server's order, never merged:
 * `source` is what tells a reader whether the YAML, the schema or the compiler
 * refused, and the fix differs per source. */
function ValidationFindings({
  validation,
  findings,
}: {
  validation: ValidateBody | null | undefined;
  findings: {
    issue: ValidationIssue;
    index: number;
    location: ReturnType<typeof resolvePointer>;
  }[];
}) {
  if (!validation) {
    return (
      <div
        className="rounded-[3px] border border-line bg-surface p-[10px]"
        data-testid="yaml-validation-none"
      >
        <p className="text-[12.5px] text-muted">
          No validate body has been served for this document, so nothing is marked. Findings appear
          here after <span className="font-mono">POST /drafts/{"{id}"}/validate</span>.
        </p>
      </div>
    );
  }
  const grouped: Record<string, typeof findings> = { loader: [], schema: [], compiler: [] };
  for (const finding of findings) {
    (grouped[finding.issue.source] ?? (grouped[finding.issue.source] = [])).push(finding);
  }
  return (
    <div className="space-y-[8px]">
      <div className="flex flex-wrap items-center gap-[6px]">
        {validation.valid ? (
          <StatusChip
            state="done"
            label="valid"
            labelProps={{ "data-testid": "yaml-validation-verdict" }}
          />
        ) : (
          <StatusChip
            state="failed"
            label={`${validation.errors.length} findings`}
            labelProps={{ "data-testid": "yaml-validation-verdict" }}
          />
        )}
        {(["loader", "schema", "compiler"] as const).map((source) => (
          <span
            key={source}
            className="font-mono text-[10.5px] text-muted"
            data-testid={`yaml-validation-tally-${source}`}
          >
            {source} {grouped[source]?.length ?? 0}
          </span>
        ))}
      </div>
      <ul className="space-y-[6px]" data-testid="yaml-validation-errors">
        {findings.map(({ issue, index, location }) => (
          <li
            key={`${issue.code}-${index}`}
            data-testid={`yaml-finding-${index}`}
            className="rounded-[3px] border border-line bg-surface p-[8px]"
          >
            <div className="flex flex-wrap items-center gap-[6px]">
              <StatusChip
                state={stateOf(VALIDATION_SOURCE_STATE[issue.source])}
                label={issue.source}
                labelProps={{ "data-testid": `yaml-finding-source-${index}` }}
              />
              <span className="font-mono text-[11px] font-semibold">{issue.code}</span>
              <span className="ml-auto font-mono text-[10.5px] text-faint">
                {location
                  ? `line ${location.line}${location.exact ? "" : " (closest)"}`
                  : "no location served"}
              </span>
            </div>
            <p
              className="mt-[3px] text-[12.5px] leading-[18px]"
              data-testid={`yaml-finding-message-${index}`}
            >
              {issue.code === "secret_literal_detected" ? (
                <SecretLiteralFinding message={issue.message} />
              ) : (
                issue.message
              )}
            </p>
            <dl className="mt-[3px] space-y-[2px] font-mono text-[10.5px] text-ink-2">
              <div className="flex gap-[6px]">
                <dt className="text-muted">instance</dt>
                <dd data-testid={`yaml-finding-location-${index}`}>
                  {issue.instance_location ?? "—"}
                </dd>
              </div>
              {issue.schema_location ? (
                <div className="flex gap-[6px]">
                  <dt className="text-muted">schema</dt>
                  <dd>{issue.schema_location}</dd>
                </div>
              ) : null}
            </dl>
            {issue.hint ? (
              <p
                className="mt-[3px] text-[12.5px] text-ink-2"
                data-testid={`yaml-finding-hint-${index}`}
              >
                <span className="font-mono text-[10.5px] text-muted">hint</span> {issue.hint}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {validation.notes.map((note, index) => (
        <p
          key={index}
          className="font-mono text-[10.5px] text-faint"
          data-testid={`yaml-validation-note-${index}`}
        >
          i {note}
        </p>
      ))}
    </div>
  );
}

/** A secret-literal finding shows the *shape*, never the value: the server
 * already redacts, and re-quoting it here would undo that (ADR-0021 Security).
 * The words are visible, not only an aria-label — `docs/design/design-system.md`
 * requires a redacted block to be "always accompanied by the words 'value never
 * shown'", because a bar alone reads as a render that failed to load. */
function SecretLiteralFinding({ message }: { message: string }) {
  return (
    <span>
      {message}{" "}
      <span
        className="ml-[3px] inline-block h-[13px] w-[72px] translate-y-[2px] rounded-[2px] bg-redacted-fill align-middle"
        role="img"
        aria-label="value never shown"
        data-testid="yaml-finding-redacted"
        title="value never shown"
      />
      <span className="text-faint"> value never shown</span>
    </span>
  );
}

/** The pointer whose block starts on this line, if any. */
function pointerAtLine(pointers: Map<string, { line: number }>, line: number): string | null {
  for (const [pointer, location] of pointers) {
    if (location.line === line && pointer.startsWith("/spec/nodes/")) return pointer;
  }
  return null;
}

/** The line block a pointer owns: from its own line to the last line that is
 * more indented than it. Computed from the text, so it matches what a reader
 * sees rather than what a parser believes. */
function blockRange(
  lines: string[],
  pointers: Map<string, { line: number }>,
  pointer: string,
): { from: number; to: number } | null {
  let target: string = pointer;
  let start: number | undefined;
  while (target && start === undefined) {
    start = pointers.get(target)?.line;
    if (!start) target = target.slice(0, target.lastIndexOf("/"));
  }
  if (!start) return null;
  const indent = lines[start - 1].length - lines[start - 1].trimStart().length;
  let to = start;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    to = index + 1;
  }
  return { from: start, to };
}
