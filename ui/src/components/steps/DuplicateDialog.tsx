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
import { Button } from "../ds/Button";
import { Field, Input } from "../ds/Field";
import { useDuplicateNodeTemplate, type NodeTemplate } from "../../api/nodeTemplates";
import { StepDialog } from "./StepDialog";
import { routes } from "../../lib/routes";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
          <Input
            id="duplicate-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="font-mono"
            data-testid="duplicate-slug"
          />
        </Field>
        <Field id="duplicate-name" label="display name">
          <Input
            id="duplicate-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            data-testid="duplicate-name"
          />
        </Field>
        {error ? <FormError error={error} testid="duplicate-error" /> : null}
        <div className="flex justify-end gap-[8px]">
          <Button variant="secondary" onClick={onClose} data-testid="duplicate-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={duplicate.isPending || !valid}
            data-testid="duplicate-submit"
          >
            {duplicate.isPending ? "Duplicating…" : "Duplicate"}
          </Button>
        </div>
      </form>
    </StepDialog>
  );
}
