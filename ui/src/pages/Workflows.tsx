/**
 * The org **Workflows** index (`/workflows`) — design 1b:
 * - Header: H1 `Workflows` + the mono count the list read carries,
 *   `Import YAML` (secondary) + `New workflow` (primary).
 * - Three starter cards above the filters: `START BLANK` (dashed border)
 *   and one card per vetted template, each showing the canvas step count
 *   the Studio will draw and the document's own top-level step chain.
 *   Clicking a card opens the New workflow dialog (1c) with that starter
 *   preselected.
 * - Filters: a 240px search field + chips `all` / `has open draft` /
 *   `used in <project>` — one chip per project whose assignments fan
 *   actually pins an indexed workflow; real data only, so the chips wait
 *   for the fan to settle.
 * - Folders (ADR-0049 § 8, filter since redesign finding 10): the wire's own
 *   `folder` values narrow the list through the toolbar's `All folders` select,
 *   which writes `?folder=`; the rows are one flat list (`WorkflowRow`), never
 *   grouped panels. A library with no folders carries no select.
 *
 * The 1a inline `NEW PIPELINE` form and the bottom `STARTER WORKFLOWS`
 * panel are gone: creation lives in `NewWorkflowDialog` (1c), which runs
 * the same two writes the inline form ran (pipeline first, draft second —
 * ADR-0002's logical create, then its first draft) and lands on the
 * Studio route.
 *
 * Honesty rules (gaps/library.md § 5), unchanged from the old page:
 * - A row is built from the same two reads the project page fans
 *   (`GET /pipelines/{id}` + its drafts list); nothing is invented beyond
 *   what the wire serves.
 * - The revision chip is the server's own `latest` summary — `✓ r{n}`
 *   (the digest moved to the workflow page) or `· draft · not published`.
 * - Duplicate is the client-side three writes the gap analysis settles on
 *   (U1) until a backend endpoint exists.
 * - Authoring controls (`New workflow`, the cards, import, duplicate)
 *   appear only for the library role: `01` gives definition-reading to
 *   every org member and publishing to org admins alone. Read-only users
 *   still see the cards, disabled, with the one-line reason.
 */
import { useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import {
  IconClipboardText,
  IconEyeCheck,
  IconGitPullRequest,
  IconNotebook,
  IconPlus,
  IconShieldLock,
  IconStack2,
} from "@tabler/icons-react";
import { Button } from "../components/ds/Button";
import { Input, Select } from "../components/ds/Field";
import Page from "../components/ds/Page";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { apiFetch } from "../api/client";
import { queryKeys, useMe, useProjects } from "../api/queries";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  revisionQueryOptions,
  schedulesQueryOptions,
  useDuplicatePipeline,
  usePipelines,
  UNFILED_FOLDER,
  distinctFolders,
  folderLabel,
  workflowRowFacts,
} from "../api/pipelines";
import type { AssignmentList, Draft, PipelineSummary } from "../api/types";
import { isDefinitionDocument } from "../lib/pipeline/definition";
import { routes } from "../lib/routes";
import { WorkflowRow, MoveToFolderDialog } from "../components/workflows/WorkflowRow";
import { ImportYamlDialog } from "../components/workflows/ImportYamlDialog";
import { NewWorkflowDialog } from "../components/workflows/NewWorkflowDialog";
import { hasLibraryRole, LIBRARY_ROLE_LABEL } from "../lib/pipeline/authoring";
import { openAssistantPopover } from "../components/assistant/AssistantPopover";
import {
  PIPELINE_TEMPLATES,
  templateChain,
  type PipelineTemplate,
  type TemplateId,
} from "../lib/pipeline/templates";

/* ------------------------------------------------------------- /workflows */

/**
 * The Workflows page's header tabs (finding 02): `Workflows | Steps`. Items
 * are routes, not fragments — `/workflows` and `/workflows/steps` — and the
 * strip is the same link-on-the-band pattern the workflow page's tabs use
 * (`pages/Workflow.tsx`): a tab sits on the header's bottom border, the
 * active one is inked and bold.
 */
export function WorkflowsTabs({ active }: { active: "workflows" | "steps" | "collections" }) {
  const tabs = [
    { key: "workflows", label: "Workflows", to: routes.workflows() },
    { key: "steps", label: "Steps", to: routes.steps() },
    { key: "collections", label: "Collections", to: "/workflows/collections" },
  ] as const;
  return (
    <nav
      aria-label="Workflows page"
      className="-mb-px flex gap-[4px] border-b border-line"
      data-testid="workflows-tabs"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          aria-current={active === tab.key ? "page" : undefined}
          data-testid={`workflows-tab-${tab.key}`}
          className={`shrink-0 whitespace-nowrap rounded-t-[3px] border px-[12px] pt-[6px] pb-[7px] text-[13px] no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            active === tab.key
              ? "border-ink border-b-paper bg-paper font-semibold text-ink"
              : "border-transparent text-muted hover:text-ink"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/** The section label above a block of the page (design: mono 10.5px, uppercase,
 * letterspaced, the faintest ink on the page — a label, not a heading). */
function SectionLabel({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <p
      className="mb-[8px] font-mono text-[10.5px] uppercase tracking-[.06em] text-faint"
      data-testid={testid}
    >
      {children}
    </p>
  );
}

/**
 * The card grid's shared shell: 148px tall, 4px corner, a flex column whose last
 * text row sits at the bottom (`mt-auto` on the chain), and the app's focus ring.
 * A template card carries an ink hairline that darkens to ink on hover; the Blank
 * card carries the dashed edge, because it is the absence of a template.
 */
const STARTER_CARD_CLASS =
  "flex min-h-[148px] flex-col rounded-[4px] bg-surface p-[14px] text-left " +
  // The app shell's phone rule centres every `main button`'s flex children; a
  // card's copy is left-aligned at every width (reflow-390 item 1), so the card
  // claims its own cross-axis alignment back below 560px.
  "max-[559px]:items-start! focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-60";

/** The template's own Tabler icon, by the name `templates.ts` carries. An unknown
 * name draws the notebook rather than nothing: the card always has its tile. */
const TEMPLATE_ICONS: Record<string, ComponentType<{ size?: number; stroke?: number }>> = {
  IconPlus,
  IconNotebook,
  IconShieldLock,
  IconGitPullRequest,
  IconClipboardText,
  IconStack2,
  IconEyeCheck,
};

/** One chip on a card: solid for what the template IS (an agent, a collection),
 * dashed + `needs ` for what it REQUIRES and this org may not have. */
function StarterChip({ need = false, children }: { need?: boolean; children: ReactNode }) {
  return (
    <span
      className={
        need
          ? "rounded-[3px] border border-dashed border-line px-[5px] py-[1px] font-mono text-[10.5px] text-muted"
          : "rounded-[3px] border border-line px-[5px] py-[1px] font-mono text-[10.5px] text-ink-2"
      }
    >
      {need ? `needs ${children}` : children}
    </span>
  );
}

/** Blank's own words — the card is a starting point, not a sample, so it does not
 * quote the skeleton's build note (the same reason `starterHint` refuses it in the
 * New workflow dialog: a person choosing a start is not being told how the file is
 * assembled). */
const BLANK_CARD_TITLE = "Empty canvas";
const BLANK_CARD_LINE = "One agent step to start from.";

/**
 * One starter card: the icon tile and the step kicker, the name, what it does, the
 * document's own chain, and the chips saying which agents and collections it runs
 * on and what it needs first. Clicking opens the New workflow dialog with this
 * starter selected; a reader without the library role sees the cards inert, with
 * the one-line reason below the grid.
 */
function StarterCard({
  template,
  canAuthor,
  onPick,
  testid,
}: {
  template: PipelineTemplate;
  canAuthor: boolean;
  onPick: () => void;
  /** The card's test handle: `workflow-starter-blank` written out for Blank, the
   * template id for a sample. */
  testid: string;
}) {
  const blank = template.id === "blank";
  const chain = blank ? "" : templateChain(template);
  const Icon = TEMPLATE_ICONS[template.icon] ?? IconNotebook;
  const chips = blank ? [] : [...template.agents, ...template.collections];
  return (
    <button
      type="button"
      disabled={!canAuthor}
      onClick={onPick}
      className={`${STARTER_CARD_CLASS} ${
        blank ? "border border-dashed border-line-strong" : "border border-line hover:border-ink"
      }`}
      data-testid={testid}
    >
      <span className="flex items-center gap-[8px]">
        {/* The tile is decoration beside the kicker's words — the kicker names the
            starter, so the icon is hidden from the accessibility tree. */}
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] bg-fill text-ink-2"
        >
          <Icon size={16} stroke={1.7} />
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
          {blank
            ? "START BLANK"
            : template.stepCount === null
              ? "TEMPLATE"
              : `TEMPLATE · ${template.stepCount} ${template.stepCount === 1 ? "STEP" : "STEPS"}`}
        </span>
      </span>
      <span className="mt-[8px] text-[14px] font-semibold text-ink">
        {blank ? BLANK_CARD_TITLE : template.label}
      </span>
      <span className="mt-[2px] line-clamp-2 text-[12.5px] leading-[17px] text-muted">
        {blank ? BLANK_CARD_LINE : template.description}
      </span>
      {chain ? (
        <span className="mt-auto block w-full min-w-0 truncate pt-[8px] font-mono text-[11px] text-faint">{chain}</span>
      ) : null}
      {chips.length > 0 || template.needs.length > 0 ? (
        <span className="mt-[8px] flex flex-wrap gap-[4px]">
          {chips.map((chip) => (
            <StarterChip key={chip}>{chip}</StarterChip>
          ))}
          {template.needs.map((need) => (
            <StarterChip key={`need:${need}`} need>
              {need}
            </StarterChip>
          ))}
        </span>
      ) : null}
    </button>
  );
}

/** The filter chip: a pressed state a screen reader hears (`aria-pressed`)
 * and a keyboard can reach (the ds focus ring). */
function FilterChip({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "rounded-[3px] border border-ink bg-ink px-[8px] py-[3px] font-mono text-[10.5px] text-surface"
          : "rounded-[3px] border border-line bg-surface px-[8px] py-[3px] font-mono text-[10.5px] text-ink hover:border-line-strong"
      }
      data-testid={testid}
    >
      {children}
    </button>
  );
}

export function LibraryPage() {
  const navigate = useNavigate();
  const me = useMe();
  const pipelines = usePipelines();
  const projects = useProjects();
  const canAuthor = hasLibraryRole(me.data);
  // Finding 10: folders are no longer a sidebar layout or a saved preference —
  // they are a filter on this page. The `?folder=` param stays the page's own
  // source of truth (an old bookmark still lands filtered), and the toolbar
  // select writes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const folderFilter = searchParams.get("folder") ?? "";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "has-draft">("all");
  const [usedInProject, setUsedInProject] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [newWorkflow, setNewWorkflow] = useState<{ open: boolean; preset: TemplateId | null }>({
    open: false,
    preset: null,
  });
  const [moveTarget, setMoveTarget] = useState<PipelineSummary | null>(null);

  const items = pipelines.data?.pipelines ?? [];
  const ids = items.map((pipeline) => pipeline.id);
  // One fan keyed exactly like the single-read hooks (as the project page does).
  const definitions = useQueries({ queries: ids.map(pipelineQueryOptions) });
  const draftsList = useQueries({ queries: ids.map(pipelineDraftsQueryOptions) });

  // The step chain needs the latest revision's canonical document: route 13
  // resolves a digest, so the fan keys on each row's newest summary digest.
  const latestDigests = items.map(
    (_pipeline, index) => definitions[index]?.data?.revisions[0]?.revision_digest ?? "",
  );
  const revisionFan = useQueries({ queries: latestDigests.map(revisionQueryOptions) });

  // Folders (ADR-0049 § 8): the wire's own `folder` values, grouped
  // client-side; a `null`/empty renders as the Unfiled group, last. The
  // counts are the list read's own rows — nothing is invented.

  // The assignments fan the rows share: every project the caller belongs to,
  // keyed exactly like the project page's reads so the cache is shared. The
  // schedules fan arms only for projects that actually pin an indexed
  // workflow — a `manual` trigger costs one assignments read, not two.
  const projectItems = projects.data?.items ?? [];
  const indexIds = new Set(ids);
  const assignmentsFan = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
    })),
  });
  const schedulesFan = useQueries({
    queries: projectItems.map((project, index) =>
      schedulesQueryOptions(
        project.id,
        (assignmentsFan[index]?.data?.assignments ?? []).some((assignment) =>
          indexIds.has(assignment.pipeline_id),
        ),
      ),
    ),
  });

  const duplicate = useDuplicatePipeline(items.map((pipeline) => pipeline.slug));

  // Both dialog folder pickers take the wire's distinct REAL folder values
  // (alphabetical) — never the `Unfiled` sentinel, which is a group LABEL:
  // `Move to folder…` owns the one Unfiled quick-pick and writes `null` (#27).
  // `folderNames` keeps the label, because there a label IS a group: the
  // `?folder=` filter the sidebar's folder links set.
  const realFolderNames = useMemo(() => distinctFolders(items), [items]);
  const folderNames = useMemo(() => {
    const names = [...realFolderNames];
    if (items.some((pipeline) => !pipeline.folder || pipeline.folder.length === 0)) {
      names.push(UNFILED_FOLDER);
    }
    return names;
  }, [realFolderNames, items]);
  const effectiveFolderFilter =
    folderFilter && folderNames.includes(folderFilter) ? folderFilter : "";

  // `used in <project>` chips: only projects whose assignments fan actually
  // pins an indexed workflow — and only once the fan has settled, so a
  // still-reading fan never reads as "nothing is used anywhere".
  const assignmentsData = assignmentsFan.map((entry) => entry?.data);
  const assignmentsSettled =
    projectItems.length === 0 ||
    (assignmentsData.every((data) => data !== undefined) &&
      assignmentsFan.every((entry) => !entry?.isError));
  const usedByProjects = projectItems.filter((_project, index) =>
    (assignmentsData[index]?.assignments ?? []).some((assignment) =>
      indexIds.has(assignment.pipeline_id),
    ),
  );

  // A draft-only row's step chain reads its newest un-published draft's own
  // document — the same `GET /drafts/{id}` the draft editor uses. Rows with a
  // revision read the revision's canonical document, so the fan is armed
  // only for rows that have nothing else to read.
  const openDrafts = items.map((_pipeline, index) => {
    if ((definitions[index]?.data?.revisions ?? []).length > 0) return null;
    const drafts = draftsList[index]?.data?.drafts ?? [];
    return (
      [...drafts]
        .filter((draft) => draft.status !== "published")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null
    );
  });
  const draftFan = useQueries({
    queries: openDrafts.map((draft) => ({
      queryKey: queryKeys.draft(draft?.id ?? ""),
      queryFn: () => apiFetch<Draft>(`/api/v1/drafts/${draft?.id ?? ""}`),
      enabled: draft !== null,
    })),
  });

  const rows = items.map((pipeline, index) => {
    const definition = definitions[index]?.data;
    const ready = definition !== undefined && !definitions[index]?.isError;
    const revision = revisionFan[index]?.data;
    const document =
      revision && isDefinitionDocument(revision.canonical_document)
        ? revision.canonical_document
        : null;
    return {
      pipeline,
      ready,
      revisions: definition?.revisions ?? [],
      document,
      // `Export YAML` downloads the latest revision's regenerated YAML text;
      // the wire's draft list carries no document text, so no revision → null.
      exportDocument: revision?.document_text ?? null,
      drafts: draftsList[index]?.data?.drafts ?? [],
      openDraftDocument: draftFan[index]?.data?.document_yaml ?? null,
      facts: workflowRowFacts(
        projectItems,
        assignmentsFan.map((entry) => entry?.data),
        schedulesFan.map((entry) => entry?.data),
        pipeline.id,
      ),
    };
  });

  const query = search.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (
      query &&
      !row.pipeline.slug.toLowerCase().includes(query) &&
      !row.pipeline.display_name.toLowerCase().includes(query)
    ) {
      return false;
    }
    // A `?folder=` value the list no longer carries (its last row moved away)
    // filters nothing: the chip clears itself rather than hiding rows behind
    // a stale param.
    if (effectiveFolderFilter) {
      if (folderLabel(row.pipeline.folder) !== effectiveFolderFilter) return false;
    }
    if (filter === "has-draft" && !row.drafts.some((draft) => draft.status !== "published")) {
      return false;
    }
    if (usedInProject && !row.facts.assigned.some((entry) => entry.project.id === usedInProject)) {
      return false;
    }
    return true;
  });

  // Is anything narrowing the list right now? The no-match line offers to undo
  // exactly that, so the offer appears only where it would do something.
  const filtersActive =
    search !== "" || filter !== "all" || usedInProject !== "" || effectiveFolderFilter !== null;
  function clearFilters() {
    setSearch("");
    setFilter("all");
    setUsedInProject("");
    if (searchParams.has("folder")) {
      const next = new URLSearchParams(searchParams);
      next.delete("folder");
      setSearchParams(next, { replace: true });
    }
  }

  // Finding 10: no grouped view any more — the folders are the toolbar's filter
  // above, and `visible` is one flat list of rows.

  const rowNode = (row: (typeof rows)[number]) => (
    <WorkflowRow
      key={row.pipeline.id}
      pipeline={row.pipeline}
      definitionReady={row.ready}
      revisions={row.revisions}
      document={row.document}
      openDraftDocument={row.openDraftDocument}
      assigned={row.facts.assigned}
      assignmentsResolved={row.facts.resolved}
      canAuthor={canAuthor}
      duplicating={duplicate.isPending && duplicate.variables === row.pipeline.id}
      onDuplicate={() =>
        duplicate.mutate(row.pipeline.id, {
          onSuccess: ({ pipeline, draft }) => navigate(routes.draft(pipeline.id, draft.id)),
        })
      }
      onOpen={() => navigate(routes.workflow(row.pipeline.id))}
      // No use-in-a-repo dialog exists on the index yet, so that item is not
      // offered; Export YAML is only offered when the row has a document.
      exportDocument={row.exportDocument}
      onMoveToFolder={canAuthor ? () => setMoveTarget(row.pipeline) : undefined}
    />
  );

  const fanBroke =
    definitions.some((entry) => entry.isError) || assignmentsFan.some((entry) => entry.isError);

  return (
    <Page
      layout="wide"
      testid="library-page"
      title={<span id="library-heading">Workflows</span>}
      subtitle={
        <span className="font-sans text-[13px]" data-testid="workflows-subtitle">
          Reusable pipelines. Projects assign them; every run pins a revision.
        </span>
      }
      band={<WorkflowsTabs active="workflows" />}
      actions={
        <div className="flex flex-wrap items-center gap-[8px]">
          {canAuthor ? (
            <Button
              variant="secondary"
              onClick={() => setImportOpen(true)}
              data-testid="workflows-import-yaml"
            >
              Import YAML
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!canAuthor}
            onClick={() => setNewWorkflow({ open: true, preset: null })}
            data-testid="workflows-new-workflow"
          >
            New workflow
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {me.isError ? (
          <ProblemBanner error={me.error} fallback="Your identity could not be read." />
        ) : null}
        {/* The START FROM gallery: every vetted starting point the dialog offers,
          one card each, in the grid the design names — three across on a desk
          (≥1100px), two from a small laptop (≥640px), one on a phone. Blank leads,
          because it is the absence of a template, not another one. */}
        <section aria-labelledby="workflows-start-from-label">
          <SectionLabel testid="workflows-start-from-label">Start from</SectionLabel>
          <div
            className="grid grid-cols-1 gap-[10px] min-[640px]:grid-cols-2 min-[1100px]:grid-cols-3"
            data-testid="workflow-starters"
          >
            {PIPELINE_TEMPLATES.filter((template) => template.id === "blank").map((template) => (
              // The blank card leads, and its id is written out: the vitest and
              // e2e suites both address that one starter by name, and
              // `scripts/check-testids.mjs` only sees an id written as a literal.
              <StarterCard
                key={template.id}
                template={template}
                testid="workflow-starter-blank"
                canAuthor={canAuthor}
                onPick={() => setNewWorkflow({ open: true, preset: template.id })}
              />
            ))}
            {PIPELINE_TEMPLATES.filter((template) => template.id !== "blank").map((template) => (
              <StarterCard
                key={template.id}
                template={template}
                testid={`workflow-starter-${template.id}`}
                canAuthor={canAuthor}
                onPick={() => setNewWorkflow({ open: true, preset: template.id })}
              />
            ))}
          </div>
          {/* The reason the cards are inert — only once `me` has been read:
            loading is not authoring, and an admin is never flashed the refusal. */}
          {me.isSuccess && !canAuthor ? (
            <p
              className="mt-[6px] font-mono text-[10px] text-faint"
              data-testid="workflow-starters-need-role"
            >
              {`needs ${LIBRARY_ROLE_LABEL} to create`}
            </p>
          ) : null}
        </section>
        {pipelines.isPending ? <Spinner label="Loading the workflow library" /> : null}
        {pipelines.isError && !newWorkflow.open ? (
          <ProblemBanner
            error={pipelines.error}
            fallback="The workflow library could not be read."
            subject="the workflow library"
            hint="Nothing is listed, because the list could not be read."
            retry={{
              onClick: () => void pipelines.refetch(),
              pending: pipelines.isFetching,
              testid: "workflows-load-retry",
            }}
            testid="workflows-load-error"
          />
        ) : null}
        {projects.isError ? (
          <ProblemBanner
            error={projects.error}
            fallback="Your projects could not be read, so a workflow's 'used in' line may be missing a repo."
            subject="your projects"
            retry={{
              onClick: () => void projects.refetch(),
              pending: projects.isFetching,
              testid: "workflows-projects-retry",
            }}
          />
        ) : null}
        {fanBroke ? (
          <ProblemBanner
            error={undefined}
            fallback="Some rows could not be read in full, so parts of those rows are missing."
          />
        ) : null}
        {/* The org's own workflows. The count is the list read's own rows (the
          header no longer prints a lone number), and with nothing to narrow the
          toolbar is not shown at all — the empty panel below is the page's answer
          to an org that has not made one yet. */}
        <section aria-labelledby="workflows-mine-label">
          <p
            className="mb-[8px] font-mono text-[10.5px] uppercase tracking-[.06em] text-faint"
            data-testid="workflows-mine-label"
          >
            {pipelines.data ? (
              <>
                {`Your workflows · `}
                <span data-testid="workflows-count">{items.length}</span>
              </>
            ) : (
              "Your workflows"
            )}
          </p>
          {pipelines.data && items.length > 0 ? (
            <div className="flex flex-wrap items-center gap-[6px]" data-testid="workflows-filters">
              <Input
                id="workflows-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search workflows"
                aria-label="Search workflows"
                /* The design's search field shares the toolbar's row with the chips
               and stops at 360px: a search box across the whole page read as a
               heading-level control and buried the filters beside it. */
                className="min-[600px]:w-auto min-[600px]:min-w-[240px] min-[600px]:flex-1 max-w-[360px]"
                data-testid="workflows-search"
              />
              {/* Finding 10: folders are a filter on this page, not a sidebar
              layout. Default `All folders`; the pick writes the same `?folder=`
              param the page already reads, so a filtered list is a shareable
              address. It only appears when the list actually carries folders —
              an all-unfiled library has nothing to filter by. */}
              {realFolderNames.length > 0 ? (
                <label className="flex items-center gap-[6px]">
                  <span className="sr-only">Filter by folder</span>
                  <Select
                    aria-label="Filter by folder"
                    value={effectiveFolderFilter}
                    onChange={(event) => {
                      const next = new URLSearchParams(searchParams);
                      if (event.target.value) next.set("folder", event.target.value);
                      else next.delete("folder");
                      setSearchParams(next, { replace: true });
                    }}
                    className="h-[30px] w-auto font-mono text-[11px]"
                    data-testid="workflows-folder-filter"
                  >
                    <option value="">All folders</option>
                    {folderNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <FilterChip
                active={filter === "all" && usedInProject === "" && search === ""}
                onClick={() => {
                  setFilter("all");
                  setUsedInProject("");
                  setSearch("");
                }}
                testid="workflows-filter-all"
              >
                all
              </FilterChip>
              <FilterChip
                active={filter === "has-draft"}
                onClick={() =>
                  setFilter((current) => (current === "has-draft" ? "all" : "has-draft"))
                }
                testid="workflows-filter-draft"
              >
                has open draft
              </FilterChip>
              {assignmentsSettled
                ? usedByProjects.map((project) => (
                    <FilterChip
                      key={project.id}
                      active={usedInProject === project.id}
                      onClick={() =>
                        setUsedInProject((current) => (current === project.id ? "" : project.id))
                      }
                      testid={`workflows-used-in-${project.id}`}
                    >
                      {`used in ${project.name}`}
                    </FilterChip>
                  ))
                : null}
              {effectiveFolderFilter ? (
                <FilterChip
                  active
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete("folder");
                    setSearchParams(next, { replace: true });
                  }}
                  testid="workflows-filter-folder"
                >
                  {`in ${folderLabel(effectiveFolderFilter)}`}
                </FilterChip>
              ) : null}
            </div>
          ) : null}
          {/* An org with no workflow at all gets the way in, not a sentence about
            the absence: the three real doors are a card above, `Import YAML`, and
            the assistant — so they are HERE, beside the words that name them. The
            assistant ask opens with its prefix only: a made-up goal would put
            words in the reader's mouth. */}
          {pipelines.data && rows.length === 0 ? (
            <div
              className="rounded-[4px] border border-dashed border-line-strong p-[24px] text-center"
              data-testid="workflows-empty-panel"
            >
              <p className="text-[14px] font-semibold text-ink" data-testid="workflows-empty">
                No workflows yet
              </p>
              <p className="mt-[2px] text-[13px] text-muted">
                Start from a template above, import YAML, or describe one to the assistant.
              </p>
              <div className="mt-[12px] flex flex-wrap items-center justify-center gap-[8px]">
                <Button
                  variant="primary"
                  disabled={!canAuthor}
                  onClick={() => setNewWorkflow({ open: true, preset: null })}
                  data-testid="workflows-empty-new"
                >
                  New workflow
                </Button>
                {canAuthor ? (
                  <Button
                    variant="secondary"
                    onClick={() => setImportOpen(true)}
                    data-testid="workflows-empty-import"
                  >
                    Import YAML
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => openAssistantPopover("Help me design a workflow for ")}
                  data-testid="workflows-empty-ask"
                >
                  Ask the assistant
                </Button>
              </div>
            </div>
          ) : null}
          {/* The list is not empty, the FILTER is: the sentence names that, and the
            way out of it is the action beside it (review3 item: “Clear search”). It
            clears every filter the row holds — the search box, the chips and the
            folder alike — because the reader who landed here wants the list back,
            not one control at a time. */}
          {pipelines.data && rows.length > 0 && visible.length === 0 ? (
            <div className="flex flex-wrap items-center gap-[8px]">
              {/* One `workflows-empty` handle for both empty answers — the panel and
                this line are mutually exclusive branches of the same read, and the
                e2e pass looks up the no-match case by that id. */}
              <p className="text-[12.5px] text-muted" data-testid="workflows-empty">
                No workflow matches the current filter.
              </p>
              {filtersActive ? (
                <Button
                  variant="secondary"
                  compact
                  onClick={clearFilters}
                  data-testid="workflows-clear-search"
                >
                  Clear search
                </Button>
              ) : null}
            </div>
          ) : null}
          {pipelines.data && visible.length > 0 ? (
            <ul
              className="rounded-[3px] border border-line-strong bg-surface px-3"
              data-testid="workflows-list"
            >
              {visible.map(rowNode)}
            </ul>
          ) : null}
        </section>
        <ImportYamlDialog open={importOpen} onClose={() => setImportOpen(false)} />
        <NewWorkflowDialog
          open={newWorkflow.open}
          onClose={() => setNewWorkflow((current) => ({ ...current, open: false }))}
          canCreate={canAuthor}
          presetTemplateId={newWorkflow.preset}
          folders={realFolderNames}
          /* The dialog is the one thing on screen when it is open, so the list
           read's failure belongs inside it — a banner behind the overlay is a
           failure the author cannot read. */
          listError={pipelines.isError ? pipelines.error : undefined}
        />
        {moveTarget ? (
          <MoveToFolderDialog
            pipeline={moveTarget}
            folders={realFolderNames}
            onClose={() => setMoveTarget(null)}
          />
        ) : null}
      </div>
    </Page>
  );
}

export default LibraryPage;
