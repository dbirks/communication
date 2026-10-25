/**
 * Small field widgets for the Studio inspector (ADR-0042 § 3.3).
 *
 * Every widget is commit-based: text and JSON commit on blur (single-line
 * fields also on Enter), never on every keystroke, so the textarea's document
 * only moves when the user is done with a field. Number widgets validate
 * against the schema's minimum/maximum before the value leaves the widget.
 */
import { useEffect, useState } from "react";
import { Button } from "../ds/Button";
import { Field, Input, Select, Textarea } from "../ds/Field";

export interface CommitProps {
  value: unknown;
  readOnly: boolean;
  onCommit: (value: unknown) => void;
}

/** Show a scalar the way the YAML document carries it. */
function show(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** A single-line text field committing on blur or Enter. */
export function TextField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
  mono = false,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  const current = show(value);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  return (
    <Field id={id} label={label} hint={hint}>
      <Input
        id={id}
        className={mono ? "font-mono" : undefined}
        disabled={readOnly}
        value={draft}
        placeholder={placeholder}
        data-testid={`insp-${id}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== current) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !readOnly && draft !== current) {
            onCommit(draft);
          }
        }}
      />
    </Field>
  );
}

/** A UI-font textarea that grows with its content (design 1g: the prompt /
 * message-content fields are auto-growing textareas, never single-line). */
export function AutoTextareaField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: string) => void;
}) {
  const current = show(value);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const rows = Math.min(10, Math.max(2, Math.ceil(draft.length / 48), draft.split("\n").length));
  return (
    <Field id={id} label={label} hint={hint} className="min-w-0 flex-1">
      <Textarea
        id={id}
        rows={rows}
        // Pass 2 #2/#4: inspector textareas read as values — mono 12px, the
        // ds `font-ui` default overridden inline so the cascade cannot flip.
        style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5 }}
        disabled={readOnly}
        value={draft}
        data-testid={`insp-${id}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== current) onCommit(draft);
        }}
      />
    </Field>
  );
}

/** A multi-line field committing on blur only (Enter belongs to the text). */
export function TextareaField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
  mono = true,
  rows = 4,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: string) => void;
  mono?: boolean;
  rows?: number;
}) {
  const current = show(value);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea
        id={id}
        rows={rows}
        className={mono ? "font-mono" : undefined}
        style={
          mono
            ? { fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5 }
            : { fontSize: 12.5, lineHeight: 1.5 }
        }
        disabled={readOnly}
        value={draft}
        data-testid={`insp-${id}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== current) onCommit(draft);
        }}
      />
    </Field>
  );
}

/** A number validated against the schema's range before committing. */
export function NumberField({
  id,
  label,
  hint,
  readOnly,
  value,
  min,
  max,
  integerOnly = false,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  min?: number;
  max?: number;
  /** The schema type is `integer` (rejects fractions). */
  integerOnly?: boolean;
  onCommit: (value: number | undefined) => void;
}) {
  const current = show(value);
  const [draft, setDraft] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setDraft(current);
    setProblem(null);
  }, [current]);
  const range =
    min !== undefined || max !== undefined ? ` (allowed ${min ?? "…"}–${max ?? "…"})` : "";
  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setProblem(null);
      if (current !== "") onCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setProblem(`${label} must be a number${range}`);
      return;
    }
    if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      setProblem(`${label}: ${parsed} is out of range${range}`);
      return;
    }
    if (integerOnly && !Number.isInteger(parsed)) {
      setProblem(`${label} must be a whole number${range}`);
      return;
    }
    setProblem(null);
    if (show(parsed) !== current) onCommit(parsed);
  }
  return (
    <Field
      id={id}
      label={label + range}
      hint={problem ? <span className="text-st-failed-strong">{problem}</span> : hint}
    >
      <Input
        id={id}
        type="number"
        disabled={readOnly}
        value={draft}
        min={min}
        max={max}
        data-testid={`insp-${id}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </Field>
  );
}

/** A boolean: checkbox, commits the instant the user ticks it. */
export function BoolField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: boolean) => void;
}) {
  const checked = value === true;
  return (
    <Field id={id} label={label} hint={hint}>
      <input
        id={id}
        type="checkbox"
        className="h-[14px] w-[14px]"
        checked={checked}
        disabled={readOnly}
        data-testid={`insp-${id}`}
        onChange={(e) => onCommit(e.target.checked)}
      />
    </Field>
  );
}

/** An enum (or an options list, e.g. sibling node ids) as a select. */
export function SelectField({
  id,
  label,
  hint,
  readOnly,
  value,
  options,
  required = false,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  options: string[];
  required?: boolean;
  onCommit: (value: unknown) => void;
}) {
  const current = show(value);
  return (
    <Field id={id} label={label} hint={hint}>
      <Select
        id={id}
        disabled={readOnly}
        value={current}
        data-testid={`insp-${id}`}
        onChange={(e) => {
          const v = e.target.value;
          onCommit(v === "" ? undefined : v);
        }}
      >
        {!required && <option value="">—</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        {current !== "" && !options.includes(current) ? (
          <option value={current}>{current}</option>
        ) : null}
      </Select>
    </Field>
  );
}

/** A string array as an add/remove list. Commits the whole array. */
export function ListField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: string[]) => void;
}) {
  const source = Array.isArray(value) ? value : [];
  const sourceKey = JSON.stringify(source);
  const [rows, setRows] = useState<string[]>([]);
  useEffect(() => setRows(JSON.parse(sourceKey)), [sourceKey]);
  function commit(next: string[]) {
    setRows(next);
    onCommit(next.filter((row) => row.trim() !== ""));
  }
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="space-y-[4px]" data-testid={`insp-${id}`}>
        {rows.map((row, i) => (
          <div key={i} className="flex gap-[4px]">
            <Input
              className="flex-1 font-mono"
              disabled={readOnly}
              value={row}
              aria-label={`${label} row ${i + 1}`}
              data-testid={`insp-${id}-row-${i}`}
              onChange={(e) => commit(rows.map((r, j) => (j === i ? e.target.value : r)))}
            />
            <Button
              variant="ghost"
              disabled={readOnly}
              data-testid={`insp-${id}-row-${i}-del`}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="secondaryPlain"
          disabled={readOnly}
          data-testid={`insp-${id}-add`}
          onClick={() => commit([...rows, ""])}
        >
          Add
        </Button>
      </div>
    </Field>
  );
}

/**
 * An array of objects as a small row editor (condition cases, model.chat
 * messages, agent context, …). Every cell is one of the small scalar widgets;
 * the parent value is committed as a whole on every cell change.
 */
export function RowsField({
  id,
  label,
  hint,
  readOnly,
  value,
  rowFields,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  rowFields: { key: string; label: string; widget: string; enum?: string[] }[];
  onCommit: (value: Record<string, unknown>[]) => void;
}) {
  const sourceKey = JSON.stringify(Array.isArray(value) ? value : []);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  useEffect(() => setRows(JSON.parse(sourceKey)), [sourceKey]);
  function commit(next: Record<string, unknown>[]) {
    setRows(next);
    onCommit(next);
  }
  function cell(row: Record<string, unknown>, key: string, widget: string) {
    if (widget === "bool") return row[key] === true;
    return show(row[key]);
  }
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="space-y-[6px]" data-testid={`insp-${id}`}>
        {rows.length === 0 ? <p className="font-mono text-[11px] text-faint">no rows yet</p> : null}
        {rows.map((row, i) => (
          <div key={i} className="space-y-[4px] rounded-[3px] border border-line bg-paper p-[6px]">
            <div className="flex gap-[6px]">
              {rowFields.map((rf) => {
                const wid = `insp-${id}-r${i}-${rf.key}`;
                if (rf.widget === "select" && rf.enum) {
                  return (
                    <SelectField
                      key={rf.key}
                      id={wid}
                      label={rf.label}
                      readOnly={readOnly}
                      value={cell(row, rf.key, rf.widget)}
                      options={rf.enum}
                      onCommit={(v) =>
                        commit(rows.map((r, j) => (j === i ? { ...r, [rf.key]: v } : r)))
                      }
                    />
                  );
                }
                if (rf.widget === "number") {
                  return (
                    <NumberField
                      key={rf.key}
                      id={wid}
                      label={rf.label}
                      readOnly={readOnly}
                      value={cell(row, rf.key, rf.widget)}
                      onCommit={(v) =>
                        commit(rows.map((r, j) => (j === i ? { ...r, [rf.key]: v } : r)))
                      }
                    />
                  );
                }
                if (rf.widget === "textarea") {
                  return (
                    <AutoTextareaField
                      key={rf.key}
                      id={wid}
                      label={rf.label}
                      readOnly={readOnly}
                      value={cell(row, rf.key, rf.widget)}
                      onCommit={(v) =>
                        commit(
                          rows.map((r, j) =>
                            j === i ? { ...r, [rf.key]: v === "" ? undefined : v } : r,
                          ),
                        )
                      }
                    />
                  );
                }
                return (
                  <TextField
                    key={rf.key}
                    id={wid}
                    label={rf.label}
                    readOnly={readOnly}
                    mono={rf.widget !== "text"}
                    value={cell(row, rf.key, rf.widget)}
                    onCommit={(v) =>
                      commit(
                        rows.map((r, j) =>
                          j === i ? { ...r, [rf.key]: v === "" ? undefined : v } : r,
                        ),
                      )
                    }
                  />
                );
              })}
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  disabled={readOnly}
                  data-testid={`insp-${id}-row-${i}-del`}
                  onClick={() => commit(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        ))}
        <Button
          variant="secondaryPlain"
          disabled={readOnly}
          data-testid={`insp-${id}-add`}
          onClick={() => {
            const blank: Record<string, unknown> = {};
            for (const rf of rowFields) blank[rf.key] = "";
            commit([...rows, blank]);
          }}
        >
          Add row
        </Button>
      </div>
    </Field>
  );
}

/** A free-key map as a key/value row editor (env, inputs, result bindings). */
export function KvField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: Record<string, unknown>) => void;
}) {
  const sourceKey = JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value) ? value : {},
  );
  const [rows, setRows] = useState<[string, unknown][]>([]);
  useEffect(() => {
    setRows(Object.entries(JSON.parse(sourceKey) as Record<string, unknown>));
  }, [sourceKey]);
  function commit(next: [string, unknown][]) {
    setRows(next);
    const map: Record<string, unknown> = {};
    for (const [k, v] of next) {
      if (k.trim() !== "") map[k] = v;
    }
    onCommit(map);
  }
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="space-y-[4px]" data-testid={`insp-${id}`}>
        {rows.map(([key, v], i) => (
          <div key={i} className="flex gap-[4px]">
            <Input
              className="w-[40%] shrink-0 font-mono"
              disabled={readOnly}
              value={key}
              aria-label={`${label} key, row ${i + 1}`}
              data-testid={`insp-${id}-key-${i}`}
              onChange={(e) =>
                commit(rows.map(([k, vv], j) => (j === i ? [e.target.value, vv] : [k, vv])))
              }
            />
            <Input
              className="flex-1 font-mono"
              disabled={readOnly}
              value={show(v)}
              aria-label={
                key.trim() !== "" ? `${label} value for ${key}` : `${label} value, row ${i + 1}`
              }
              data-testid={`insp-${id}-val-${i}`}
              onChange={(e) =>
                commit(rows.map(([k, vv], j) => (j === i ? [k, e.target.value] : [k, vv])))
              }
            />
            <Button
              variant="ghost"
              disabled={readOnly}
              data-testid={`insp-${id}-row-${i}-del`}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="secondaryPlain"
          disabled={readOnly}
          data-testid={`insp-${id}-add`}
          onClick={() => commit([...rows, ["", ""]])}
        >
          Add
        </Button>
      </div>
    </Field>
  );
}

/**
 * A JSON box for the shapes the generator cannot form (the fallback, never a
 * hidden field): commits a parsed value on blur, refuses invalid JSON inline.
 */
export function JsonField({
  id,
  label,
  hint,
  readOnly,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  readOnly: boolean;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const sourceKey = value === null || value === undefined ? "null" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(sourceKey === "null" ? "" : sourceKey);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setDraft(sourceKey === "null" ? "" : sourceKey);
    setProblem(null);
  }, [sourceKey]);
  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setProblem(null);
      onCommit(undefined);
      return;
    }
    try {
      setProblem(null);
      onCommit(JSON.parse(trimmed));
    } catch (e) {
      setProblem(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return (
    <Field
      id={id}
      label={label}
      hint={problem ? <span className="text-st-failed-strong">{problem}</span> : hint}
    >
      <Textarea
        id={id}
        rows={Math.min(10, Math.max(3, draft.split("\n").length))}
        className="font-mono"
        style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5 }}
        disabled={readOnly}
        value={draft}
        data-testid={`insp-${id}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </Field>
  );
}

/** Read-only chip list. */
function Chips({ id, items, note }: { id: string; items: string[]; note: string }) {
  return (
    <Field id={id} label="—" hint={note}>
      <div className="flex flex-wrap gap-[4px]" data-testid={`insp-${id}`}>
        {items.length === 0 ? (
          <span className="font-mono text-[11px] text-faint">none</span>
        ) : (
          items.map((item) => (
            <span
              key={item}
              className="rounded-[2px] border border-line bg-surface px-[5px] py-[1px] font-mono text-[11px] text-muted"
            >
              {item}
            </span>
          ))
        )}
      </div>
    </Field>
  );
}

/**
 * `dependsOn` as read-only chips — edges are drawn and edited on the canvas,
 * never in the inspector (ADR-0042 § 4).
 */
export function DepsChips({ id, value }: { id: string; value: string[] }) {
  return <Chips id={id} items={value} note="run after — edges are edited on the canvas" />;
}

/** The scope's inner steps as read-only chips; they are edited on the canvas. */
export function StepsList({ id, value }: { id: string; value: string[] }) {
  return <Chips id={id} items={value} note="steps inside — edited on the canvas" />;
}
