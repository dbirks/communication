/**
 * "Edit for all N → version x.y.z" (design 3b, ADR-0049 § 5): the latest
 * revision's `config` as an editable YAML/JSON document plus the version the
 * new immutable revision carries. Submit appends revision N+1 with
 * `adopt_using_workflows: true` and shows the § 5 adoption result verbatim —
 * nothing is invented: a response without (or with empty) adoption arrays
 * gets the honest "once adoption ships" note.
 *
 * Accessible modal: the StepDialog shell (focus trapped, Escape closes). The
 * body remounts on every open, so its state seeds from the props each time.
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { parse, stringify } from "yaml";
import { FormError } from "../Feedback";
import { Field } from "../ds/Field";
import {
  useCreateNodeTemplateRevision,
  type NodeTemplateRevision,
  type NodeTemplateRevisionCreateResponse,
} from "../../api/nodeTemplates";
import { bumpSemver } from "./kindFamily";
import { StepDialog } from "./StepDialog";
import { routes } from "../../lib/routes";

/** The redesign's controls: 8px corner, 1px line-strong (CONTRACT.md "Design tokens"). */
const SOFT_INPUT =
  "w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[6px] font-mono text-[12.5px] text-ink placeholder:text-faint max-[560px]:min-h-[44px] focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";
const SOFT_TEXTAREA =
  "w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[8px] font-mono text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";

export interface EditForAllDialogProps {
  open: boolean;
  onClose: () => void;
  templateId: string;
  usedInCount: number;
  latest: NodeTemplateRevision;
}

export function EditForAllDialog({
  open,
  onClose,
  templateId,
  usedInCount,
  latest,
}: EditForAllDialogProps) {
  const createRevision = useCreateNodeTemplateRevision(templateId);

  const suggested = bumpSemver(latest.version_label) ?? latest.version_label;
  const [doc, setDoc] = useState<string>(() => stringify(latest.config ?? {}));
  const [version, setVersion] = useState(suggested);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<NodeTemplateRevisionCreateResponse | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (createRevision.isPending) return;
    setError(null);
    const label = version.trim();
    if (label === "") {
      setError(new Error("A version label is required."));
      return;
    }
    let config: unknown;
    try {
      config = parse(doc);
    } catch (parseError) {
      setError(parseError);
      return;
    }
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      setError(new Error("The config must be a YAML/JSON object of parameter values."));
      return;
    }
    void createRevision
      .mutateAsync({
        parameters: latest.parameters ?? {},
        // The generated types model JSON objects as `Record<string, never>`;
        // the wire is a plain JSON object, so cast through.
        config: config as Record<string, never>,
        output_schema: latest.output_schema ?? {},
        workspace_mode: latest.workspace_mode,
        version_label: label,
        adopt_using_workflows: true,
      })
      .then(setResult)
      .catch(setError);
  }

  const adopted = result?.adopted;
  const skipped = result?.skipped;
  const adoptionPresent =
    result !== null &&
    Array.isArray(adopted) &&
    Array.isArray(skipped) &&
    (adopted.length > 0 || skipped.length > 0);

  return (
    <StepDialog
      open={open}
      onClose={onClose}
      title={`Edit for all ${usedInCount} → version ${suggested}`}
      hint="A new immutable revision — running runs keep the version they started on."
      testid="edit-for-all-dialog"
      width="640px"
    >
      <form className="space-y-[10px]" onSubmit={submit} data-testid="edit-for-all-form">
        <Field
          id="edit-for-all-config"
          label="config (YAML or JSON)"
          hint={`the parameterized body, as revision ${latest.revision_number} carries it`}
        >
          <textarea
            id="edit-for-all-config"
            value={doc}
            onChange={(event) => setDoc(event.target.value)}
            rows={10}
            spellCheck={false}
            className={`${SOFT_TEXTAREA} text-[11.5px]`}
            data-testid="edit-for-all-config"
          />
        </Field>
        <Field id="edit-for-all-version" label="version label" hint={`suggested ${suggested}`}>
          <input
            id="edit-for-all-version"
            type="text"
            value={version}
            onChange={(event) => {
              setVersion(event.target.value);
              setError(null);
            }}
            className={`${SOFT_INPUT} font-mono`}
            data-testid="edit-for-all-version"
          />
        </Field>
        {error ? <FormError error={error} testid="edit-for-all-error" /> : null}
        {result !== null ? (
          <div className="space-y-[6px] rounded-[10px] border border-line bg-surface p-[12px] text-[12px]">
            <p data-testid="edit-for-all-result">
              Published revision {result.revision.revision_number}{" "}
              <span className="font-mono">{result.revision.version_label}</span>
            </p>
            {Array.isArray(adopted) && adopted.length > 0 ? (
              <ul className="space-y-[4px]" data-testid="edit-for-all-adopted">
                {adopted.map((entry) => (
                  <li key={entry.draft_id}>
                    <Link
                      className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      to={routes.draft(entry.pipeline_id, entry.draft_id)}
                    >
                      {entry.pipeline_slug}
                    </Link>{" "}
                    gets a draft to adopt it (draft #{entry.draft_version})
                  </li>
                ))}
              </ul>
            ) : null}
            {Array.isArray(skipped) && skipped.length > 0 ? (
              <ul className="space-y-[4px]" data-testid="edit-for-all-skipped">
                {skipped.map((entry, index) => (
                  <li key={`${entry.pipeline_id}-${index}`}>
                    Skipped {entry.pipeline_id}: the workflow has an open draft
                  </li>
                ))}
              </ul>
            ) : null}
            {!adoptionPresent ? (
              <p className="text-muted" data-testid="edit-for-all-adoption-pending">
                Workflows using this step will get drafts once adoption ships.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-[8px]">
          <button
            type="button"
            className="ds-btn ds-btn--secondary"
            onClick={onClose}
            data-testid="edit-for-all-close"
          >
            {result !== null ? "Done" : "Cancel"}
          </button>
          <button
            className="ds-btn ds-btn--primary"
            type="submit"
            disabled={createRevision.isPending}
            data-testid="edit-for-all-submit"
          >
            {createRevision.isPending ? "Publishing…" : "Publish revision"}
          </button>
        </div>
      </form>
    </StepDialog>
  );
}
