/**
 * The skill-collection library (ADR-0084) as Manage → Agents & models → Skills
 * (redesign R7/R8): the org's library of named, versioned skill bundles, drawn
 * as the redesign's card grid (1px hairline, 10px corner, mono kicker,
 * two-line clamp).
 *
 * It is embedded-only: it draws no Page band, no title and no tab strip — the
 * old `Workflows | Steps | Collections` row went with the unrouted Workflows
 * index (rx-r8-pages) — the New collection button is a right-aligned row at the
 * top of the body, and a selected collection travels in `?item=<id>`: the old
 * `/workflows/collections[/:id]` URLs redirect to this tab (`lib/routes.ts`), so
 * no route param is ever read here. With `item` set the body is that
 * collection's editor (components/collections/CollectionEditor.tsx) in place of
 * the grid, with a `← Skills` link back; without it, the card grid. Cards link
 * to `routes.collection(id)` — the same tab with `item` set.
 *
 * Honest reads only:
 * - The list's `404` means the server lacks the endpoint — an info Alert, not
 *   an error (the nodeTemplates convention).
 * - `used by N profiles` is joined client-side from the agent-profiles read —
 *   the read that carries the ordered `apm_collections` pins. No field for it
 *   exists on the wire, so none is invented.
 * - Writing needs the library role (same gate as workflows): a member without
 *   it reads the library but sees no `New collection`.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { SoftButton } from "../../../components/ds/SoftButton";
import { Field } from "../../../components/ds/Field";
import { Alert } from "../../../components/ds/Alert";
import { Spinner } from "../../../components/Feedback";
import { problemOf } from "../../../api/client";
import { useAgentProfiles, useMe } from "../../../api/queries";
import {
  collectionRoute,
  createCollection,
  invalidateCollections,
  useApmCollections,
  type APMCollection,
} from "../../../api/apmCollections";
import { CollectionCard } from "../../../components/collections/CollectionCard";
import { CollectionEditor } from "../../../components/collections/CollectionEditor";
import { hasLibraryRole, LIBRARY_ROLE_LABEL } from "../../../lib/pipeline/authoring";
import { routes } from "../../../lib/routes";

/** The redesign's input (docs/design/redesign/README.md "Design tokens"): 8px
 * corner, 1px line-strong — the old `ds/Field` hairline stays for kept pages. */
const SOFT_INPUT =
  "w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[6px] font-mono text-[12.5px] text-ink placeholder:text-faint max-[560px]:min-h-[44px] focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";

export default function Collections() {
  const [searchParams] = useSearchParams();
  const itemId = searchParams.get("item");
  if (itemId !== null && itemId !== "") return <SkillDetail collectionId={itemId} />;
  return <CollectionsList />;
}

/**
 * The chosen collection (`?item=<id>`): the editor replaces the grid inside the
 * same tab body. The library read answers "is there such a collection" without
 * a second request; while it is still landing (or re-landing after a create)
 * the editor's own loading state covers the gap, and when the library itself is
 * unreadable the editor's error state does.
 */
function SkillDetail({ collectionId }: { collectionId: string }) {
  const collections = useApmCollections();
  if (
    collections.data !== null &&
    !collections.isPending &&
    !collections.isFetching &&
    !collections.isError &&
    !(collections.data.collections ?? []).some((item) => item.id === collectionId)
  ) {
    return (
      <div data-testid="collections-item-missing">
        <p className="max-w-[560px] text-[12.5px]" role="status">
          That skill collection doesn&apos;t exist.
        </p>
        <SkillsBackLink />
      </div>
    );
  }
  return <CollectionEditor collectionId={collectionId} />;
}

/** The way back to the grid: keeps `tab=skills`, drops `item`. */
function SkillsBackLink() {
  return (
    <p className="pt-[8px]">
      <Link
        to={routes.collections()}
        className="inline-block text-[12.5px] text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid="collections-back-to-grid"
      >
        ← Skills
      </Link>
    </p>
  );
}

function CollectionsList() {
  const me = useMe();
  const canAuthor = hasLibraryRole(me.data);
  const collections = useApmCollections();
  const profiles = useAgentProfiles();
  const [newOpen, setNewOpen] = useState(false);

  const items = collections.data?.collections ?? [];
  // `used by N profiles`: how many profiles the CALLER can see pin this
  // collection at any revision. The profile list is the only read carrying
  // the pins, so the join lives here.
  const usedByCollection = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of profiles.data?.items ?? []) {
      const seen = new Set<string>();
      for (const pin of profile.apm_collections ?? []) {
        if (!seen.has(pin.collection_id)) {
          seen.add(pin.collection_id);
          counts.set(pin.collection_id, (counts.get(pin.collection_id) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [profiles.data]);

  const content = (
    <>
      {collections.isPending ? (
        <Spinner label="Loading the collection library" />
      ) : collections.isError ? (
        <Alert state="failed" label="UNAVAILABLE" testid="collections-error">
          {problemOf(collections.error).title || "The collection library could not be read."}
        </Alert>
      ) : collections.data === null ? (
        <Alert state="info" label="NOT AVAILABLE YET" testid="collections-registry-unavailable">
          This server does not expose the collection library yet. Published collections will appear
          here once it does.
        </Alert>
      ) : items.length === 0 ? (
        <p className="max-w-[560px] text-[12.5px]" data-testid="collections-empty">
          No collections yet. Bundle skill packages once, attach them to any agent.
        </p>
      ) : (
        <div
          className="grid gap-[10px] sm:grid-cols-2 xl:grid-cols-3"
          data-testid="collections-grid"
        >
          {items.map((collection: APMCollection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              usedByProfiles={usedByCollection.get(collection.id) ?? 0}
            />
          ))}
        </div>
      )}
    </>
  );

  return (
    <div data-testid="collections-embedded">
      <div className="flex items-center justify-end">
        {canAuthor ? (
          <SoftButton
            variant="primary"
            size="lg"
            onClick={() => setNewOpen(true)}
            data-testid="collections-new"
          >
            New collection
          </SoftButton>
        ) : (
          <span className="font-mono text-[10.5px] text-faint">
            authoring needs {LIBRARY_ROLE_LABEL}
          </span>
        )}
      </div>
      <div className="pt-[12px]">{content}</div>
      <NewCollectionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

/** The create dialog: identity + an empty revision-1 draft. Entries are added
 * in the editor — a new collection starts as a name waiting for packages. */
export function NewCollectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  if (!open) return null;

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugLooksOff = effectiveSlug !== "" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(effectiveSlug);
  const canSubmit = name.trim() !== "" && effectiveSlug !== "" && !slugLooksOff && !busy;

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      const created = await createCollection({
        slug: effectiveSlug,
        name: name.trim(),
        description: description.trim(),
        entries: [],
      });
      invalidateCollections(queryClient, created.id);
      onClose();
      navigate(collectionRoute(created.id));
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  }

  const problemText = problem ? problemOf(problem) : null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="collections-new-title"
        className="mt-[10vh] w-full max-w-[440px] rounded-[18px] border border-line bg-surface p-[16px] shadow-[var(--shadow-modal)] max-md:mt-auto max-md:rounded-b-none"
        data-testid="collections-new-dialog"
      >
        <h2
          id="collections-new-title"
          className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint"
        >
          New collection
        </h2>
        <form
          className="space-y-[10px] pt-[10px]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field id="collection-new-name" label="name">
            <input
              id="collection-new-name"
              type="text"
              value={name}
              placeholder="Matt Pocock skills"
              onChange={(event) => setName(event.target.value)}
              className={SOFT_INPUT}
              data-testid="collections-new-name"
            />
          </Field>
          <Field
            id="collection-new-slug"
            label="slug"
            hint={
              slugLooksOff ? (
                <span className="font-mono text-[11px] text-st-failed-tag-fg" role="status">
                  looks off — lowercase letters, digits, `-` or `_`, starting with a letter or digit
                </span>
              ) : (
                <span className="font-mono text-[11px] text-muted">
                  a URL segment, unique in the org
                </span>
              )
            }
          >
            <input
              id="collection-new-slug"
              type="text"
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
              className={`${SOFT_INPUT} font-mono`}
              data-testid="collections-new-slug"
            />
          </Field>
          <Field id="collection-new-description" label="description">
            <input
              id="collection-new-description"
              type="text"
              value={description}
              placeholder="What this bundle gives an agent"
              onChange={(event) => setDescription(event.target.value)}
              className={SOFT_INPUT}
              data-testid="collections-new-description"
            />
          </Field>
          <p className="text-[11.5px] text-muted">
            The collection lands as a draft with no packages — add and pin them in the editor.
          </p>
          {problemText ? (
            <Alert state="failed" label="REFUSED" role="alert" testid="collections-new-problem">
              {problemText.detail || problemText.title}
            </Alert>
          ) : null}
          <div className="flex justify-end gap-[8px] pt-[4px]">
            <SoftButton variant="ghost" onClick={onClose} data-testid="collections-new-cancel">
              Cancel
            </SoftButton>
            <SoftButton
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              data-testid="collections-new-submit"
            >
              {busy ? "Creating…" : "Create collection"}
            </SoftButton>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The name → slug suggestion the dialog shows until the writer edits it. The
 * server's CHECK grammar owns the final answer; this only pre-fills. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
