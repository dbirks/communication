/**
 * AmbiguityDialog — the §4 ambiguity rule made visible: when an insert-on-edge
 * meets a guarded target (a `when` guard, a condition route, or a `nodes.A.*`
 * binding), the page refuses to rewire silently and asks. The reasons come
 * verbatim from the graph model; "Insert anyway" re-runs the op with
 * `acceptAmbiguity` and keeps the target's guard and bindings as-is.
 */
import { Button } from "../ds/Button";

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-4"
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-label={title}
        className="w-[26rem] max-w-full rounded-[4px] border border-line bg-surface p-4 shadow-lg"
        data-testid="studio-ambiguity-dialog"
      >
        <p className="text-[13px] font-bold" data-testid="studio-ambiguity-title">
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
          dependency on the step you are inserting after, so nothing is rewired silently — or
          cancel.
        </p>
        <div className="mt-3 flex justify-end gap-[8px]">
          <Button variant="ghost" compact data-testid="studio-ambiguity-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            compact
            data-testid="studio-ambiguity-insert"
            onClick={onInsertAnyway}
          >
            Insert and keep as-is
          </Button>
        </div>
      </div>
    </div>
  );
}
