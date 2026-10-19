/**
 * Studio.tsx — the Workflow Studio page, `/library/:pipelineId/drafts/:draftId`.
 *
 * `docs/design/studio-workbench.md` §3: the palette | canvas | inspector
 * authoring surface over one draft. The YAML text is the source of truth
 * (ADR-0042): graph gestures call the text→text ops, `useStudioDraft`
 * commits them with undo/redo, and Save/Validate/Publish hit the existing
 * version-checked draft contract unchanged. Below 1024px the canvas gives
 * way to the StepOutline fallback (§9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useMe } from "../api/queries";
import {
  useDraft,
  usePipeline,
  usePublishDraft,
  useRevision,
  useValidateDraft,
} from "../api/pipelines";
import { viewValidate } from "../api/m4view";
import type { ValidateBody } from "../lib/pipeline/contract";
import { hasLibraryRole, LIBRARY_READ_ONLY_NOTE } from "../lib/pipeline/authoring";
import {
  addNode,
  deleteNode,
  unwrapScope,
  wrapInScope,
  type GraphEdge,
  type GraphModel,
  type OpResult,
  type ScopePath,
} from "../lib/pipeline/graphDoc";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { Button } from "../components/ds/Button";
import {
  canConnectOf,
  connectOp,
  disconnectEdgeOp,
  insertOnEdgeOp,
  isAmbiguousOp,
  toJsDocument,
  useStudioDraft,
} from "../components/studio/useStudioDraft";
import { StudioCanvas } from "../components/studio/StudioCanvas";
import { StudioPalette } from "../components/studio/StudioPalette";
import { StudioInspector } from "../components/studio/StudioInspector";
import { SelectionToolbar, type ScopeKind } from "../components/studio/SelectionToolbar";
import { DiffPanel } from "../components/studio/DiffPanel";
import { StudioHeader, type StudioView } from "../components/studio/StudioHeader";
import { AmbiguityDialog } from "../components/studio/AmbiguityDialog";
import { StepOutline } from "../components/studio/StepOutline";
import {
  AssistantProposalBox,
  PROPOSAL_CAPTION,
  type AssistantProposalPreview,
} from "../components/studio/AssistantProposalBox";

/** §9: no canvas below 1024px — the step outline is the keyboard surface. */
function useIsNarrow(query = "(max-width: 1023px)"): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

const EMPTY_MODEL: GraphModel = { nodes: [], edges: [] };

/** The YAML view's textarea + parse diagnostic (line included when there is one). */
function YamlEditor({
  text,
  error,
  onChange,
}: {
  text: string;
  error: { error: string; line: number | null } | null;
  onChange(text: string): void;
}) {
  return (
    <div className="flex h-full min-h-[16rem] flex-col gap-2 p-3">
      <textarea
        data-testid="studio-yaml"
        aria-label="Pipeline YAML"
        value={text}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded-[3px] border border-line bg-surface p-2 font-mono text-[12px] leading-5"
      />
      {error ? (
        <p className="font-mono text-[11px] text-st-failed-pale-fg" data-testid="studio-yaml-error">
          {error.error}
          {error.line !== null ? ` (line ${error.line})` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function StudioPage() {
  const { pipelineId = "", draftId = "" } = useParams();
  const me = useMe();
  const pipeline = usePipeline(pipelineId);
  const draft = useDraft(draftId);
  const studio = useStudioDraft(draftId);
  const validate = useValidateDraft(draftId, pipelineId);
  const publish = usePublishDraft(draftId);
  const newestSummary = pipeline.data?.revisions?.[0] ?? null;
  const newestRevision = useRevision(newestSummary?.revision_digest ?? "");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** Single selection (the inspector's node) — null with multi/none. */
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [view, setView] = useState<StudioView>("canvas");
  const [diffOpen, setDiffOpen] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);
  const [validateOutcome, setValidateOutcome] = useState<ValidateBody | null>(null);
  const [validateFailure, setValidateFailure] = useState<unknown>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [publishFailure, setPublishFailure] = useState<unknown>(null);
  const [opError, setOpError] = useState<string | null>(null);
  // ADR-0044 §4: the assistant's preview lives in the page — text adopted as
  // an undoable apply, the proposed nodes ringed on the canvas.
  const [highlight, setHighlight] = useState<string[]>([]);
  const [proposalSummary, setProposalSummary] = useState<string | null>(null);

  function onPreview(next: AssistantProposalPreview) {
    const result = studio.apply(() => ({ ok: true, text: next.text, changed: next.nodeIds }));
    if (!result.ok) {
      setOpError(isAmbiguousOp(result) ? result.reasons.join("; ") : result.error);
      return;
    }
    setOpError(null);
    setHighlight(next.nodeIds);
    setProposalSummary(next.summary);
  }

  async function onProposalApply() {
    // A successful save lands the previewed bytes: clear the highlight so the
    // canvas stops ringing and the box drops back to the plain form. A failed
    // save keeps the preview (the save-error / conflict surface shows why) so
    // the same proposal can be applied again once it succeeds.
    const saved = await studio.save();
    if (saved) {
      setHighlight([]);
      setProposalSummary(null);
    }
  }

  function onProposalDiscard() {
    studio.undo();
    setHighlight([]);
    setProposalSummary(null);
  }
  const [ambiguity, setAmbiguity] = useState<{
    title: string;
    reasons: string[];
    rerun: () => void;
  } | null>(null);
  const narrow = useIsNarrow();

  const canAuthor = hasLibraryRole(me.data);
  const status = draft.data?.status ?? "draft";
  const readOnly = !canAuthor || status === "published";

  const parse = studio.parse;
  const parseOk = parse.ok;
  const model: GraphModel = parseOk ? parse.model : (studio.lastGood?.model ?? EMPTY_MODEL);
  // Memoized: the canvas' flow model (and thus its rebuild effect) is keyed on
  // this object's identity — a fresh `toJsDocument(text)` on every render made
  // the canvas rebuild on every render, re-pushing the node array into the
  // React Flow store and oscillating the selection until React aborted with
  // "Maximum update depth exceeded". `lastGood` only feeds the broken-YAML
  // fallback, so it is a dependency only while the parse is broken — the
  // effect that refreshes it runs once per text change and a plain
  // `[…, lastGood]` list would rebuild the graph twice on every edit.
  const document: unknown = useMemo(
    () => (parseOk ? toJsDocument(studio.text) : (studio.lastGood?.document ?? null)),
    [parseOk, studio.text, parseOk ? null : studio.lastGood],
  );
  const parseError = parseOk ? null : { error: parse.error, line: parse.line };

  /** Drop selected ids the graph no longer knows (undo/redo, deletes, YAML).
   *  The array identity is kept when nothing is stale, so the canvas' rebuild
   *  (which depends on `selectedIds`) doesn't churn on every parse. */
  useEffect(() => {
    setSelectedIds((current) => {
      const alive = current.filter((id) => model.nodes.some((n) => n.id === id));
      return alive.length === current.length ? current : alive;
    });
  }, [model]);

  /** Single-select from the steps list / node clicks / "go to node".
   *  Stable identity: the canvas rebuild and React Flow's selection effect
   *  both depend on these callbacks — a fresh closure on every render would
   *  re-fire the selection effect and ping-pong with the store's own
   *  selection state. */
  const selectOne = useCallback((id: string | null) => {
    setSelectedIds(id !== null ? [id] : []);
  }, []);

  /** React Flow's selection set (Shift+click, the Shift+drag box).
   *  Bails out (same array identity) when the set already matches, so the
   *  page state and React Flow's internal selection converge instead of
   *  chasing each other. `model` is read through a ref for stability. */
  const modelRef = useRef(model);
  modelRef.current = model;
  const selectMany = useCallback((ids: string[]) => {
    setSelectedIds((current) => {
      const alive = ids.filter((id) => modelRef.current.nodes.some((n) => n.id === id));
      const kept = current.filter((id) => alive.includes(id));
      return kept.length === alive.length && kept.every((id, i) => id === alive[i])
        ? current
        : alive;
    });
  }, []);

  /** Toggle one step in the multi-selection (the outline's checkboxes). */
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);

  /** Wrap the selection in a bounded repeat scope; on success the new scope
   *  is selected so the inspector shows Pass when / Max iterations, etc. */
  function handleWrap(kind: ScopeKind) {
    runOp((text) => wrapInScope(text, selectedIds, { kind }));
  }

  /** Unwrap a single selected until / for_each scope. */
  function handleUnwrap(scopeId: string) {
    runOp((text) => unwrapScope(text, scopeId));
  }

  /** Commit a graph op: ok → select the changed node; otherwise name the failure. */
  function runOp(op: (text: string) => OpResult) {
    const result = studio.apply(op);
    if (result.ok) {
      setOpError(null);
      setSelectedIds(result.changed[0] !== undefined ? [result.changed[0]] : []);
      return;
    }
    if (isAmbiguousOp(result)) {
      setOpError(result.reasons.join("; "));
      return;
    }
    setOpError(result.error);
  }

  /** Insert on an edge — the §4 ambiguity rule opens the dialog instead of rewiring. */
  function insertOnEdge(edge: GraphEdge, kind: string, acceptAmbiguity = false) {
    const title = `Insert a step between ${edge.from} and ${edge.to}`;
    const result = studio.apply((text) => insertOnEdgeOp(text, edge, kind, { acceptAmbiguity }));
    if (result.ok) {
      setOpError(null);
      setSelectedIds(result.changed[0] !== undefined ? [result.changed[0]] : []);
      return;
    }
    if (isAmbiguousOp(result)) {
      setAmbiguity({
        title,
        reasons: result.reasons,
        rerun: () => {
          setAmbiguity(null);
          insertOnEdge(edge, kind, true);
        },
      });
      return;
    }
    setOpError(result.error);
  }

  function handleAddAfter(afterId: string | null, scope: ScopePath, kind: string) {
    runOp((text) => addNode(text, { kind, scope, after: afterId }));
  }

  function handleDelete(ids: string[]) {
    for (const id of ids) {
      const isEdge = id.includes("->");
      const result = studio.apply((text) =>
        isEdge ? disconnectEdgeOp(text, id) : deleteNode(text, id),
      );
      if (!result.ok && !isAmbiguousOp(result)) {
        setOpError(result.error);
        break;
      }
    }
    setSelectedIds([]);
  }

  async function runValidate() {
    if (studio.dirty && !(await studio.save())) return;
    setValidateFailure(null);
    try {
      const body = await validate.mutateAsync();
      setValidateOutcome(viewValidate(body));
    } catch (error) {
      setValidateFailure(error);
    }
    setValidateOpen(true);
  }

  /** "Go to node": the deepest node the finding's pointer names (the node
   *  itself, or a field / scoped child inside it). */
  function goToNode(instanceLocation: string | null) {
    if (instanceLocation === null) return;
    const matches = model.nodes.filter(
      (n) => n.pointer === instanceLocation || instanceLocation.startsWith(`${n.pointer}/`),
    );
    if (matches.length === 0) return;
    const node = matches.reduce((deepest, n) =>
      n.pointer.length > deepest.pointer.length ? n : deepest,
    );
    selectOne(node.id);
    setView("canvas");
  }

  // The publish gate, in the page's own words, not just a disabled button
  // (DraftEditor's rule: saved bytes + the server's `valid` verdict).
  let publishReason: string | null;
  if (status === "published") {
    publishReason = "this draft is already published — revisions are immutable";
  } else if (!canAuthor) {
    publishReason = LIBRARY_READ_ONLY_NOTE;
  } else if (studio.dirty) {
    publishReason = "save first — publish posts the bytes the server holds, not the local edit";
  } else if (status !== "valid") {
    publishReason = `the server's last verdict is ${
      status === "draft" ? "not validated" : status
    } — publish accepts only a draft that validation marked valid`;
  } else {
    publishReason = null;
  }

  async function onPublish() {
    if (publishReason !== null) return;
    setPublishFailure(null);
    try {
      const revision = await publish.mutateAsync({ version: studio.savedVersion });
      setPublishNote(`published as r${revision.revision_number} ${revision.version_label}`);
    } catch (error) {
      setPublishFailure(error);
    }
  }

  if (draft.isPending) return <Spinner label="Loading the draft" />;
  if (draft.isError) {
    return (
      <ProblemBanner
        error={draft.error}
        fallback="The draft could not be read."
        testid="studio-draft-error"
      />
    );
  }

  const baseDocument = newestRevision.data?.canonical_document ?? null;

  const inspector = (
    <>
      {studio.guard.pending === null && studio.conflict === null ? (
        <>
          <AssistantProposalBox
            draftId={draftId}
            version={studio.savedVersion}
            text={studio.text}
            readOnly={readOnly}
            dirty={studio.dirty && highlight.length === 0}
            previewing={highlight.length > 0}
            onPreview={onPreview}
            onApply={onProposalApply}
            onDiscard={onProposalDiscard}
          />
          {highlight.length > 0 ? (
            <p
              className="border-b border-line bg-st-waiting-pale-body px-3 py-1.5 font-mono text-[10px] text-st-waiting-pale-fg"
              data-testid="studio-proposal-caption"
            >
              {PROPOSAL_CAPTION}
              {proposalSummary ? ` — ${proposalSummary}` : ""}
            </p>
          ) : null}
        </>
      ) : null}
      {selectedIds.length > 1 ? (
        <div
          className="rounded-[3px] border border-line bg-paper p-[8px]"
          data-testid="multi-select-panel"
        >
          <p
            className="font-mono text-[11px] font-semibold text-ink"
            data-testid="multi-select-count"
          >
            {selectedIds.length} steps selected
          </p>
          <ul className="mt-1 flex flex-wrap gap-1" data-testid="multi-select-ids">
            {selectedIds.map((id) => (
              <li
                key={id}
                className="rounded-[3px] bg-accent-wash px-[5px] py-[1px] font-mono text-[10px] text-accent"
              >
                {id}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 font-mono text-[10px] text-faint">
            Wrap the selection in a bounded repeat scope, or clear the selection to edit a single
            step.
          </p>
          <div className="mt-2">
            <SelectionToolbar
              variant="panel"
              selectedIds={selectedIds}
              model={model}
              readOnly={readOnly}
              onWrap={handleWrap}
              onUnwrap={handleUnwrap}
            />
          </div>
        </div>
      ) : (
        <StudioInspector
          model={model}
          nodeId={selectedId}
          document={document}
          text={studio.text}
          readOnly={readOnly}
          apply={studio.apply}
        />
      )}
    </>
  );
  const canvas = (
    <StudioCanvas
      model={model}
      document={document}
      layout={studio.layout}
      selectedId={selectedId}
      selectedIds={selectedIds}
      onSelectionChange={selectMany}
      readOnly={readOnly || !parseOk}
      stale={!parseOk}
      staleMessage="YAML has errors — the canvas shows the last valid version; graph editing is paused"
      highlight={highlight.length > 0 ? highlight : undefined}
      onSelect={selectOne}
      onMove={readOnly ? undefined : studio.move}
      onInsertOnEdge={readOnly ? undefined : (edge, kind) => insertOnEdge(edge, kind)}
      onAddAfter={readOnly ? undefined : handleAddAfter}
      onConnect={readOnly ? undefined : (from, to) => runOp((text) => connectOp(text, from, to))}
      onDelete={readOnly ? undefined : handleDelete}
      canConnect={readOnly ? undefined : (from, to) => canConnectOf(model, from, to)}
    />
  );
  const yaml = <YamlEditor text={studio.text} error={parseError} onChange={studio.setText} />;

  // The drawers live below the surface (canvas or outline), full column width:
  // the validate results with go-to-node, and the diff against the newest
  // published revision's canonical document.
  const drawers = (
    <>
      {validateOpen ? (
        <div
          className="max-h-[40%] overflow-auto border-t border-line bg-surface p-3"
          data-testid="studio-validate-drawer"
        >
          {validateFailure !== null ? (
            <ProblemBanner
              error={validateFailure}
              fallback="The draft could not be validated."
              testid="studio-validate-error"
            />
          ) : validateOutcome === null ? (
            <p className="font-mono text-[11px] text-muted" data-testid="studio-validate-pending">
              validating…
            </p>
          ) : (
            <>
              <p className="font-mono text-[11px]" data-testid="studio-validate-verdict">
                {validateOutcome.valid
                  ? `valid — ${validateOutcome.errors.length} findings`
                  : `invalid — ${validateOutcome.errors.length} findings`}
              </p>
              {validateOutcome.errors.length > 0 ? (
                <ul className="mt-1 divide-y divide-line" data-testid="studio-validate-findings">
                  {validateOutcome.errors.map((issue, index) => (
                    <li
                      key={`${issue.code}-${index}`}
                      className="flex items-start gap-[8px] py-[3px]"
                      data-testid={`studio-validate-finding-${index}`}
                    >
                      <span className="min-w-0 flex-1 font-mono text-[11px] text-muted">
                        <span className="text-ink">{issue.code}</span> · {issue.message}
                      </span>
                      {issue.instance_location !== null ? (
                        <Button
                          variant="ghost"
                          compact
                          data-testid={`studio-goto-node-${index}`}
                          onClick={() => goToNode(issue.instance_location)}
                        >
                          go to node
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {diffOpen ? (
        <div
          className="max-h-[40%] overflow-auto border-t border-line bg-surface p-3"
          data-testid="studio-diff-drawer"
        >
          {newestSummary === null ? (
            <p className="font-mono text-[11px] text-muted" data-testid="studio-diff-empty">
              first revision — nothing to compare
            </p>
          ) : (
            <DiffPanel baseDocument={baseDocument} text={studio.text} className="!p-0" />
          )}
        </div>
      ) : null}
    </>
  );

  return (
    // Full-bleed route (App.tsx): the page owns the whole viewport — app bar
    // (53px) + footer (37px) leave `calc(100vh - 91px)`, a definite height the
    // column divides: header, then palette/canvas/inspector, each pane
    // scrolling internally. No vertical page scroll, so the sticky app bar
    // can never scroll over the canvas and intercept its controls.
    <div
      className="flex h-[calc(100vh-91px)] flex-col overflow-hidden bg-paper"
      data-testid="studio-page"
    >
      <StudioHeader
        pipelineName={pipeline.data?.display_name || pipeline.data?.slug || pipelineId}
        savedVersion={studio.savedVersion || null}
        validation={viewValidate(draft.data?.validation ?? null)}
        readOnly={readOnly}
        canUndo={studio.canUndo}
        canRedo={studio.canRedo}
        onUndo={studio.undo}
        onRedo={studio.redo}
        onSave={() => void studio.save()}
        saving={studio.saving}
        dirty={studio.dirty}
        onValidate={() => void runValidate()}
        validatePending={validate.isPending}
        onDiff={() => setDiffOpen((open) => !open)}
        diffOpen={diffOpen}
        onPublish={() => void onPublish()}
        publishPending={publish.isPending}
        publishReason={publishReason}
        view={view}
        onViewChange={setView}
      />
      {studio.guard.pending !== null ? (
        <div
          className="flex flex-wrap items-center gap-[8px] border-b border-line bg-st-waiting-pale-body px-4 py-2"
          data-testid="studio-leave-guard"
        >
          <span className="font-mono text-[11px] text-st-waiting-pale-fg">
            unsaved changes — leaving the studio discards the local edit the server never saw
          </span>
          <Button
            variant="secondary"
            compact
            data-testid="studio-leave-discard"
            onClick={studio.guard.proceed}
          >
            Discard and leave
          </Button>
          <Button
            variant="ghost"
            compact
            data-testid="studio-leave-stay"
            onClick={studio.guard.cancel}
          >
            Stay
          </Button>
        </div>
      ) : null}
      {studio.conflict !== null ? (
        <div
          className="flex flex-wrap items-center gap-[8px] border-b border-line bg-st-failed-pale-body px-4 py-2"
          data-testid="studio-conflict-banner"
        >
          <span className="font-mono text-[11px] text-st-failed-pale-fg">
            stale draft: the server is at v{studio.conflict.currentVersion}, your save targeted v
            {studio.savedVersion}
          </span>
          <Button
            variant="secondary"
            compact
            data-testid="studio-conflict-reload"
            onClick={studio.reloadTheirs}
          >
            Reload theirs
          </Button>
          <Button
            variant="secondary"
            compact
            data-testid="studio-conflict-overwrite"
            onClick={() => void studio.overwrite()}
          >
            Keep mine and overwrite
          </Button>
        </div>
      ) : null}
      {studio.saveError ? (
        <ProblemBanner
          error={studio.saveError}
          fallback="The draft could not be saved."
          testid="studio-save-error"
        />
      ) : null}
      {opError !== null ? (
        <div
          role="alert"
          className="border-b border-line bg-st-failed-pale-body px-4 py-1.5 font-mono text-[11px] text-st-failed-pale-fg"
          data-testid="studio-op-error"
        >
          {opError}
        </div>
      ) : null}
      {publishNote !== null ? (
        <p
          className="border-b border-line px-4 py-1.5 font-mono text-[11px] text-muted"
          data-testid="studio-published"
        >
          {publishNote}
        </p>
      ) : null}
      {publishFailure !== null ? (
        <FormError error={publishFailure} testid="studio-publish-error" />
      ) : null}

      {narrow ? (
        <div className="grid flex-1 grid-cols-1 grid-rows-2 gap-3 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-1">
          <div className="min-w-0 overflow-auto rounded-[3px] border border-line bg-surface p-3">
            {view === "yaml" ? (
              yaml
            ) : (
              <StepOutline
                model={model}
                selectedId={selectedId}
                selectedIds={selectedIds}
                onToggleSelect={readOnly ? undefined : toggleSelect}
                readOnly={readOnly}
                onSelect={selectOne}
                onAddAfter={handleAddAfter}
                onWrap={readOnly ? undefined : handleWrap}
                onUnwrap={readOnly ? undefined : handleUnwrap}
              />
            )}
          </div>
          <div className="min-w-0 overflow-auto rounded-[3px] border border-line bg-surface p-3">
            {inspector}
          </div>
          {drawers}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[220px] shrink-0 overflow-auto border-r border-line bg-surface">
            <StudioPalette
              selectedId={selectedId}
              readOnly={readOnly}
              stale={!parseOk}
              onAddAfter={readOnly ? undefined : handleAddAfter}
            />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-[480px] flex-1 overflow-hidden">
              {view === "yaml" ? (
                yaml
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  <SelectionToolbar
                    variant="toolbar"
                    selectedIds={selectedIds}
                    model={model}
                    readOnly={readOnly}
                    onWrap={handleWrap}
                    onUnwrap={handleUnwrap}
                  />
                  <div className="min-h-0 flex-1">{canvas}</div>
                </div>
              )}
            </div>
            {drawers}
          </main>
          <aside className="w-[360px] shrink-0 overflow-auto border-l border-line bg-surface">
            {inspector}
          </aside>
        </div>
      )}

      {ambiguity !== null ? (
        <AmbiguityDialog
          title={ambiguity.title}
          reasons={ambiguity.reasons}
          onInsertAnyway={ambiguity.rerun}
          onCancel={() => setAmbiguity(null)}
        />
      ) : null}
    </div>
  );
}

export default StudioPage;
