/**
 * One shared "New conversation" dialog. The project Conversations page and
 * the project header both open it (the page preselects its project); the
 * shell's New menu opens it with a project picker, so a one-off ACP
 * conversation is reachable from everywhere instead of living inside one
 * section's inline form.
 *
 * Accessible-modal contract: `role="dialog"` + `aria-modal`, labelled by its
 * own title, focus trapped on the first field while open, Escape closes, and
 * focus returns to the opener when it closes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAgentProfiles, useCreateConversation, useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { FormError, ProblemBanner, Spinner } from "./Feedback";
import { Button } from "./ds/Button";
import { Field, Input, Select, Textarea } from "./ds/Field";
import { routes } from "../lib/routes";

export interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
  /** When given, the project field is fixed to this project (no picker). */
  projectId?: string;
  /**
   * The fixed project, from the caller's own query. Openers already hold it
   * (the Conversations section and the project page read `useProject`, not the
   * list), so passing it lets the dialog display and start immediately instead
   * of waiting for the list fetch to resolve.
   */
  project?: Project;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog body. Rendered only while `open`, so its mount is the moment
 * the opener held focus: the layout effect captures the opener before it
 * moves focus to the first field, and the same effect's cleanup restores it.
 */
function DialogBody({
  onClose,
  projectId,
  project,
  projects,
  projectsPending,
  projectsError,
}: {
  onClose: () => void;
  projectId?: string;
  project?: Project;
  projects: Project[];
  projectsPending: boolean;
  projectsError: unknown;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(
    projectId ?? (projects.length === 1 ? projects[0].id : ""),
  );
  const activeProjectId = projectId ?? selectedProjectId;
  const activeProject = useMemo(
    () =>
      projectId
        ? (project ?? projects.find((p) => p.id === projectId) ?? null)
        : (projects.find((p) => p.id === activeProjectId) ?? null),
    [projectId, project, projects, activeProjectId],
  );

  // The project picker only lists projects the caller can write to; viewers
  // are excluded so the form never dead-ends on a 403 at submit.
  const writable = useMemo(() => projects.filter((p) => p.my_role !== "viewer"), [projects]);
  const hiddenViewerCount = projects.length - writable.length;

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conversation-dialog-title"
        data-testid="new-conversation-dialog"
        className="w-full max-w-[440px] rounded-[3px] border border-line-strong bg-surface p-4 shadow-[0_8px_24px_rgba(30,29,26,0.18)]"
      >
        <h2 id="new-conversation-dialog-title" className="text-[15px] font-bold">
          New thread
        </h2>
        <p className="mt-1 text-[12.5px] text-muted">
          A one-off thread with an agent in a project workspace — no workflow needed.
        </p>

        <div className="mt-3 space-y-3">
          {projectId ? (
            <div className="space-y-1">
              <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                Project
              </span>
              <p
                data-testid="new-conversation-dialog-project"
                className="rounded-[3px] border border-line bg-fill px-[10px] py-1 font-mono text-[12.5px] text-ink"
              >
                {activeProject?.name ?? projectId}
              </p>
            </div>
          ) : (
            <Field
              id="new-conversation-project"
              label="Project"
              hint={
                <>
                  {projectsPending ? <Spinner label="Loading projects" /> : null}
                  {projectsError ? (
                    <ProblemBanner
                      error={projectsError as Error}
                      fallback="Projects could not be loaded."
                    />
                  ) : null}
                  {hiddenViewerCount > 0 ? (
                    <span className="font-mono text-[10.5px] text-faint">
                      {hiddenViewerCount} project{hiddenViewerCount === 1 ? "" : "s"} hidden (viewer
                      role only).
                    </span>
                  ) : null}
                </>
              }
            >
              <Select
                id="new-conversation-project"
                data-testid="new-conversation-dialog-project"
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                required
                disabled={projectsPending}
              >
                <option value="">Select a project…</option>
                {writable.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ({project.my_role})
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {activeProject ? (
            <ConversationForm key={activeProject.id} project={activeProject} onCreated={onClose} />
          ) : !projectId ? (
            <p
              className="text-[12.5px] text-muted"
              data-testid="new-conversation-dialog-need-project"
            >
              {writable.length === 0 && !projectsPending
                ? "No projects where you can start a thread."
                : "Choose a project to start the thread."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The per-project form, keyed by the chosen project so the per-project
 * `useCreateConversation` mutation and the field state reset when the
 * picker changes.
 */
function ConversationForm({ project, onCreated }: { project: Project; onCreated: () => void }) {
  const profiles = useAgentProfiles();
  const create = useCreateConversation(project.id);
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !profileId) return;
    create.mutate(
      {
        agent_profile_id: profileId,
        title: trimmedTitle,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      },
      {
        onSuccess: (conversation) => {
          navigate(routes.thread(conversation.id));
          onCreated();
        },
      },
    );
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-label="New thread fields"
      className="space-y-3 border-t border-line pt-3"
    >
      <Field id="conversation-title" label="Title">
        <Input
          id="conversation-title"
          data-testid="conversation-new-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </Field>
      <Field
        id="conversation-profile"
        label="Agent profile"
        hint={
          <>
            {profiles.isPending ? <Spinner label="Loading agent profiles" /> : null}
            {profiles.error ? (
              <ProblemBanner
                error={profiles.error}
                fallback="Agent profiles could not be loaded."
              />
            ) : null}
          </>
        }
      >
        <Select
          id="conversation-profile"
          data-testid="conversation-new-profile"
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          required
        >
          <option value="">Select a profile…</option>
          {profiles.data
            ? profiles.data.items.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} ({profile.launcher_id}, {profile.permission_mode})
                </option>
              ))
            : null}
        </Select>
      </Field>
      <Field id="conversation-prompt" label="First prompt (optional)">
        <Textarea
          id="conversation-prompt"
          data-testid="conversation-new-prompt"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Read the repo and propose a plan."
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        data-testid="conversation-new-submit"
        disabled={create.isPending || !title.trim() || !profileId}
      >
        {create.isPending ? "Starting…" : "Start thread"}
      </Button>
      <FormError error={create.error} />
    </form>
  );
}

export default function NewConversationDialog({
  open,
  onClose,
  projectId,
  project,
}: NewConversationDialogProps) {
  // Mounted only while open: the shell's New menu mounts this on every page,
  // and the closed dialog must not fire a projects query (or render a node
  // the a11y tree can still see behind the app).
  if (!open) return null;
  return <DialogRoot onClose={onClose} projectId={projectId} project={project} />;
}

/** Fetches the project list for the picker; unmounted the moment the dialog closes. */
function DialogRoot({
  onClose,
  projectId,
  project,
}: {
  onClose: () => void;
  projectId?: string;
  project?: Project;
}) {
  const projectsQuery = useProjects();
  return (
    <DialogBody
      onClose={onClose}
      projectId={projectId}
      project={project}
      projects={projectsQuery.data?.items ?? []}
      projectsPending={projectsQuery.isPending}
      projectsError={projectsQuery.error}
    />
  );
}
