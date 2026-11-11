/**
 * The Collections tab (`/workflows/collections`, ADR-0084): the org's library
 * of named, versioned skill bundles, drawn as the Workflows starter cards'
 * grid (same shell: hairline panel, 4px corner, mono kicker, two-line clamp)
 * and reached as the third `Workflows | Steps | Collections` tab.
 *
 * `/workflows/collections/:id` renders the editor (components/collections/
 * CollectionEditor.tsx) inside this same page frame — the Steps precedent.
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
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import Page from "../components/ds/Page";
import { Button } from "../components/ds/Button";
import { Field, Input } from "../components/ds/Field";
import { Alert } from "../components/ds/Alert";
import { Spinner } from "../components/Feedback";
import { problemOf } from "../api/client";
import { useAgentProfiles, useMe } from "../api/queries";
import {
  collectionRoute,
  createCollection,
  invalidateCollections,
  useApmCollections,
  type APMCollection,
} from "../api/apmCollections";
import { CollectionCard } from "../components/collections/CollectionCard";
import { CollectionEditor } from "../components/collections/CollectionEditor";
import { WorkflowsTabs } from "./Workflows";
import { hasLibraryRole, LIBRARY_ROLE_LABEL } from "../lib/pipeline/authoring";

export default function Collections() {
  const { id } = useParams<{ id: string }>();
  if (id !== undefined) return <CollectionEditor collectionId={id} />;
  return <CollectionsList />;
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

  return (
    <Page
      layout="wide"
      testid="collections-page"
      title="Collections"
      subtitle={
        <span>
          Named, pinned bundles of skill packages an agent profile attaches in an order of its
          choosing.
        </span>
      }
      band={<WorkflowsTabs active="collections" />}
      actions={
        canAuthor ? (
          <Button variant="primary" onClick={() => setNewOpen(true)} data-testid="collections-new">
            New collection
          </Button>
        ) : (
          <span className="font-mono text-[10.5px] text-faint">
            authoring needs {LIBRARY_ROLE_LABEL}
          </span>
        )
      }
    >
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
      <NewCollectionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </Page>
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
        className="mt-[10vh] w-full max-w-[440px] rounded-[4px] border border-line-strong bg-surface p-[14px]"
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
            <Input
              id="collection-new-name"
              value={name}
              placeholder="Matt Pocock skills"
              onChange={(event) => setName(event.target.value)}
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
            <Input
              id="collection-new-slug"
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
              className="font-mono"
              data-testid="collections-new-slug"
            />
          </Field>
          <Field id="collection-new-description" label="description">
            <Input
              id="collection-new-description"
              value={description}
              placeholder="What this bundle gives an agent"
              onChange={(event) => setDescription(event.target.value)}
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
            <Button variant="ghost" onClick={onClose} data-testid="collections-new-cancel">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              data-testid="collections-new-submit"
            >
              {busy ? "Creating…" : "Create collection"}
            </Button>
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
