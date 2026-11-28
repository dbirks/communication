/**
 * "Duplicate as a new step…" (design 3b, ADR-0049 § 3): a NEW template whose
 * revision 1 is a content copy of the source's latest revision. On success
 * the page navigates to the new step.
 *
 * Accessible modal: the StepDialog shell (focus trapped, Escape closes).
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { FormError } from "../Feedback";
import { Field } from "../ds/Field";
import { useDuplicateNodeTemplate, type NodeTemplate } from "../../api/nodeTemplates";
import { StepDialog } from "./StepDialog";
import { routes } from "../../lib/routes";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The redesign's input: 8px corner, 1px line-strong (CONTRACT.md "Design tokens"). */
const SOFT_INPUT =
  "w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[6px] font-mono text-[12.5px] text-ink placeholder:text-faint max-[560px]:min-h-[44px] focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";

export interface DuplicateDialogProps {
  open: boolean;
  onClose: () => void;
  source: NodeTemplate;
}

export function DuplicateDialog({ open, onClose, source }: DuplicateDialogProps) {
  const navigate = useNavigate();
  const duplicate = useDuplicateNodeTemplate(source.id);

  const [slug, setSlug] = useState(source.slug + "-copy");
  const [displayName, setDisplayName] = useState(source.display_name);
  const [error, setError] = useState<unknown>(null);

  const valid = SLUG_PATTERN.test(slug) && displayName.trim() !== "";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || duplicate.isPending) return;
    setError(null);
    void duplicate
      .mutateAsync({ slug, display_name: displayName.trim() })
      .then((created) => {
        onClose();
        navigate(routes.step(created.id));
      })
      .catch(setError);
  }

  return (
    <StepDialog
      open={open}
      onClose={onClose}
      title="Duplicate as a new step…"
      hint={`A new step whose revision 1 copies ${source.display_name}'s latest revision.`}
      testid="duplicate-dialog"
      width="480px"
    >
      <form className="space-y-[10px]" onSubmit={submit} data-testid="duplicate-form">
        <Field
          id="duplicate-slug"
          label="slug"
          hint="lowercase letters, digits and dashes; unique in the organization"
        >
          <input
            id="duplicate-slug"
            type="text"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className={`${SOFT_INPUT} font-mono`}
            data-testid="duplicate-slug"
          />
        </Field>
        <Field id="duplicate-name" label="display name">
          <input
            id="duplicate-name"
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className={SOFT_INPUT}
            data-testid="duplicate-name"
          />
        </Field>
        {error ? <FormError error={error} testid="duplicate-error" /> : null}
        <div className="flex justify-end gap-[8px]">
          <button
            type="button"
            className="ds-btn ds-btn--secondary"
            onClick={onClose}
            data-testid="duplicate-cancel"
          >
            Cancel
          </button>
          <button
            className="ds-btn ds-btn--primary"
            type="submit"
            disabled={duplicate.isPending || !valid}
            data-testid="duplicate-submit"
          >
            {duplicate.isPending ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
      </form>
    </StepDialog>
  );
}
