/**
 * AmbiguityDialog — the §4 ambiguity rule made visible: when an insert-on-edge
 * meets a guarded target (a `when` guard, a condition route, or a `nodes.A.*`
 * binding), the page refuses to rewire silently and asks. The reasons come
 * verbatim from the graph model; "Insert anyway" re-runs the op with
 * `acceptAmbiguity` and keeps the target's guard and bindings as-is.
 */
import { Sheet } from "../ds/Sheet";

export interface AmbiguityDialogProps {
  /** The one-line context, e.g. `Insert a step between plan and approve`. */
  title: string;
  /** The §4 reasons, verbatim from the edge's model. */
  reasons: string[];
  onInsertAnyway(): void;
  onCancel(): void;
}

export function AmbiguityDialog({
  title,
  reasons,
  onInsertAnyway,
  onCancel,
}: AmbiguityDialogProps) {
  return (
    <Sheet
      role="alertdialog"
      ariaLabel={title}
      onClose={onCancel}
      closeOnBackdrop={false}
      manageFocus={false}
      trapFocus={false}
      testid="studio-ambiguity-dialog"
      widthClassName="w-[26rem]"
      panelClassName="p-[20px] max-md:p-[16px]"
    >
      <p className="text-[14px] font-bold" data-testid="studio-ambiguity-title">
        {title}
      </p>
      <ul className="mt-2 space-y-[4px]" data-testid="studio-ambiguity-reasons">
        {reasons.map((reason, index) => (
          <li
            key={index}
            className="font-mono text-[11px] text-muted"
            data-testid={`studio-ambiguity-reason-${index}`}
          >
            {reason}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-muted">
        Insert and keep the target&apos;s condition and bindings as-is — it loses its direct
        dependency on the step you are inserting after, so nothing is rewired silently — or cancel.
      </p>
      <div className="mt-3 flex justify-end gap-[8px]">
        <button
          type="button"
          className="ds-btn ds-btn--ghost ds-btn--compact"
          data-testid="studio-ambiguity-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ds-btn ds-btn--primary ds-btn--compact"
          data-testid="studio-ambiguity-insert"
          onClick={onInsertAnyway}
        >
          Insert and keep as-is
        </button>
      </div>
    </Sheet>
  );
}
