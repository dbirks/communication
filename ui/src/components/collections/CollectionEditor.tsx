/**
 * The collection editor (Manage → Agents & models → Skills → a collection,
 * `?item=<id>`, ADR-0084).
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
import { Alert } from "../ds/Alert";
import { ProblemBanner, Spinner } from "../Feedback";
import { problemOf } from "../../api/client";
import {
  createRevision,
  invalidateCollections,
  publishRevision,
  useApmCollection,
  validateCollectionRef,
  type APMCollectionEntry,
} from "../../api/apmCollections";
import { routes } from "../../lib/routes";

/* The Manage chrome (docs/design/redesign/CONTRACT.md): the table header is
 * the mono section label, rows divide on `line-soft`, the card corner is 10px
 * and an input takes 8px with a 1px line-strong edge. */
const TABLE_HEAD =
  "pt-[8px] pr-3 pb-[8px] pl-0 border-b border-line text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted whitespace-nowrap";
const TABLE_CELL = "pt-[10px] pr-3 pb-[10px] pl-0 align-top text-[13px] border-b border-line-soft";
const SOFT_INPUT =
  "w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[6px] font-mono text-[12.5px] text-ink placeholder:text-faint max-[560px]:min-h-[44px] focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";
const ROW_CONTROL =
  "rounded-[6px] p-[2px] text-muted hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

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
      <div data-testid="collection-editor-loading">
        <SkillsBackLink />
        <div className="pt-[12px]">
          <Spinner label="Loading the collection" />
        </div>
      </div>
    );
  }
  if (detailQuery.isError || !detail) {
    return (
      <div data-testid="collection-editor-error">
        <SkillsBackLink />
        <div className="pt-[12px]">
          <ProblemBanner
            error={detailQuery.error ?? new Error("not found")}
            fallback="This collection could not be read."
          />
        </div>
      </div>
    );
  }

  const collection = detail.collection;
  return (
    <div data-testid="collection-editor">
      <SkillsBackLink />
      <header className="flex flex-wrap items-start justify-between gap-[10px] pt-[6px]">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-[8px] text-[20px] font-bold leading-[1.25] text-ink">
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
          </h2>
          <p className="mt-1 max-w-[720px] text-[13.5px] text-muted">{collection.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-[8px]">
          <button
            type="button"
            className="ds-btn ds-btn--secondary ds-btn--tall"
            disabled={!dirty || busy !== null}
            onClick={() => void saveDraft()}
            data-testid="collection-save-draft"
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--primary ds-btn--tall"
            disabled={publishable === null || busy !== null || dirty}
            onClick={() => setConfirmOpen(true)}
            data-testid="collection-publish"
          >
            {busy === "publish" ? "Publishing…" : publishLabel}
          </button>
        </div>
      </header>
      <div className="pt-[14px]">
        {dirty ? (
          <p className="font-mono text-[11px] text-muted" data-testid="collection-editor-dirty">
            unsaved edits — Save draft lands them as r{highest + 1}
          </p>
        ) : null}
        <div className="overflow-hidden rounded-[10px] border border-line bg-surface px-[12px]">
          <table className="w-full border-collapse text-left" data-testid="collection-entries">
            <thead>
              <tr>
                <th className={`${TABLE_HEAD} w-[64px]`}>#</th>
                <th className={TABLE_HEAD}>ref</th>
                <th className={TABLE_HEAD}>skills</th>
                <th className={TABLE_HEAD}>note</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr
                  key={`${index}:${entry.ref}`}
                  className="align-top"
                  data-testid={`collection-entry-${index}`}
                >
                  <td className={TABLE_CELL}>
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
                        className={ROW_CONTROL}
                      >
                        <IconArrowUp size={14} stroke={1.7} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${entry.ref} down`}
                        disabled={index === entries.length - 1}
                        onClick={() => move(index, 1)}
                        data-testid={`collection-entry-down-${index}`}
                        className={ROW_CONTROL}
                      >
                        <IconArrowDown size={14} stroke={1.7} aria-hidden="true" />
                      </button>
                    </span>
                  </td>
                  <td className={`${TABLE_CELL} font-mono text-[12px] break-all text-ink-2`}>
                    {entry.ref}
                  </td>
                  <td className={TABLE_CELL}>
                    {(entry.skills ?? []).length === 0 ? (
                      <span className="font-mono text-[11px] text-faint">all</span>
                    ) : (
                      <span className="flex flex-wrap gap-[3px]">
                        {entry.skills?.map((skill) => (
                          <span
                            key={skill}
                            className="rounded-[6px] border border-line px-[5px] py-[1px] font-mono text-[10.5px] text-ink-2"
                          >
                            {skill}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className={`${TABLE_CELL} text-[12px] text-muted`}>{entry.note ?? ""}</td>
                </tr>
              ))}
              {entries.length === 0 ? (
                <tr data-testid="collection-entries-empty">
                  <td colSpan={4} className={`${TABLE_CELL} font-mono text-[11px] text-faint`}>
                    no packages — this collection stages nothing
                  </td>
                </tr>
              ) : null}
              <tr data-testid="collection-add-row">
                <td className={TABLE_CELL} />
                <td className={`${TABLE_CELL} pr-[6px]`}>
                  <div className="flex items-center gap-[6px]">
                    <input
                      type="text"
                      aria-label="Add package ref"
                      value={refDraft}
                      placeholder="owner/repo[/path]#tag-or-sha"
                      onChange={(event) => {
                        setRefDraft(event.target.value);
                        if (refError !== null) setRefError(null);
                      }}
                      className={`${SOFT_INPUT} min-w-0 flex-1 font-mono`}
                      data-testid="collection-add-ref"
                    />
                    <button
                      type="button"
                      className="ds-btn ds-btn--secondary ds-btn--compact"
                      onClick={addPackage}
                      data-testid="collection-add-package"
                    >
                      <IconPlus size={14} stroke={1.7} aria-hidden="true" />
                      Add package
                    </button>
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
                <td className={TABLE_CELL} />
                <td className={`${TABLE_CELL} border-b-0`} />
              </tr>
            </tbody>
          </table>
        </div>
        {problem ? (
          <Alert state="failed" label="REFUSED" role="alert" testid="collection-editor-problem">
            {problemOf(problem).detail || problemOf(problem).title}
          </Alert>
        ) : null}
      </div>
      {confirmOpen && publishable !== null ? (
        <CollectionPublishDialog
          revision={publishable}
          line={confirmLine}
          busy={busy === "publish"}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void publish(publishable)}
        />
      ) : null}
    </div>
  );
}

/** The way back to the Skills grid: keeps `tab=skills`, drops `item`. */
function SkillsBackLink() {
  return (
    <Link
      to={routes.collections()}
      className="inline-block text-[12.5px] text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      data-testid="collection-editor-back"
    >
      ← Skills
    </Link>
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
        className="mt-[10vh] w-full max-w-[440px] rounded-[14px] border border-line bg-surface p-[16px] shadow-[var(--shadow-modal)] max-md:mt-auto max-md:rounded-b-none"
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
          <button
            type="button"
            className="ds-btn ds-btn--ghost"
            onClick={onCancel}
            data-testid="collection-publish-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            disabled={busy}
            onClick={() => void onConfirm()}
            data-testid="collection-publish-confirm"
          >
            {busy ? "Publishing…" : `Publish r${revision}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CollectionEditor;
