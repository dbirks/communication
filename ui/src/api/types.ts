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
export type EventActor = EventEnvelope["actor"];
export type EventActorKind = EventEnvelope["actor"]["kind"];

/* --------------------------------------------------------------- M2 */

export type AgentProfile = components["schemas"]["AgentProfile"];
export type AgentProfileList = components["schemas"]["AgentProfileList"];
export type AgentProfilePermissionMode = AgentProfile["permission_mode"];
export type Conversation = components["schemas"]["Conversation"];
export type ConversationSummary = components["schemas"]["ConversationSummary"];
export type ConversationSummaryList = components["schemas"]["ConversationSummaryList"];
export type ConversationStatus = Conversation["status"];
export type ConversationCreate = components["schemas"]["ConversationCreate"];
export type ConversationMessageCreate = components["schemas"]["ConversationMessageCreate"];
export type ConversationControl = components["schemas"]["ConversationControl"];
export type ConversationControllerKind = ConversationControl["kind"];
export type ConversationTurn = components["schemas"]["ConversationTurn"];
export type ConversationTurnStatus = ConversationTurn["status"];
export type AgentSessionBinding = components["schemas"]["AgentSessionBinding"];
export type PermissionRequest = components["schemas"]["PermissionRequest"];
export type PermissionRequestStatus = PermissionRequest["status"];
export type PermissionOption = components["schemas"]["PermissionOption"];
export type PermissionDecision = components["schemas"]["PermissionDecision"];

/* --------------------------------------------------------------- M3 */

export type Secret = components["schemas"]["Secret"];
export type SecretList = components["schemas"]["SecretList"];
export type SecretScope = Secret["scope"];
export type SecretDeliveryMode = SecretCreate["delivery_mode"];
export type SecretCreate = components["schemas"]["SecretCreate"];
export type SecretUpdate = components["schemas"]["SecretUpdate"];
export type SecretAuditPolicy = SecretUpdate["audit_policy"];
export type SecretVersionCreate = components["schemas"]["SecretVersionCreate"];
export type SecretVersionInfo = components["schemas"]["SecretVersionInfo"];
export type SecretMaterialization = components["schemas"]["SecretMaterialization"];
export type SecretMaterializationList = components["schemas"]["SecretMaterializationList"];
export type SecretMount = components["schemas"]["SecretMount"];
export type SecretMountCreate = components["schemas"]["SecretMountCreate"];
export type SecretMountLifecycle = SecretMount["lifecycle"];
export type SecretMountList = components["schemas"]["SecretMountList"];
export type Workspace = components["schemas"]["Workspace"];
export type WorkspaceState = Workspace["state"];
export type WorkspaceList = components["schemas"]["WorkspaceList"];
export type WorkspaceRepo = components["schemas"]["WorkspaceRepo"];
export type WorkspaceRepoStatus = components["schemas"]["WorkspaceRepoStatus"];
export type SandboxGrant = components["schemas"]["SandboxGrant"];
export type TurnSandbox = components["schemas"]["TurnSandbox"];
export type SandboxEnforcement = NonNullable<TurnSandbox["enforcement"]>;
export type WorkerSandboxStatus = components["schemas"]["WorkerSandboxStatus"];
export type SystemSandbox = components["schemas"]["SystemSandbox"];
export type Artifact = components["schemas"]["Artifact"];
export type ArtifactKind = Artifact["kind"];
export type ArtifactSensitivity = Artifact["sensitivity"];
export type ArtifactList = components["schemas"]["ArtifactList"];
export type PreviewToken = components["schemas"]["PreviewToken"];
