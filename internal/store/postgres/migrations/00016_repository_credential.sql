-- 00016 — ADR-0061 (docs/adr/ADR-0061-repository-github-credential.md): a
-- repository's GitHub credential.
--
-- Forward-only per ADR-0013: an additive nullable column; every pre-00016 row
-- means "no credential", which is exactly today's anonymous clone/fetch/issue
-- read, so nothing here rewrites an earlier row's meaning. The Down section
-- exists for test resets only.
--
-- `credential_secret_id` references a `secret_metadata` row whose
-- delivery_mode is `integration_broker` (ADR-0018's declared mode, built here
-- for the first time). The plain FK can only say "a secret exists"; the two
-- rules that make the reference safe — the secret must be an
-- integration_broker secret, and it must belong to the repository's project
-- or to that project's organization (org-scope secrets carry no project_id,
-- per secrets_scope_pointer in 00004) — cross two tables, so no CHECK can
-- state them. ADR-0061 Decision 1 says the same-project rule is "enforced in
-- the store write, not only the API"; the trigger below is the backstop that
-- makes the store's own bug or a hand-written psql statement unable to plant
-- a cross-tenant credential reference.

-- +goose Up

ALTER TABLE repositories
    ADD COLUMN credential_secret_id uuid REFERENCES secret_metadata (id);

-- +goose StatementBegin
CREATE FUNCTION repositories_credential_secret_scope() RETURNS trigger
AS $$
DECLARE
    sec_scope     text;
    sec_project   uuid;
    sec_org       uuid;
    sec_mode      text;
    proj_org      uuid;
BEGIN
    IF NEW.credential_secret_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT sm.scope, sm.project_id, sm.organization_id, sm.delivery_mode
      INTO sec_scope, sec_project, sec_org, sec_mode
      FROM secret_metadata sm
     WHERE sm.id = NEW.credential_secret_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'repository credential % does not name a secret', NEW.credential_secret_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF sec_mode <> 'integration_broker' THEN
        RAISE EXCEPTION 'repository credential must be an integration_broker secret, not %', sec_mode
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT p.organization_id INTO proj_org FROM projects p WHERE p.id = NEW.project_id;
    IF sec_project IS NOT NULL THEN
        IF sec_scope = 'project' AND sec_project = NEW.project_id THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'repository credential belongs to another project'
            USING ERRCODE = 'check_violation';
    END IF;
    -- An org-scope secret (no project_id, per secrets_scope_pointer) may
    -- only be referenced by a repository whose project lives in the
    -- secret's organization.
    IF sec_scope = 'org' AND sec_org = proj_org THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'repository credential does not belong to this project or its organization'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER repositories_credential_secret_scope_trigger
    BEFORE INSERT OR UPDATE OF credential_secret_id ON repositories
    FOR EACH ROW
    EXECUTE FUNCTION repositories_credential_secret_scope();

-- +goose Down

DROP TRIGGER IF EXISTS repositories_credential_secret_scope_trigger ON repositories;
DROP FUNCTION IF EXISTS repositories_credential_secret_scope();

ALTER TABLE repositories
    DROP COLUMN IF EXISTS credential_secret_id;
