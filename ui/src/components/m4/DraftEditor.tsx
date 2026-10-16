/**
 * The M5 YAML draft editor: one monospace textarea over one draft, plus the
 * three writes the draft API owns — `PUT /drafts/{id}` (Save),
 * `POST /drafts/{id}/validate` (Validate), `POST /drafts/{id}/publish`
 * (Publish). A textarea, not an editor: no highlighting, no completion.
 *
 * Honesty rules, inherited from `PipelineLibrary`/`ValidatePanel`:
 * - Publish is enabled only when the **server** reports the draft's `status`
 *   as `valid`. Validity is never inferred from the textarea's contents.
 * - The verdict and its findings are the stored `validation` body the draft
 *   route serves, in the server's own order (loader, schema, compiler), never
 *   merged or re-sorted (§ 2.2).
 * - A `409 stale_draft_version` carries the truth (`current_version`): the
 *   editor re-reads the draft and drops the local text rather than writing
 *   over what the server holds.
 * - Nothing the wire does not serve is rendered: no author names (only the
 *   `edited_by` id the draft carries), no channel labels (M6).
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { Field, Input, Textarea } from "../ds/Field";
import { KindChip } from "./KindChip";
import { StatusChip } from "../ds/Row";
import { DRAFT_STATE, stateOf } from "../ds/states";
import { ProblemBanner, Spinner } from "../Feedback";
import { queryKeys } from "../../api/queries";
import { viewValidate } from "../../api/m4view";
import {
  draftConflictOf,
  useDraft,
  usePublishDraft,
  usePutDraft,
  useValidateDraft,
} from "../../api/pipelines";
import type { PipelineRevision } from "../../api/types";
import type { ValidateBody } from "../../lib/pipeline/contract";
import {
  editableFields,
  listNodes,
  NO_EDITABLE_FIELDS,
  readScalar,
  writeScalar,
  type NodeField,
} from "../../lib/pipeline/nodeFields";
import { shortDigest } from "../../lib/pipeline/yamlPointer";

export interface DraftEditorProps {
  /** The pipeline the draft belongs to — only used to refresh its draft list. */
  pipelineId: string;
  draftId: string;
  headingId?: string;
  className?: string;
}

export function DraftEditor({
  pipelineId,
  draftId,
  headingId = "draft-editor-heading",
  className = "",
}: DraftEditorProps) {
  const queryClient = useQueryClient();
  const draft = useDraft(draftId);
  const put = usePutDraft(draftId);
  const validate = useValidateDraft(draftId);
  const publish = usePublishDraft(draftId);

  const [text, setText] = useState("");
  /** The textarea has text the server does not have. */
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [published, setPublished] = useState<PipelineRevision | null>(null);
  /** The body the last `POST /validate` returned, before the re-read lands. */
  const [fresh, setFresh] = useState<ValidateBody | null>(null);

  // Seed from the served document whenever the local text is not ahead of it;
  // a save/validate that returns the same bytes is a no-op for the textarea.
  const served = draft.data?.document_yaml ?? "";
  useEffect(() => {
    if (!dirty) setText(served);
  }, [served, dirty]);

  const busy = put.isPending || validate.isPending || publish.isPending;
  const status = draft.data?.status ?? "";
  // Server verdict only — `valid` is the sole state publish accepts (§ 2.2).
  const canPublish = status === "valid";
  const verdict = fresh ?? viewValidate(draft.data?.validation ?? null);

  /** A form edit is a keystroke elsewhere in the document: same rules. */
  function applyText(next: string) {
    setText(next);
    setDirty(true);
    setFresh(null);
  }

  async function save(): Promise<boolean> {
    if (!draft.data) return false;
    setFailure(null);
    try {
      await put.mutateAsync({ document_yaml: text, version: draft.data.version });
      setDirty(false);
      return true;
    } catch (error) {
      adoptConflict(error);
      setFailure(error);
      return false;
    }
  }

  /** Validate the bytes the server holds; a dirty textarea saves first. */
  async function runValidate() {
    if (dirty && !(await save())) return;
    setFailure(null);
    try {
      setFresh(viewValidate(await validate.mutateAsync()));
    } catch (error) {
      adoptConflict(error);
      setFailure(error);
    }
  }

  async function runPublish() {
    if (!draft.data || !canPublish) return;
    setFailure(null);
    try {
      setPublished(await publish.mutateAsync({ version: draft.data.version }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineDrafts(pipelineId) });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.pipelineRevisions(draft.data.pipeline_id),
      });
    } catch (error) {
      setFailure(error);
    }
  }

  /** `stale_draft_version` carries `current_version`: re-read the draft and
   * adopt what the server holds instead of retrying over the top of it. */
  function adoptConflict(error: unknown) {
    if (!draftConflictOf(error)) return;
    setDirty(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
  }

  if (draft.isPending) return <Spinner label="Loading the draft" />;
  if (draft.isError) {
    return (
      <ProblemBanner
        error={draft.error}
        fallback="The draft could not be read."
        testid="draft-editor-error"
      />
    );
  }
  return (
    <Panel
      title="DRAFT EDITOR"
      headingId={headingId}
      headingLevel={2}
      state={status === "invalid" ? "failed" : undefined}
      meta={
        <span className="font-mono text-[10px] font-normal" data-testid="draft-editor-meta">
          draft {draftId} · v{draft.data.version} · {status}
        </span>
      }
      className={className}
    >
      <div className="grid items-start gap-[10px] p-[10px] xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-[10px]">
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setDirty(true);
              // The verdict describes the bytes it ran against, not this edit.
              setFresh(null);
            }}
            spellCheck={false}
            aria-label="Pipeline draft YAML"
            rows={16}
            className="w-full resize-y rounded-[3px] border border-line bg-surface p-[8px] font-mono text-[11.5px] leading-[17px]"
            data-testid="draft-editor-input"
          />
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button
              variant="primary"
              onClick={save}
              disabled={busy || !dirty}
              data-testid="draft-editor-save"
            >
              {put.isPending ? "Saving…" : "Save"}
            </Button>
            <Button onClick={runValidate} disabled={busy} data-testid="draft-editor-validate">
              {validate.isPending ? "Validating…" : dirty ? "Validate (saves first)" : "Validate"}
            </Button>
            <Button
              variant="secondary"
              onClick={runPublish}
              disabled={busy || !canPublish}
              data-testid="draft-editor-publish"
              title={
                canPublish
                  ? "publish this draft as a new immutable revision"
                  : `the server reports this draft as “${status}” — publish needs a valid draft`
              }
            >
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
            <StatusChip
              state={stateOf(DRAFT_STATE[status])}
              label={
                verdict === null
                  ? "never validated"
                  : verdict.valid
                    ? "valid"
                    : `${verdict.errors.length} findings`
              }
              labelProps={{ "data-testid": "draft-editor-verdict" }}
            />
            {dirty ? (
              <span className="font-mono text-[10.5px] text-faint" data-testid="draft-editor-dirty">
                unsaved changes
              </span>
            ) : null}
          </div>
          {failure ? (
            <ProblemBanner
              error={failure}
              fallback="The draft write did not land."
              testid="draft-editor-failure"
            />
          ) : null}
          {published ? (
            <p className="font-mono text-[10.5px] text-muted" data-testid="draft-editor-published">
              published r{published.revision_number} · {published.version_label} ·{" "}
              {shortDigest(published.revision_digest)} — immutable from here on
            </p>
          ) : null}
          {verdict ? <Verdict verdict={verdict} /> : null}
        </div>
        <NodeForm text={text} onApply={applyText} />
      </div>
    </Panel>
  );
}

/** The stored verdict: server order, one line per finding, notes verbatim. */
function Verdict({ verdict }: { verdict: ValidateBody }) {
  return (
    <div className="space-y-[4px]" data-testid="draft-editor-findings">
      {verdict.errors.map((issue, index) => (
        <p
          key={`${issue.source}-${issue.code}-${index}`}
          className="font-mono text-[11px] leading-[16px]"
          data-testid={`draft-editor-problem-${index}`}
        >
          <span className="text-muted">{issue.source}</span> {issue.code} · {issue.message}
          {issue.hint ? <span className="text-faint"> · hint: {issue.hint}</span> : null}
          <span className="text-faint"> · {issue.instance_location ?? "no location served"}</span>
        </p>
      ))}
      <p className="font-mono text-[10.5px] text-faint" data-testid="draft-editor-notes">
        {verdict.notes.length > 0 ? verdict.notes.join(" · ") : "no notes from the server"}
      </p>
    </div>
  );
}

/**
 * The per-step form (W4): pick a node, edit the fields its `kind` has. The
 * table of fields is fixed (`nodeFields.editableFields`) and every edit is a
 * one-line rewrite of the textarea's own text, so the form never holds a
 * version of the document Save would not send — and a kind with no fields says
 * so instead of pretending to edit YAML it cannot parse.
 */
function NodeForm({
  text,
  onApply,
}: {
  /** The textarea's current text — the only copy of the document. */
  text: string;
  onApply: (next: string) => void;
}) {
  const nodes = listNodes(text);
  const [picked, setPicked] = useState<number | null>(null);
  // The picker follows the text: delete `/spec/nodes/2` in the textarea and the
  // pane moves to a node that is still there rather than showing a ghost.
  const current = nodes.find((node) => node.index === picked) ?? nodes[0] ?? null;
  const fields = editableFields(current === null ? null : current.kind);

  return (
    <div
      className="space-y-[8px] rounded-[3px] border border-line bg-paper p-[8px]"
      data-testid="draft-editor-node-form"
    >
      <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
        Node fields
      </p>
      {nodes.length === 0 ? (
        <p className="font-mono text-[11px] text-faint" data-testid="draft-editor-no-nodes">
          this draft has no nodes to edit
        </p>
      ) : (
        <div
          className="flex flex-wrap gap-[4px]"
          role="group"
          aria-label="Draft nodes"
          data-testid="draft-editor-nodes"
        >
          {nodes.map((node) => (
            <Button
              key={node.index}
              compact
              variant={current?.index === node.index ? "secondary" : "secondaryPlain"}
              aria-pressed={current?.index === node.index}
              onClick={() => setPicked(node.index)}
              data-testid={`draft-editor-node-${node.index}`}
            >
              {node.id ?? `node ${node.index}`}
            </Button>
          ))}
        </div>
      )}
      {current === null ? null : (
        <div className="space-y-[8px]">
          <div data-testid="draft-editor-node-kind">
            {current.kind === null ? (
              <span className="font-mono text-[10.5px] text-faint">no kind</span>
            ) : (
              <KindChip kind={current.kind} />
            )}
          </div>
          {fields.length === 0 ? (
            // The honest answer for the seven kinds this form does not know:
            // the textarea is the editor, and saying so beats an empty form.
            <p className="font-mono text-[11px] text-faint" data-testid="draft-editor-no-fields">
              {NO_EDITABLE_FIELDS}
            </p>
          ) : (
            fields.map((field) => (
              <NodeFieldRow
                key={field.key}
                field={field}
                nodeIndex={current.index}
                text={text}
                onApply={onApply}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** One labelled field: read its scalar, write back only that key's value. */
function NodeFieldRow({
  field,
  nodeIndex,
  text,
  onApply,
}: {
  field: NodeField;
  nodeIndex: number;
  text: string;
  onApply: (next: string) => void;
}) {
  const pointer = field.pointer(nodeIndex);
  const value = readScalar(text, pointer);
  // Null is not an empty field: the key is absent (or holds structure), and the
  // answer is to say where to add it rather than invent a line.
  const missing = value === null;
  const id = `draft-node-${nodeIndex}-${field.key}`;

  function edit(next: string) {
    const result = writeScalar(text, pointer, next, field.type);
    if (!result.missing) onApply(result.text);
  }

  return (
    <Field
      id={id}
      label={field.label}
      hint={
        missing ? (
          <p className="font-mono text-[11px] text-faint" data-testid="draft-editor-field-missing">
            not in this document — add it in the YAML at{" "}
            <span className="text-ink-2">{pointer}</span>
          </p>
        ) : (
          <p className="font-mono text-[10px] text-faint">{pointer}</p>
        )
      }
    >
      {field.type === "textarea" ? (
        <Textarea
          id={id}
          rows={6}
          value={value ?? ""}
          disabled={missing}
          onChange={(event) => edit(event.target.value)}
          data-testid={`draft-editor-field-${field.key}`}
        />
      ) : (
        <Input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          value={value ?? ""}
          disabled={missing}
          onChange={(event) => edit(event.target.value)}
          data-testid={`draft-editor-field-${field.key}`}
        />
      )}
    </Field>
  );
}
