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
export type AgentProfileVersion = components["schemas"]["AgentProfileVersion"];
export type AgentProfileVersionList = components["schemas"]["AgentProfileVersionList"];
export type APMLockRequest = components["schemas"]["APMLockRequest"];
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

/* --------------------------------------------------------------- M4 */

/**
 * The M4 wire (OpenAPI 0.4.0-m4). Every type is a rename of a generated
 * `components["schemas"][...]` member — nothing here restates a shape, and the
 * components' view models live in `lib/pipeline/contract.ts`, fed through
 * `api/m4view.ts`.
 */
export type Pipeline = components["schemas"]["Pipeline"];
export type PipelineSummary = components["schemas"]["PipelineSummary"];
export type PipelineList = components["schemas"]["PipelineList"];
export type PipelineCreate = components["schemas"]["PipelineCreate"];
export type PipelineUpdate = components["schemas"]["PipelineUpdate"];
export type PipelineRevisionSummary = components["schemas"]["PipelineRevisionSummary"];
export type PipelineRevisionSummaryList = components["schemas"]["PipelineRevisionSummaryList"];
export type PipelineRevision = components["schemas"]["PipelineRevision"];
export type DraftSummary = components["schemas"]["DraftSummary"];
export type DraftSummaryList = components["schemas"]["DraftSummaryList"];
export type Draft = components["schemas"]["Draft"];
export type DraftCreate = components["schemas"]["DraftCreate"];
export type DraftPut = components["schemas"]["DraftPut"];
export type DraftPublish = components["schemas"]["DraftPublish"];
export type DraftConflictProblem = components["schemas"]["DraftConflictProblem"];
export type ValidateError = components["schemas"]["ValidateError"];
export type ValidateResponse = components["schemas"]["ValidateResponse"];
export type ValidateProblem = components["schemas"]["ValidateProblem"];
export type Assignment = components["schemas"]["Assignment"];
export type AssignmentList = components["schemas"]["AssignmentList"];
export type AssignmentCreate = components["schemas"]["AssignmentCreate"];
export type AssignmentPatch = components["schemas"]["AssignmentPatch"];
export type Run = components["schemas"]["Run"];
export type RunSummary = components["schemas"]["RunSummary"];
export type RunSummaryList = components["schemas"]["RunSummaryList"];
export type RunCreate = components["schemas"]["RunCreate"];
export type RunCreateResponse = components["schemas"]["RunCreateResponse"];
export type RunRetryRequest = components["schemas"]["RunRetryRequest"];
export type RunConflictProblem = components["schemas"]["RunConflictProblem"];
export type NodeExecution = components["schemas"]["NodeExecution"];
export type NodeExecutionList = components["schemas"]["NodeExecutionList"];
export type NodeExecutionDetail = components["schemas"]["NodeExecutionDetail"];
export type CelEnvelope = components["schemas"]["CelEnvelope"];
export type Attempt = components["schemas"]["Attempt"];
export type RunCheckpoint = components["schemas"]["RunCheckpoint"];
export type RunCheckpointList = components["schemas"]["RunCheckpointList"];
export type RunTree = components["schemas"]["RunTree"];
export type Approval = components["schemas"]["Approval"];
export type ApprovalList = components["schemas"]["ApprovalList"];
export type ApprovalDecide = components["schemas"]["ApprovalDecide"];
export type ApprovalConflictProblem = components["schemas"]["ApprovalConflictProblem"];
export type SchedulerStatus = components["schemas"]["SchedulerStatus"];
