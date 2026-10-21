/**
 * The step (node-template) registry — ADR-0049 part 1 (wire contract in
 * `api/openapi.yaml`, `GET|POST /api/v1/node-templates[/{id}[...]]`).
 *
 * "Steps" is the UI word for the API's node templates (settled
 * decision, ADR-0043 vocabulary note): the wire keeps `node-templates`,
 * `template`, `revision`.
 *
 * A `404` on the LIST read means the serving image predates the endpoint —
 * the honest "not available yet" for the Steps page, not an error state
 * (same convention as `launchers.ts`). A `404` on ONE template means the
 * id is unknown to the caller's organization and stays an error (house
 * not-found sentinel: existence is not disclosed).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./client";
import type { components } from "./schema";

export type NodeTemplate = components["schemas"]["NodeTemplate"];
export type NodeTemplateList = components["schemas"]["NodeTemplateList"];
export type NodeTemplateDetail = components["schemas"]["NodeTemplateDetail"];
export type NodeTemplateRevision = components["schemas"]["NodeTemplateRevision"];
export type NodeTemplateRevisionCreate = components["schemas"]["NodeTemplateRevisionCreate"];
export type NodeTemplateRevisionCreateResponse =
  components["schemas"]["NodeTemplateRevisionCreateResponse"];
export type TemplateDuplicate = components["schemas"]["TemplateDuplicate"];
export type TemplateUsage = components["schemas"]["TemplateUsage"];

export const nodeTemplateKeys = {
  list: ["node-templates"] as const,
  detail: (id: string) => ["node-templates", id] as const,
};

/**
 * The registry (part 1: one page, `next_cursor` null). `data` is `null` —
 * not an error — when the server lacks the endpoint.
 */
export function useNodeTemplates() {
  return useQuery({
    queryKey: nodeTemplateKeys.list,
    queryFn: async (): Promise<NodeTemplateList | null> => {
      try {
        return await apiFetch<NodeTemplateList>("/api/v1/node-templates");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
}

/** One step with its full revision history (newest first) and usages. */
export function useNodeTemplate(templateId: string | undefined) {
  return useQuery({
    queryKey: nodeTemplateKeys.detail(templateId ?? ""),
    queryFn: () => apiFetch<NodeTemplateDetail>(`/api/v1/node-templates/${templateId}`),
    enabled: templateId !== undefined && templateId !== "",
    retry: false,
  });
}

/**
 * "Edit for all" — append immutable revision N+1 and (part 2) adopt the
 * referencing workflows through drafts. On success the registry and this
 * template's detail both go stale.
 */
export function useCreateNodeTemplateRevision(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NodeTemplateRevisionCreate) =>
      apiFetch<NodeTemplateRevisionCreateResponse>(
        `/api/v1/node-templates/${templateId}/revisions`,
        { method: "POST", json: body },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: nodeTemplateKeys.list });
      void queryClient.invalidateQueries({ queryKey: nodeTemplateKeys.detail(templateId) });
    },
  });
}

/** "Duplicate as a new step…" — a NEW template whose revision 1 copies the source's latest. */
export function useDuplicateNodeTemplate(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TemplateDuplicate) =>
      apiFetch<NodeTemplate>(`/api/v1/node-templates/${templateId}/duplicate`, {
        method: "POST",
        json: body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: nodeTemplateKeys.list });
    },
  });
}
