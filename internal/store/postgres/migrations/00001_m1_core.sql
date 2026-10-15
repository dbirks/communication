-- M1 core schema (communication-spec/09-api-events-data.md "Database table
-- families"). Production migrations are FORWARD-ONLY per ADR-0013: the Down
-- section below exists solely so tests can reset a scratch database and must
-- never be run against production data.

-- +goose Up

CREATE TABLE organizations (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    slug       text        NOT NULL UNIQUE,
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (slug, name)
VALUES ('default', 'Default organization');

CREATE TABLE users (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    display_name    text        NOT NULL,
    email           text,
    is_org_admin    boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_login_at   timestamptz
);

CREATE TABLE oidc_identities (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid        NOT NULL REFERENCES users (id),
    issuer     text        NOT NULL,
    subject    text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);

-- Session cookie tokens are never stored; token_hash is sha256 of the token.
CREATE TABLE sessions (
    token_hash   bytea       PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users (id),
    csrf_token   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Stored in the DB so a login started on one replica can complete on another.
CREATE TABLE oidc_login_states (
    state         text        PRIMARY KEY,
    code_verifier text        NOT NULL,
    nonce         text        NOT NULL,
    return_to     text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);

CREATE INDEX oidc_login_states_expires_at_idx ON oidc_login_states (expires_at);

CREATE TABLE projects (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    slug            text        NOT NULL,
    name            text        NOT NULL,
    description     text        NOT NULL DEFAULT '',
    created_by      uuid        NOT NULL REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    version         integer     NOT NULL DEFAULT 1,
    UNIQUE (organization_id, slug)
);

CREATE TABLE memberships (
    project_id uuid        NOT NULL REFERENCES projects (id),
    user_id    uuid        NOT NULL REFERENCES users (id),
    role       text        NOT NULL CHECK (role IN ('maintainer', 'contributor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX memberships_user_id_idx ON memberships (user_id);

CREATE TABLE repositories (
    id             uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id     uuid        NOT NULL REFERENCES projects (id),
    name           text        NOT NULL,
    git_url        text        NOT NULL,
    default_branch text        NOT NULL DEFAULT 'main',
    created_by     uuid        NOT NULL REFERENCES users (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE INDEX repositories_project_id_idx ON repositories (project_id);

CREATE TABLE domain_events (
    global_seq      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        uuid        NOT NULL UNIQUE DEFAULT uuidv7(),
    type            text        NOT NULL,
    schema_version  integer     NOT NULL DEFAULT 1,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    organization_id uuid        NOT NULL,
    project_id      uuid,
    conversation_id uuid,
    actor_kind      text        NOT NULL CHECK (actor_kind IN ('human', 'system', 'agent', 'integration', 'worker')),
    actor_id        text        NOT NULL,
    trace_id        text,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX domain_events_project_seq_idx ON domain_events (project_id, global_seq);

-- +goose StatementBegin
CREATE FUNCTION notify_domain_events() RETURNS trigger
AS $$
BEGIN
    PERFORM pg_notify('communication_events', NEW.global_seq::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER domain_events_notify
    AFTER INSERT ON domain_events
    FOR EACH ROW
    EXECUTE FUNCTION notify_domain_events();

CREATE TABLE outbox (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    global_seq   bigint      NOT NULL REFERENCES domain_events (global_seq),
    created_at   timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);

CREATE TABLE audit_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    organization_id uuid        NOT NULL,
    project_id      uuid,
    actor_kind      text        NOT NULL CHECK (actor_kind IN ('human', 'system', 'agent', 'integration', 'worker')),
    actor_id        text        NOT NULL,
    action          text        NOT NULL,
    outcome         text        NOT NULL CHECK (outcome IN ('allowed', 'denied')),
    detail          jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE workers (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    name              text        NOT NULL UNIQUE,
    hostname          text        NOT NULL,
    version           text        NOT NULL,
    started_at        timestamptz NOT NULL DEFAULT now(),
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    status            text        NOT NULL CHECK (status IN ('online', 'draining', 'offline'))
);

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013).
DROP TABLE IF EXISTS workers;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS outbox;
DROP TRIGGER IF EXISTS domain_events_notify ON domain_events;
DROP TABLE IF EXISTS domain_events;
DROP FUNCTION IF EXISTS notify_domain_events();
DROP TABLE IF EXISTS repositories;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS oidc_login_states;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS oidc_identities;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;
