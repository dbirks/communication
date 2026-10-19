/**
 * SelectionToolbar — the step-selection actions of the Workflow Studio
 * (design doc §4): wrap the selected sibling steps in a bounded "Repeat
 * until" or "For each" scope, or unwrap a single selected repeat scope.
 *
 * Three placement variants share the same behaviour:
 *  - "toolbar"  — the floating bar above the canvas (data-testid=
 *    selection-toolbar, shown when ≥1 step is selected);
 *  - "panel"    — the multi-select inspector panel (the canvas' ring is
 *    not always reachable: keyboard users, focus traps);
 *  - "outline"  — the narrow <1024px StepOutline fallback, where pointer
 *    selection is the checkboxes' job.
 *
 * The actual YAML edits are graphDoc's wrapInScope / unwrapScope text ops,
 * applied through useStudioDraft.apply (so undo/redo cover them). This
 * component only knows the model (to decide when Unwrap applies) and the
 * callbacks; refusal sentences surface in the page's op-error region.
 */
import type { GraphModel } from "../../lib/pipeline/graphDoc";
import { Button } from "../ds/Button";

export type ScopeKind = "until" | "for_each";

export interface SelectionToolbarProps {
  selectedIds: string[];
  model: GraphModel;
  readOnly?: boolean;
  onWrap?: (kind: ScopeKind) => void;
  onUnwrap?: (scopeId: string) => void;
  variant?: "toolbar" | "panel" | "outline";
}

const TESTIDS = {
  toolbar: {
    box: "selection-toolbar",
    wrapUntil: "wrap-until",
    wrapForEach: "wrap-for-each",
    unwrap: "unwrap-scope",
  },
  panel: {
    box: "multi-selection-actions",
    wrapUntil: "multi-wrap-until",
    wrapForEach: "multi-wrap-for-each",
    unwrap: "multi-unwrap-scope",
  },
  outline: {
    box: "outline-selection-actions",
    wrapUntil: "outline-wrap-until",
    wrapForEach: "outline-wrap-for-each",
    unwrap: "outline-unwrap-scope",
  },
} as const;

/** Unwrap applies to a single selected node that is a repeat scope. */
export function unwrapTargetOf(model: GraphModel, selectedIds: string[]): string | null {
  if (selectedIds.length !== 1) return null;
  const node = model.nodes.find((n) => n.id === selectedIds[0]);
  if (!node) return null;
  if (!node.isScope) return null;
  return node.kind === "until" || node.kind === "for_each" ? node.id : null;
}

export function SelectionToolbar({
  selectedIds,
  model,
  readOnly = false,
  onWrap,
  onUnwrap,
  variant = "toolbar",
}: SelectionToolbarProps) {
  if (selectedIds.length === 0) return null;
  const testids = TESTIDS[variant];
  const unwrapId = readOnly ? null : unwrapTargetOf(model, selectedIds);
  const enabled = !readOnly && onWrap !== undefined;
  const count = selectedIds.length;

  if (variant === "toolbar") {
    return (
      <div
        role="toolbar"
        aria-label="Selection actions"
        data-testid={testids.box}
        className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
      >
        <span className="font-mono text-[11px] text-muted" data-testid="selection-count">
          {count} step{count === 1 ? "" : "s"} selected
        </span>
        <Button
          variant="secondary"
          compact
          data-testid={testids.wrapUntil}
          disabled={!enabled}
          onClick={() => onWrap?.("until")}
        >
          Wrap in Repeat until
        </Button>
        <Button
          variant="secondary"
          compact
          data-testid={testids.wrapForEach}
          disabled={!enabled}
          onClick={() => onWrap?.("for_each")}
        >
          Wrap in For each
        </Button>
        {unwrapId !== null ? (
          <Button
            variant="ghost"
            compact
            data-testid={testids.unwrap}
            onClick={() => onUnwrap?.(unwrapId)}
          >
            Unwrap {unwrapId}
          </Button>
        ) : null}
      </div>
    );
  }

  // "panel" and "outline" are inline rows without the floating-bar frame.
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      data-testid={testids.box}
      className="flex flex-wrap items-center gap-2"
    >
      <Button
        variant="secondary"
        compact
        data-testid={testids.wrapUntil}
        disabled={!enabled}
        onClick={() => onWrap?.("until")}
      >
        Wrap in Repeat until
      </Button>
      <Button
        variant="secondary"
        compact
        data-testid={testids.wrapForEach}
        disabled={!enabled}
        onClick={() => onWrap?.("for_each")}
      >
        Wrap in For each
      </Button>
      {unwrapId !== null ? (
        <Button
          variant="ghost"
          compact
          data-testid={testids.unwrap}
          onClick={() => onUnwrap?.(unwrapId)}
        >
          Unwrap {unwrapId}
        </Button>
      ) : null}
    </div>
  );
}
