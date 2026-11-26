# ADR-0086: A project's default agent profile

Status: Accepted (2026-11-26)

## Context

The redesign (docs/design/redesign/CONTRACT.md, "Agents & models") makes the agent chip a profile picker on Home,
Chats and the canvas. A person starting a chat in a project has to pick a profile every time, and each browser
remembers its own last choice in localStorage. David approved one line on the project home: "Default agent
**<profile>** · change". A project has had exactly one mutable setting so far (`agent_mail_enabled`, ADR-0072),
changed through `PATCH /api/v1/projects/{projectId}` with an optimistic `version`.

## Decision

1. `projects.default_agent_profile_id` (uuid, NULL, `REFERENCES agent_profiles(id) ON DELETE SET NULL`), added by
   migration 00036. NULL means "no default": the UI falls back to the person's last choice, then the first
   profile.
2. The `Project` resource gains `default_agent_profile_id` (string or null) and the read-only
   `default_agent_profile_name` (string or null), joined at read time.
3. `PATCH /api/v1/projects/{projectId}` accepts `default_agent_profile_id` (a profile id of the same
   organization, or null to clear) beside `agent_mail_enabled`. Each field is optional; a body must carry at
   least one of them and still carries `version`. The same role that may change `agent_mail_enabled` may change
   it (project maintainer or organization admin). An id that is not a profile of the project's organization
   answers `400 invalid_agent_profile`. The existing `409` on a stale `version` is unchanged.
4. The change is journaled as `project.default_agent.changed` (payload: project id, old and new profile id,
   actor), like the mail setting's event.
5. Nothing server-side reads the default yet: creating a conversation or a run still names its profile
   explicitly. The UI uses it to preselect the agent chip (Home prompt, New chat, the agent step card's initial
   value for a new agent step). Making the server apply it when a request omits the profile is a later change.

## Consequences

- Deleting a profile clears the default on every project that named it (ON DELETE SET NULL); the UI then shows
  "no default".
- Old clients that PATCH only `agent_mail_enabled` keep working: the new field is optional.
- No effect on runs, pipelines or recovery semantics.
