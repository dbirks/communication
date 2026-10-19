/**
 * The canonical v1alpha1 authoring schema, shared with the Go compiler.
 *
 * The UI does not carry a private copy: this module imports the very JSON the
 * schema package ships at `internal/pipelines/schema/assets/`, so a field the
 * compiler knows about can never silently disappear from the Studio inspector
 * (ADR-0042 § 3.3: the inspector is JSON-Schema-driven and unknown shapes fall
 * back to a JSON editor rather than being hidden).
 */
import raw from "../../../../internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json";

/** A deliberately loose structural view of one JSON-Schema sub-scheme. Only the
 * keywords the generator reads are named; anything else is opaque. */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  enum?: ReadonlyArray<unknown>;
  const?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
  required?: string[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  [keyword: string]: unknown;
}

const doc = raw as unknown as { $defs: Record<string, JsonSchema> };

/** The `$defs` table of the canonical schema (node, commonNodeFields,
 * retryPolicy, configAgentAcp, …). */
export const PIPELINE_SCHEMA_DEFS: Record<string, JsonSchema> = doc.$defs;
