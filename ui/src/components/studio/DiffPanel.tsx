/**
 * The readable semantic diff a Studio review shows before publication:
 * the published revision's `canonical_document` (JSON) against the draft's
 * YAML text, computed by `semanticDiff` — the server has no diff route.
 *
 * The panel never renders raw YAML as a diff: nodes are matched by id and
 * grouped Added / Removed / Changed / Moved, each row expandable to its field
 * before/afters; long strings (over 80 characters) get a small line diff with
 * `-`/`+` prefixes instead of one unreadable wall. `metadata.ui` never shows
 * here — a layout-only draft reads "only layout moved".
 */
import { useMemo, useState } from "react";
import { parse } from "yaml";
import { kindWord } from "../../lib/pipeline/definition";
import { semanticDiff, type DiffResult, type FieldChange } from "../../lib/pipeline/semanticDiff";

export interface DiffPanelProps {
  /** The newest published revision's `canonical_document`, or `null`. */
  baseDocument: unknown | null;
  /** The draft's YAML text. */
  text: string;
  className?: string;
}

const GROUPS: { label: string; change: "added" | "removed" | "changed" | "moved" }[] = [
  { label: "Added", change: "added" },
  { label: "Removed", change: "removed" },
  { label: "Changed", change: "changed" },
  { label: "Moved", change: "moved" },
];

// Text on the light surface/fill rows must use the tag fg tokens: the
// *-strong-fg tokens are white (fg *for* the strong bars) and would render
// at ~1:1 here (WCAG 1.4.3).
const CHANGE_WORD_COLOR: Record<string, string> = {
  added: "text-st-done-tag-fg",
  removed: "text-st-failed-tag-fg",
  changed: "text-ink",
  moved: "text-ink-2",
};

function displayValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

interface LineEntry {
  type: "same" | "del" | "add";
  text: string;
}

/** A smallest common-subsequence line diff, for strings too long for one row. */
function lineDiff(before: string, after: string): LineEntry[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: LineEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j += 1;
  }
  return out;
}

/** One field before/after; long strings collapse into the `-`/`+` line diff. */
function FieldRow({ field }: { field: FieldChange }) {
  const long =
    typeof field.before === "string" &&
    typeof field.after === "string" &&
    (field.before.length > 80 || field.after.length > 80);
  return (
    <div className="border-t border-line-soft px-[10px] py-[6px]">
      <div className="font-mono text-[10.5px] text-ink-2">{field.path}</div>
      {long ? (
        <div className="mt-[4px] font-mono text-[10.5px] leading-[1.5]">
          {lineDiff(field.before as string, field.after as string).map((entry, index) => (
            <div
              key={index}
              data-testid="diff-line"
              className={
                entry.type === "del"
                  ? "text-st-failed-tag-fg"
                  : entry.type === "add"
                    ? "text-st-done-tag-fg"
                    : "text-faint"
              }
            >
              {entry.type === "del" ? "- " : entry.type === "add" ? "+ " : "  "}
              {entry.text}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-[2px] text-[11.5px]">
          <span className="text-faint line-through">{displayValue(field.before)}</span>
          <span className="mx-[6px] text-faint">→</span>
          <span className="text-ink">{displayValue(field.after)}</span>
        </div>
      )}
    </div>
  );
}

export function DiffPanel({ baseDocument, text, className = "" }: DiffPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const parsed = useMemo<{ ok: boolean; document: unknown }>(() => {
    try {
      return { ok: true, document: parse(text) };
    } catch {
      return { ok: false, document: undefined };
    }
  }, [text]);

  const diff: DiffResult | null = useMemo(
    () => (baseDocument == null || !parsed.ok ? null : semanticDiff(baseDocument, parsed.document)),
    [baseDocument, parsed],
  );

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rowClass = "flex w-full items-center gap-[6px] px-[10px] py-[5px] text-left text-[11.5px]";

  return (
    <section
      data-testid="diff-panel"
      className={`overflow-hidden rounded-[3px] border border-line-strong bg-surface ${className}`}
    >
      <div className="flex items-center border-b border-line-strong bg-fill px-[10px] py-1 font-mono text-[10px] leading-[1.4] font-semibold tracking-[.04em] text-ink-2">
        DIFF
      </div>

      {!parsed.ok ? (
        <p data-testid="diff-invalid" className="p-[10px] text-[12.5px] text-st-failed-tag-fg">
          Fix the YAML errors to see the diff
        </p>
      ) : baseDocument == null ? (
        <p data-testid="diff-empty" className="p-[10px] text-[12.5px] text-muted">
          No published revision yet — everything is new
        </p>
      ) : diff && diff.empty ? (
        <p data-testid="diff-empty" className="p-[10px] text-[12.5px] text-muted">
          No semantic changes
        </p>
      ) : diff && diff.layoutOnly ? (
        <p data-testid="diff-empty" className="p-[10px] text-[12.5px] text-muted">
          only layout moved
        </p>
      ) : (
        <div className="max-h-[400px] overflow-y-auto">
          {diff?.nodes.length === 0 ? null : (
            <div>
              {GROUPS.map((group) => {
                const rows = (diff?.nodes ?? []).filter((node) => node.change === group.change);
                if (rows.length === 0) return null;
                return (
                  <div key={group.change}>
                    <div className="bg-fill px-[10px] py-[3px] font-mono text-[9.5px] font-semibold tracking-[.06em] text-muted uppercase">
                      {group.label}
                    </div>
                    {rows.map((node) => (
                      <div key={node.id}>
                        <button
                          type="button"
                          aria-expanded={expanded.has(node.id)}
                          data-testid={`diff-node-${node.id}`}
                          onClick={() => toggle(node.id)}
                          className={rowClass}
                        >
                          <span className="w-[12px] text-center font-mono text-[10px] text-faint">
                            {expanded.has(node.id) ? "▾" : "▸"}
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-ink">
                            {node.id}
                          </span>
                          {node.scope !== "" ? (
                            <span className="font-mono text-[10px] text-muted">
                              in {node.scope}
                            </span>
                          ) : null}
                          <span className="ml-auto font-mono text-[10px] text-faint">
                            {kindWord(node.kind)}
                          </span>
                          <span
                            className={`font-mono text-[10px] font-semibold ${CHANGE_WORD_COLOR[node.change]}`}
                          >
                            {node.change}
                          </span>
                        </button>
                        {expanded.has(node.id) &&
                          (node.fields.length === 0 ? (
                            <div className="border-t border-line-soft px-[10px] py-[6px] text-[11px] text-faint">
                              {node.change === "added"
                                ? "New node — nothing to compare."
                                : "No field changes to show."}
                            </div>
                          ) : (
                            <div>
                              {node.fields.map((field) => (
                                <FieldRow key={field.path} field={field} />
                              ))}
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {diff?.edges.length === 0 ? null : (
            <div>
              <div className="bg-fill px-[10px] py-[3px] font-mono text-[9.5px] font-semibold tracking-[.06em] text-muted uppercase">
                Edges
              </div>
              {(diff?.edges ?? []).map((edge) => (
                <div
                  key={`${edge.change}-${edge.from}-${edge.to}`}
                  className="flex items-center gap-[6px] border-t border-line-soft px-[10px] py-[5px] text-[11.5px]"
                >
                  <span className="font-mono text-[11px] text-ink">
                    {edge.from} → {edge.to}
                  </span>
                  <span
                    className={`ml-auto font-mono text-[10px] font-semibold ${CHANGE_WORD_COLOR[edge.change]}`}
                  >
                    {edge.change}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diff?.pipeline.length === 0 ? null : (
            <div>
              <div className="bg-fill px-[10px] py-[3px] font-mono text-[9.5px] font-semibold tracking-[.06em] text-muted uppercase">
                Pipeline
              </div>
              {(diff?.pipeline ?? []).map((change) => (
                <FieldRow key={change.path} field={change} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
