/**
 * Library fixtures shaped like the § 2 definition routes. Values are the
 * § 9.3 sample pipeline plus the `docs/m4-contract.md` § 7.2 W8 validation
 * case; digests are fixture-shaped hex, not digests of these documents.
 */
import type {
  AssignmentSummary,
  PipelineDraftSummary,
  PipelineRevisionSummary,
  PipelineSummary,
} from "../../../lib/pipeline/contract";

export const libraryPipelines: PipelineSummary[] = [
  {
    id: "pl_01J8FEATUREDEV",
    slug: "feature-development",
    display_name: "Feature development",
    description: "Plan, approve, implement, test, review, loop until verified, publish evidence.",
    latest_revision_number: 7,
    revision_count: 7,
    archived: false,
  },
  {
    id: "pl_01J8MODULECHECK",
    slug: "module-verification",
    display_name: "Module verification",
    description: "Fan out one child run per module and publish the aggregate.",
    latest_revision_number: 2,
    revision_count: 2,
    archived: false,
  },
  {
    id: "pl_01J8DRAFTONLY",
    slug: "release-promotion",
    display_name: "Release promotion",
    description: "Never published — a draft with findings is the only thing it has.",
    latest_revision_number: null,
    revision_count: 0,
    archived: false,
  },
  {
    id: "pl_01J8ARCHIVED",
    slug: "legacy-import",
    display_name: "Legacy import",
    latest_revision_number: 1,
    revision_count: 1,
    archived: true,
  },
];

export const featureDevelopmentRevisions: PipelineRevisionSummary[] = [
  {
    id: "rev_01J8A",
    revision_number: 7,
    version_label: "7.0.0",
    revision_digest: "sha256:3f2f6e6a7ad1b1d8f4f3f4e4f9dfaf2b6bb2f43f4e4b41d8e4f4d2f4f4d4f4ab",
    plan_digest: "sha256:0d0c7b3a6a5b4f2e1d0c9b8a7f6e5d4c3b2a190817161514131211100f0e0d0c",
    digest_scope: "v1alpha1-canonical-1",
    published_at: "2026-07-29T18:40:00Z",
    published_by: "usr_david",
    status: "published",
  },
  {
    id: "rev_01J8B",
    revision_number: 6,
    version_label: "6.2.0",
    revision_digest: "sha256:aaaa1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
    plan_digest: "sha256:bbbb1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
    digest_scope: "v1alpha1-canonical-1",
    published_at: "2026-07-22T11:02:00Z",
    published_by: "usr_david",
    status: "published",
  },
  {
    id: "rev_01J8C",
    revision_number: 5,
    version_label: "5.4.1",
    revision_digest: "sha256:cccc1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
    plan_digest: "sha256:dddd1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
    digest_scope: "v1alpha1-canonical-1",
    published_at: "2026-07-15T09:14:00Z",
    published_by: "usr_amy",
    status: "deprecated",
  },
];

export const featureDevelopmentDrafts: PipelineDraftSummary[] = [
  {
    id: "dr_01J8DRAFT1",
    status: "invalid",
    version: 12,
    updated_at: "2026-07-31T08:12:00Z",
    edited_by: "usr_david",
  },
];

export const releasePromotionDrafts: PipelineDraftSummary[] = [
  {
    id: "dr_01J8DRAFT2",
    status: "validating",
    version: 2,
    updated_at: "2026-07-31T09:40:00Z",
    edited_by: "usr_amy",
  },
];

/** Route 17, with M6's channel labels resolved to their pinned digests. */
export const projectAssignments: AssignmentSummary[] = [
  {
    id: "as_01J8A",
    project_id: "prj_01J8ACME",
    pipeline_id: "pl_01J8FEATUREDEV",
    pinned_revision_id: "rev_01J8A",
    revision_digest: "sha256:3f2f6e6a7ad1b1d8f4f3f4e4f9dfaf2b6bb2f43f4e4b41d8e4f4d2f4f4d4f4ab",
    version_label: "7.0.0",
    max_concurrent_runs: 1,
    budget_overrides: {},
    enabled: true,
    channels: [
      {
        channel: "stable",
        revision_digest: "sha256:3f2f6e6a7ad1b1d8f4f3f4e4f9dfaf2b6bb2f43f4e4b41d8e4f4d2f4f4d4f4ab",
        version_label: "7.0.0",
      },
      {
        channel: "beta",
        revision_digest: "sha256:aaaa1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
        version_label: "6.2.0",
      },
    ],
  },
  {
    id: "as_01J8B",
    project_id: "prj_01J8ACME",
    pipeline_id: "pl_01J8MODULECHECK",
    pinned_revision_id: "rev_01J8D",
    revision_digest: "sha256:ee001f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
    version_label: "2.0.0",
    max_concurrent_runs: 3,
    budget_overrides: {},
    enabled: true,
    channels: [
      {
        channel: "stable",
        revision_digest: "sha256:ee001f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
        version_label: "2.0.0",
      },
    ],
  },
];
