/**
 * The workbench's runtime-instance selectors (ADR-0043 decision 1): the
 * definition graph never draws a loop's iterations or a fan-out's items as
 * extra nodes — the person picks which one the dock opens, here.
 *
 * `until` gets one chip per observed iteration ("Iteration 2 · failed");
 * `for_each` gets a paged, state-filterable item list with counts, because a
 * fan-out over 25 items is not a chip row. Every row reads through the
 * journal's own `node_executions` rows: the state is a roll-up of the rows
 * under that instance, in the same precedence the scope box uses.
 */
import { useMemo, useState } from "react";
import { NODE_EXECUTION_STATE, STATES, type StateName } from "../ds/states";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";

/** One selectable instance of a scope, derived from the journal rows. */
export interface ScopeInstanceView {
  /** 1-based iteration/item index. */
  index: number;
  /** The instance key `/scope[2]`. */
  key: string;
  state: StateName;
  /** The state set's word: "failed", "running", "done", … */
  label: string;
}

/** The roll-up precedence — the same order `workbench.ts` and `branches.ts`
 * use, so a chip and the box never disagree about who needs a person first. */
const PRECEDENCE: readonly StateName[] = [
  "failed",
  "waiting",
  "interrupted",
  "retrying",
  "running",
  "queued",
  "done",
  "info",
];

/**
 * The journal's instances of one scope, 1-based and sorted. A row belongs to
 * instance *n* when its key is `${defKey}[n]` (the scope's own place row) or
 * starts with `${defKey}[n]/` (a body row inside the iteration). Rows the
 * journal names under the scope but outside every iteration are not
 * instances — they are skipped rather than folded into a wrong index.
 */
export function scopeInstances(
  nodes: readonly NodeExecutionSummary[],
  defKey: string,
): ScopeInstanceView[] {
  const prefix = `${defKey}[`;
  const per = new Map<number, StateName[]>();
  for (const row of nodes) {
    if (!row.node_instance_key.startsWith(prefix)) continue;
    const match = /^(\d+)\](\/|$)/.exec(row.node_instance_key.slice(prefix.length));
    if (!match) continue;
    const index = Number(match[1]);
    const states = per.get(index) ?? [];
    states.push(NODE_EXECUTION_STATE[row.status] ?? "queued");
    per.set(index, states);
  }
  return [...per.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, states]) => {
      const state = PRECEDENCE.find((candidate) => states.includes(candidate)) ?? "queued";
      return { index, key: `${defKey}[${index}]`, state, label: STATES[state].word };
    });
}

/** The states a `for_each` list can be filtered on, in precedence order. */
function filterStates(instances: readonly ScopeInstanceView[]): StateName[] {
  return PRECEDENCE.filter((state) => instances.some((instance) => instance.state === state));
}

const PAGE_SIZE = 20;

export interface InstancePickerProps {
  /** The scope's definition node id (the testid key). */
  scopeId: string;
  /** The scope's definition key, `/scope[/inner]` (the `[n]`-less row key). */
  defKey: string;
  kind: "until" | "for_each";
  instances: ScopeInstanceView[];
  /** The index the URL selection resolves to, or null (latest / aggregate). */
  selected: number | null;
  onSelect: (index: number | null) => void;
}

/**
 * One scope's selector row. `until`: iteration chips. `for_each`: a paged
 * item list with a state filter and the live counts. Selecting clears a
 * chip's press by picking it again (the box goes back to "latest" / the
 * aggregate), so `onSelect(null)` is a first-class act, not a bug.
 */
export function InstancePicker({
  scopeId,
  kind,
  instances,
  selected,
  onSelect,
}: InstancePickerProps) {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<StateName | "all">("all");
  const states = useMemo(() => filterStates(instances), [instances]);
  const visible = useMemo(
    () => (filter === "all" ? instances : instances.filter((i) => i.state === filter)),
    [instances, filter],
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const clamped = Math.min(page, pages - 1);
  const slice = visible.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE);

  const pick = (index: number) => onSelect(selected === index ? null : index);

  const chip = (index: number, word: string) => {
    const pressed = selected === index;
    return (
      <button
        key={index}
        type="button"
        aria-pressed={pressed}
        data-testid={`instance-${scopeId}-${index}`}
        onClick={() => pick(index)}
        className={`rounded-[3px] border px-2 py-[3px] font-mono text-[11px] ${
          pressed
            ? "border-ink bg-ink text-paper"
            : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
        } focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
      >
        {word} {index} · {instanceWordAt(instances, index)}
      </button>
    );
  };

  if (kind === "until") {
    return (
      <div
        className="flex flex-wrap items-center gap-[6px]"
        data-testid={`instance-picker-${scopeId}`}
      >
        <span className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
          {scopeId} · iteration
        </span>
        {instances.map((instance) => chip(instance.index, "Iteration"))}
        {selected !== null ? (
          <button
            type="button"
            data-testid={`instance-${scopeId}-latest`}
            onClick={() => onSelect(null)}
            className="rounded-[3px] border border-line px-2 py-[3px] font-mono text-[11px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            latest
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-b border-line pb-[6px]" data-testid={`instance-picker-${scopeId}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
          {scopeId} · {instances.length} items
        </span>
        {states.map((state) => (
          <span key={state} className="font-mono text-[10.5px] text-muted">
            {instances.filter((i) => i.state === state).length} {STATES[state].glyph}{" "}
            {STATES[state].word}
          </span>
        ))}
        <label className="ml-auto flex items-center gap-1 font-mono text-[10.5px] text-muted">
          state
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as StateName | "all");
              setPage(0);
            }}
            className="rounded-[3px] border border-line bg-paper px-1 py-[2px] font-mono text-[10.5px] text-ink"
          >
            <option value="all">all</option>
            {states.map((state) => (
              <option key={state} value={state}>
                {STATES[state].word}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-[6px] flex flex-wrap gap-[6px]">
        {slice.map((instance) => chip(instance.index, "Item"))}
        {pages > 1 ? (
          <div className="flex items-center gap-[6px] font-mono text-[10.5px] text-muted">
            <button
              type="button"
              disabled={clamped === 0}
              data-testid={`instance-${scopeId}-prev`}
              onClick={() => setPage(Math.max(0, clamped - 1))}
              className="rounded-[3px] border border-line px-2 py-[3px] disabled:text-faint"
            >
              prev
            </button>
            <span data-testid={`instance-${scopeId}-page`}>
              {clamped + 1} of {pages}
            </span>
            <button
              type="button"
              disabled={clamped === pages - 1}
              data-testid={`instance-${scopeId}-next`}
              onClick={() => setPage(Math.min(pages - 1, clamped + 1))}
              className="rounded-[3px] border border-line px-2 py-[3px] disabled:text-faint"
            >
              next
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function instanceWordAt(instances: readonly ScopeInstanceView[], index: number): string {
  return instances.find((instance) => instance.index === index)?.label ?? "not started";
}
