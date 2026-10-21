/**
 * `Import YAML` on the Workflows index (design 3a): paste a pipeline
 * document, give it a slug (and a display name), and it lands as a fresh
 * logical pipeline with exactly one draft holding that document — nothing
 * is published, mirroring the template path's two writes (pipeline first,
 * draft second; ADR-0002). Landing is the new draft's Studio route.
 *
 * Accessible-modal contract (the NewConversationDialog pattern): `role="dialog"`
 * + `aria-modal`, labelled by its own title, focus trapped on the slug field
 * while open, Escape closes, focus returns to the opener when it closes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FormError } from "../Feedback";
import { Button } from "../ds/Button";
import { Field, Input, Textarea } from "../ds/Field";
import { apiFetch } from "../../api/client";
import { queryKeys } from "../../api/queries";
import type { Draft, Pipeline } from "../../api/types";
import { routes } from "../../lib/routes";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ImportYamlDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ImportYamlDialog({ open, onClose }: ImportYamlDialogProps) {
  if (!open) return null;
  return <DialogBody onClose={onClose} />;
}

function DialogBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const [yaml, setYaml] = useState("");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>("input, button, textarea");
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

  const valid = yaml.trim().length > 0 && SLUG_PATTERN.test(slug);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The two writes are sequential on purpose (ADR-0002's logical create
      // first, then the draft under the id that write returns) — a draft
      // posted to the uncreated id would be a 404 the dialog could not name.
      const pipeline = await apiFetch<Pipeline>("/api/v1/pipelines", {
        method: "POST",
        json: {
          slug,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        },
      });
      const draft = await apiFetch<Draft>(`/api/v1/pipelines/${pipeline.id}/drafts`, {
        method: "POST",
        json: { document_yaml: yaml },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
      onClose();
      navigate(routes.draft(pipeline.id, draft.id));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-yaml-title"
        className="w-[640px] max-w-full rounded-[4px] border border-line bg-surface shadow-(--shadow-raised)"
        data-testid="import-yaml-dialog"
      >
        <h2
          id="import-yaml-title"
          className="border-b border-line px-[14px] py-[10px] text-[13px] font-bold"
        >
          Import a workflow from YAML
        </h2>
        <form
          className="space-y-[10px] px-[14px] py-[12px]"
          onSubmit={submit}
          data-testid="import-yaml-form"
        >
          <Field
            id="import-yaml-doc"
            label="document (YAML)"
            hint="the pipeline document itself; it lands as a draft — nothing is published"
          >
            <Textarea
              id="import-yaml-doc"
              value={yaml}
              onChange={(event) => setYaml(event.target.value)}
              rows={10}
              spellCheck={false}
              data-testid="import-yaml-doc"
            />
          </Field>
          <div className="flex gap-[10px]">
            <Field
              id="import-yaml-slug"
              label="slug"
              hint="lowercase letters, digits and dashes"
              className="flex-1"
            >
              <Input
                id="import-yaml-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="feature-delivery"
                data-testid="import-yaml-slug"
              />
            </Field>
            <Field id="import-yaml-name" label="display name" className="flex-1">
              <Input
                id="import-yaml-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Feature delivery"
                data-testid="import-yaml-name"
              />
            </Field>
          </div>
          {error ? <FormError error={error} testid="import-yaml-error" /> : null}
          <div className="flex justify-end gap-[8px]">
            <Button
              variant="secondary"
              onClick={onClose}
              disabled={busy}
              data-testid="import-yaml-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !valid}
              data-testid="import-yaml-submit"
            >
              {busy ? "Importing…" : "Import"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
