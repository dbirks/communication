/**
 * The collection editor (`/workflows/collections/:id`, ADR-0084).
 *
 * A collection is an ORDERED list of pinned refs; this page is that list.
 * Revisions are immutable once published (ADR-0002's rule restated), so the
 * editor never rewrites a revision in place: `Save draft` posts a NEW draft
 * revision one past the highest, and `Publish r{n}` is its own deliberate act
 * behind a confirm — publishing must not move what an existing profile
 * resolves, which is why profiles pin an exact revision (ADR-0058's rule).
 *
 * The confirm's words are the whole ordering story:
 *   "Profiles keep using r3 until you re-attach r4."
 *
 * The ref add-row validates with the client-side mirror of the worker grammar
 * (`validateCollectionRef`): a tag or a full 40-char SHA, never a branch —
 * the same refusal the server answers with, surfaced before the write.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconPlus } from "@tabler/icons-react";
import Page from "../ds/Page";
import { Button } from "../ds/Button";
import { Input } from "../ds/Field";
import { Alert } from "../ds/Alert";
import { ProblemBanner, Spinner } from "../Feedback";
import { problemOf } from "../../api/client";
import {
  collectionsRoute,
  createRevision,
  invalidateCollections,
  publishRevision,
  useApmCollection,
  validateCollectionRef,
  type APMCollectionEntry,
} from "../../api/apmCollections";
import { WorkflowsTabs } from "../../pages/Workflows";

export interface CollectionEditorProps {
  collectionId: string;
}

export function CollectionEditor({ collectionId }: CollectionEditorProps) {
  const queryClient = useQueryClient();
  const detailQuery = useApmCollection(collectionId);
  const detail = detailQuery.data;
  const latest = detail?.revisions[0];

  const [entries, setEntries] = useState<APMCollectionEntry[]>([]);
  const [savedEntries, setSavedEntries] = useState<APMCollectionEntry[] | null>(null);
  const [refDraft, setRefDraft] = useState("");
  const [refError, setRefError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Seed the editor from the newest revision once it lands (and if the list
  // read is ever refetched to a different newest revision while nothing is
  // pending, follow it — a pending edit is the reader's, never overwritten).
  useEffect(() => {
    if (latest && savedEntries === null) {
      setEntries(latest.entries);
      setSavedEntries(latest.entries);
    }
  }, [latest, savedEntries]);

  const dirty = useMemo(
    () => savedEntries !== null && JSON.stringify(entries) !== JSON.stringify(savedEntries),
    [entries, savedEntries],
  );

  const highest = latest?.revision ?? 0;
  const draftRevision = latest && latest.status === "draft" ? latest.revision : null;
  const lastPublished = detail?.revisions.find((revision) => revision.status === "published");
  // What a publish would flip RIGHT NOW: the open draft, or the revision the
  // next `Save draft` would create.
  const publishable = draftRevision ?? (dirty ? highest + 1 : null);
  const publishLabel = `Publish r${publishable ?? highest + 1}`;
  const confirmLine =
    publishable !== null && lastPublished
      ? `Profiles keep using r${lastPublished.revision} until you re-attach r${publishable}.`
      : publishable !== null
        ? `Nothing can attach this collection until you publish r${publishable}.`
        : "";

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    setEntries((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function addPackage() {
    const error = validateCollectionRef(refDraft);
    if (error !== null) {
      setRefError(error);
      return;
    }
    setRefError(null);
    setEntries((current) => [...current, { ref: refDraft.trim() }]);
    setRefDraft("");
  }

  async function saveDraft() {
    setBusy("save");
    setProblem(null);
    try {
      const revision = await createRevision(collectionId, entries);
      setSavedEntries(revision.entries);
      setEntries(revision.entries);
      invalidateCollections(queryClient, collectionId);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  }

  async function publish(revision: number) {
    setBusy("publish");
    setProblem(null);
    try {
      await publishRevision(collectionId, revision);
      setConfirmOpen(false);
      invalidateCollections(queryClient, collectionId);
    } catch (error) {
      setConfirmOpen(false);
      setProblem(error);
    } finally {
      setBusy(null);
    }
  }

  if (detailQuery.isPending) {
    return (
      <Page
        layout="wide"
        testid="collection-editor-loading"
        title="Collection"
        band={<WorkflowsTabs active="collections" />}
      >
        <Spinner label="Loading the collection" />
      </Page>
    );
  }
  if (detailQuery.isError || !detail) {
    return (
      <Page
        layout="wide"
        testid="collection-editor-error"
        title="Collection"
        band={<WorkflowsTabs active="collections" />}
      >
        <ProblemBanner
          error={detailQuery.error ?? new Error("not found")}
          fallback="This collection could not be read."
        />
      </Page>
    );
  }

  const collection = detail.collection;
  return (
    <Page
      layout="wide"
      testid="collection-editor"
      title={
        <span className="flex flex-wrap items-center gap-[8px]">
          {collection.name}
          <span
            className="font-mono text-[10.5px] font-normal text-muted"
            data-testid="collection-revision-chip"
          >
            {latest
              ? latest.status === "published"
                ? `r${latest.revision} published`
                : "draft"
              : "no revision"}
          </span>
        </span>
      }
      breadcrumb={
        <Link
          to={collectionsRoute}
          className="text-[12px] text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="collection-editor-back"
        >
          Collections
        </Link>
      }
      subtitle={<span>{collection.description}</span>}
      band={<WorkflowsTabs active="collections" />}
      actions={
        <div className="flex items-center gap-[8px]">
          <Button
            variant="secondary"
            disabled={!dirty || busy !== null}
            onClick={() => void saveDraft()}
            data-testid="collection-save-draft"
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </Button>
          <Button
            variant="primary"
            disabled={publishable === null || busy !== null || dirty}
            onClick={() => setConfirmOpen(true)}
            data-testid="collection-publish"
          >
            {busy === "publish" ? "Publishing…" : publishLabel}
          </Button>
        </div>
      }
    >
      {dirty ? (
        <p className="font-mono text-[11px] text-muted" data-testid="collection-editor-dirty">
          unsaved edits — Save draft lands them as r{highest + 1}
        </p>
      ) : null}
      <table className="w-full border-collapse text-left" data-testid="collection-entries">
        <thead>
          <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.06em] text-faint">
            <th className="w-[64px] p-[6px] font-semibold">#</th>
            <th className="p-[6px] font-semibold">ref</th>
            <th className="p-[6px] font-semibold">skills</th>
            <th className="p-[6px] font-semibold">note</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr
              key={`${index}:${entry.ref}`}
              className="border-b border-line align-top"
              data-testid={`collection-entry-${index}`}
            >
              <td className="p-[6px]">
                <span className="flex items-center gap-[2px]">
                  {/* The grip is the affordance; the arrows are how a keyboard
                      (and this build) actually moves a row. */}
                  <IconGripVertical
                    size={14}
                    stroke={1.7}
                    aria-hidden="true"
                    className="text-faint"
                  />
                  <button
                    type="button"
                    aria-label={`Move ${entry.ref} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    data-testid={`collection-entry-up-${index}`}
                    className="rounded-[3px] p-[2px] text-muted hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    <IconArrowUp size={14} stroke={1.7} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${entry.ref} down`}
                    disabled={index === entries.length - 1}
                    onClick={() => move(index, 1)}
                    data-testid={`collection-entry-down-${index}`}
                    className="rounded-[3px] p-[2px] text-muted hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    <IconArrowDown size={14} stroke={1.7} aria-hidden="true" />
                  </button>
                </span>
              </td>
              <td className="p-[6px] font-mono text-[12px] break-all text-ink-2">{entry.ref}</td>
              <td className="p-[6px]">
                {(entry.skills ?? []).length === 0 ? (
                  <span className="font-mono text-[11px] text-faint">all</span>
                ) : (
                  <span className="flex flex-wrap gap-[3px]">
                    {entry.skills?.map((skill) => (
                      <span
                        key={skill}
                        className="rounded-[3px] border border-line px-[5px] py-[1px] font-mono text-[10.5px] text-ink-2"
                      >
                        {skill}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td className="p-[6px] text-[12px] text-muted">{entry.note ?? ""}</td>
            </tr>
          ))}
          {entries.length === 0 ? (
            <tr data-testid="collection-entries-empty">
              <td colSpan={4} className="p-[10px] font-mono text-[11px] text-faint">
                no packages — this collection stages nothing
              </td>
            </tr>
          ) : null}
          <tr data-testid="collection-add-row">
            <td className="p-[6px]" />
            <td className="p-[6px]">
              <div className="flex items-center gap-[6px]">
                <Input
                  aria-label="Add package ref"
                  value={refDraft}
                  placeholder="owner/repo[/path]#tag-or-sha"
                  onChange={(event) => {
                    setRefDraft(event.target.value);
                    if (refError !== null) setRefError(null);
                  }}
                  className="min-w-0 flex-1 font-mono"
                  data-testid="collection-add-ref"
                />
                <Button
                  variant="secondary"
                  compact
                  onClick={addPackage}
                  data-testid="collection-add-package"
                >
                  <IconPlus size={14} stroke={1.7} aria-hidden="true" />
                  Add package
                </Button>
              </div>
              {refError ? (
                <p
                  role="alert"
                  className="pt-1 text-[11.5px] text-st-failed-tag-fg"
                  data-testid="collection-add-error"
                >
                  {refError}
                </p>
              ) : null}
            </td>
            <td className="p-[6px]" />
            <td className="p-[6px]" />
          </tr>
        </tbody>
      </table>
      {problem ? (
        <Alert state="failed" label="REFUSED" role="alert" testid="collection-editor-problem">
          {problemOf(problem).detail || problemOf(problem).title}
        </Alert>
      ) : null}
      {confirmOpen && publishable !== null ? (
        <CollectionPublishDialog
          revision={publishable}
          line={confirmLine}
          busy={busy === "publish"}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void publish(publishable)}
        />
      ) : null}
    </Page>
  );
}

/** The publish confirm. `role=dialog` + `aria-modal`, the same shell the
 * profile/library dialogs use. */
function CollectionPublishDialog({
  revision,
  line,
  busy,
  onCancel,
  onConfirm,
}: {
  revision: number;
  line: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-publish-title"
        className="mt-[10vh] w-full max-w-[440px] rounded-[4px] border border-line-strong bg-surface p-[14px]"
        data-testid="collection-publish-dialog"
      >
        <h2
          id="collection-publish-title"
          className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint"
        >
          Publish r{revision}
        </h2>
        <p className="mt-[8px] text-[12.5px] text-ink">{line}</p>
        <p className="mt-[6px] text-[11.5px] text-muted">
          A published revision is immutable — later edits land a new draft.
        </p>
        <div className="mt-[12px] flex justify-end gap-[8px]">
          <Button variant="ghost" onClick={onCancel} data-testid="collection-publish-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={onConfirm}
            data-testid="collection-publish-confirm"
          >
            {busy ? "Publishing…" : `Publish r${revision}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default CollectionEditor;
