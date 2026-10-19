/**
 * StepOutline — the <1024px fallback of the Studio canvas (design doc §9):
 * no canvas, an indented list of the steps by scope, each row a button that
 * selects the node, with a "+ Add step after" that opens the same StepPicker
 * every canvas "+" opens. The scope indentation IS the graph: `model.nodes`
 * is DFS preorder with the scope before its body, so depth comes from the
 * scope path length.
 *
 * Multi-select: a checkbox per step builds the same `selectedIds` the
 * canvas' Shift+click / Shift+drag box build, and the SelectionToolbar
 * (variant "outline") above the list offers the wrap/unwrap actions so
 * keyboard / narrow users never need a pointer.
 */
import { useState } from "react";
import { scopeKey, type GraphModel, type ScopePath } from "../../lib/pipeline/graphDoc";
import { StepPicker } from "./StepPicker";
import { SelectionToolbar, type ScopeKind } from "./SelectionToolbar";

export interface StepOutlineProps {
  model: GraphModel;
  selectedId: string | null;
  /** The canvas' multi-selection (empty/absent = single-select mode). */
  selectedIds?: string[];
  /** Toggle one step in the multi-selection. */
  onToggleSelect?(id: string): void;
  readOnly: boolean;
  onSelect(id: string | null): void;
  onAddAfter(afterId: string | null, scope: ScopePath, kind: string): void;
  onWrap?(kind: ScopeKind): void;
  onUnwrap?(scopeId: string): void;
}

export function StepOutline({
  model,
  selectedId,
  selectedIds,
  onToggleSelect,
  readOnly,
  onSelect,
  onAddAfter,
  onWrap,
  onUnwrap,
}: StepOutlineProps) {
  // Which "+" is open: a node's trailing insert, or the root-level "add step".
  const [picker, setPicker] = useState<string | null>(null);
  const multi = selectedIds ?? [];

  return (
    <section className="min-w-0" aria-label="Steps" data-testid="step-outline">
      <SelectionToolbar
        variant="outline"
        selectedIds={multi}
        model={model}
        readOnly={readOnly}
        onWrap={onWrap}
        onUnwrap={onUnwrap}
      />
      <ol className="space-y-[2px]" data-testid="step-outline-list">
        {model.nodes.map((node) => (
          <li key={`${scopeKey(node.scope)}:${node.id}`} className="flex items-center gap-[6px]">
            <input
              type="checkbox"
              checked={multi.includes(node.id)}
              onChange={() => onToggleSelect?.(node.id)}
              disabled={readOnly || onToggleSelect === undefined}
              aria-label={`Select ${node.id}`}
              className="h-3.5 w-3.5 accent-current"
              data-testid={`step-outline-select-${node.id}`}
            />
            <button
              type="button"
              onClick={() => onSelect(selectedId === node.id ? null : node.id)}
              aria-current={selectedId === node.id ? "true" : undefined}
              style={{ paddingLeft: `${node.scope.length * 14}px` }}
              className={`flex min-w-0 flex-1 items-baseline gap-[6px] rounded-[3px] px-[6px] py-[3px] text-left ${
                selectedId === node.id || multi.includes(node.id)
                  ? "bg-accent-wash"
                  : "hover:bg-fill"
              }`}
              data-testid={`step-outline-${node.id}`}
            >
              <span className="text-[12.5px] font-semibold">{node.label}</span>
              <span className="font-mono text-[10px] text-faint">{node.id}</span>
              {node.isScope ? (
                <span className="font-mono text-[10px] text-faint">{node.kind}</span>
              ) : null}
            </button>
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => setPicker(node.id)}
                aria-label={`Add a step after ${node.id}`}
                className="rounded-[3px] border border-line px-[6px] font-mono text-[11px] text-muted hover:bg-fill"
                data-testid={`step-outline-add-${node.id}`}
              >
                +
              </button>
            )}
          </li>
        ))}
      </ol>
      {readOnly || model.nodes.length > 0 ? null : (
        <p
          className="px-[6px] py-[4px] font-mono text-[11px] text-faint"
          data-testid="step-outline-empty"
        >
          no steps yet
        </p>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={() => setPicker("root")}
          className="mt-[6px] rounded-[3px] border border-line px-[8px] py-[3px] font-mono text-[11px] text-muted hover:bg-fill"
          data-testid="step-outline-add-root"
        >
          + Add step
        </button>
      )}
      {picker !== null && !readOnly ? (
        <StepPicker
          title={picker === "root" ? "Add a step" : `Add a step after ${picker}`}
          onPick={(kind) => {
            const node = model.nodes.find((n) => n.id === picker) ?? null;
            onAddAfter(node ? node.id : null, node?.scope ?? [], kind);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </section>
  );
}
