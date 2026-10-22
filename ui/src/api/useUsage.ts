/**
 * The "used by" usage reports behind the app-shell's Used-by panels (the
 * design handoff's W5 backend unit): what workflows reference one agent
 * profile or one step template, read from the stored graph JSON (the latest
 * published revision of each pipeline plus each open draft) and answered as
 * one bounded usage report.
 *
 * The wire shapes are the generated OpenAPI types (`AgentProfileUsage`,
 * `NodeTemplateUsage`); this module adds no vocabulary of its own.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { components } from "./schema";

export type Usage = components["schemas"]["Usage"];
export type AgentProfileUsage = components["schemas"]["AgentProfileUsage"];
export type NodeTemplateUsage = components["schemas"]["NodeTemplateUsage"];

export const usageQueryKeys = {
  agentProfile: (profileId: string) => ["agent-profile-usage", profileId] as const,
  nodeTemplate: (templateId: string) => ["node-template-usage", templateId] as const,
};

/**
 * `GET /api/v1/agent-profiles/{profileId}/usage` — the workflows that
 * reference one agent profile. Any org member may ask; the answer is the
 * caller's own organization's pipelines only, and a subject the caller cannot
 * see answers 404 (the invisible-subject arm), which the caller reads as an
 * error, never as "no uses".
 */
export function useAgentProfileUsage(profileId: string | undefined) {
  return useQuery({
    queryKey: usageQueryKeys.agentProfile(profileId ?? ""),
    queryFn: () => apiFetch<AgentProfileUsage>(`/api/v1/agent-profiles/${profileId}/usage`),
    enabled: profileId != null && profileId !== "",
    retry: false,
  });
}

/**
 * `GET /api/v1/node-templates/{templateId}/usage` — the workflows that
 * reference one step template (the design's Used-by panel). Same shape, same
 * org scoping and invisible-subject 404 as the profile report.
 */
export function useNodeTemplateUsage(templateId: string | undefined) {
  return useQuery({
    queryKey: usageQueryKeys.nodeTemplate(templateId ?? ""),
    queryFn: () => apiFetch<NodeTemplateUsage>(`/api/v1/node-templates/${templateId}/usage`),
    enabled: templateId != null && templateId !== "",
    retry: false,
  });
}
