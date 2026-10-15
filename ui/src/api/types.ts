/**
 * Short aliases for the generated OpenAPI types (`src/api/schema.d.ts`,
 * produced by `pnpm gen:api`). Nothing here restates an API shape: every type
 * is a rename of `components["schemas"][...]`.
 */
import type { components } from "./schema";

export type Me = components["schemas"]["Me"];
export type Organization = components["schemas"]["Organization"];
export type User = components["schemas"]["User"];
export type UserList = components["schemas"]["UserList"];
export type Project = components["schemas"]["Project"];
export type ProjectList = components["schemas"]["ProjectList"];
export type ProjectCreate = components["schemas"]["ProjectCreate"];
export type Repository = components["schemas"]["Repository"];
export type RepositoryList = components["schemas"]["RepositoryList"];
export type RepositoryCreate = components["schemas"]["RepositoryCreate"];
export type Member = components["schemas"]["Member"];
export type MemberList = components["schemas"]["MemberList"];
export type MemberPut = components["schemas"]["MemberPut"];
export type MemberRole = Member["role"];
export type Worker = components["schemas"]["Worker"];
export type WorkerList = components["schemas"]["WorkerList"];
export type Health = components["schemas"]["Health"];
export type Readiness = components["schemas"]["Readiness"];
export type Problem = components["schemas"]["Problem"];
export type EventEnvelope = components["schemas"]["EventEnvelope"];
export type EventActorKind = EventEnvelope["actor"]["kind"];
