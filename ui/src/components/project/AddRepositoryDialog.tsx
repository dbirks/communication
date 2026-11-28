/**
 * The project's add-repository form, in a dialog (Projects Review design 1b:
 * `+ add` opens *the existing add form*, not a new one).
 *
 * Same three fields, same `POST /projects/{id}/repos`, same refusals kept in
 * the server's own words: `409` is the project's one-name-per-repository rule,
 * `422` is `git_url` shape. The dialog chrome is the one the rest of the app
 * uses (NewWorkflowDialog / NewConversationDialog): 520px, ink border, hard
 * offset shadow, `role="dialog"`, Escape closes, focus trapped while open and
 * returned to the opener after.
 */
import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { useAddRepository } from "../../api/queries";
import { Field, Input } from "../ds/Field";
import { Sheet } from "../ds/Sheet";
import { FormError } from "../Feedback";

export interface AddRepositoryDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

export function AddRepositoryDialog({ open, onClose, projectId }: AddRepositoryDialogProps) {
  if (!open) return null;
  return <AddRepositoryForm onClose={onClose} projectId={projectId} />;
}

function AddRepositoryForm({ onClose, projectId }: Omit<AddRepositoryDialogProps, "open">) {
  const add = useAddRepository(projectId);
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = gitUrl.trim();
    if (!trimmedName || !trimmedUrl) return;
    add.mutate(
      {
        name: trimmedName,
        git_url: trimmedUrl,
        default_branch: defaultBranch.trim() || "main",
      },
      {
        onSuccess: () => {
          setName("");
          setGitUrl("");
          setDefaultBranch("");
          onClose();
        },
      },
    );
  };

  return (
    <Sheet
      onClose={onClose}
      closeOnBackdrop={false}
      labelledBy="add-repository-title"
      testid="add-repository-dialog"
      widthClassName="w-[520px]"
      panelClassName="p-0"
    >
      <div className="flex items-center gap-2 border-b border-line px-[24px] py-[16px] max-md:px-[16px]">
        <h2 id="add-repository-title" className="text-[16px] font-bold">
          Add a repository
        </h2>
        <span aria-hidden="true" className="ml-auto font-mono text-[11px] text-faint">
          esc
        </span>
      </div>
      <form onSubmit={onSubmit} className="space-y-3 px-[24px] py-[20px] max-md:px-[16px]">
        <Field id="repo-name" label="Name">
          <Input
            id="repo-name"
            data-testid="repo-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field
          id="repo-git-url"
          label="Git URL"
          hint={
            <span className="font-mono text-[10.5px] text-faint">
              https://, ssh://, git@host:path or file://
            </span>
          }
        >
          <Input
            id="repo-git-url"
            data-testid="repo-git-url"
            value={gitUrl}
            onChange={(event) => setGitUrl(event.target.value)}
            placeholder="https://github.com/example/app.git"
            required
          />
        </Field>
        <Field id="repo-default-branch" label="Default branch">
          <Input
            id="repo-default-branch"
            data-testid="repo-default-branch"
            placeholder="main"
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
          />
        </Field>
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <button
            className="ds-btn ds-btn--primary"
            type="submit"
            data-testid="repo-submit"
            disabled={add.isPending || !name.trim() || !gitUrl.trim()}
          >
            {add.isPending ? "Adding…" : "Add repository"}
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--secondary"
            onClick={onClose}
            data-testid="repo-add-cancel"
          >
            Cancel
          </button>
        </div>
        {add.error instanceof ApiError && add.error.status === 409 ? (
          <p className="text-[12.5px] text-muted" data-testid="repo-add-conflict">
            That repository name is already used in this project.
          </p>
        ) : null}
        <FormError error={add.error} />
      </form>
    </Sheet>
  );
}
