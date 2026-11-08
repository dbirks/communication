-- 00028 — ADR-0078 (docs/adr/ADR-0078-catch-up-work-items-and-tours.md):
-- Catch up. An engineer returns to a project and asks one question — "what did
-- the agents do while I was away?" — and this schema is what answers it: the
-- WorkItems the assistant grouped code into, the shared multi-version Tour
-- that tells each item's story, the per-user Seen state, the per-user Recap,
-- the Visits that let the UI suggest a window, and the decision replies a stop
-- can ask for. Plus `projects.color`, the chip the same screen draws.
--
-- The axes this schema holds:
--
--   * the STORY is shared and the READING is private. `catchup_tour_versions`
--     has no user column: one project's engineers read one story in one
--     order, so ranking cannot be argued about and a beat only has to be
--     written once. `catchup_seen_stops` carries the user. The alternative
--     (a tour per user) would let two members of the same project disagree
--     about what happened, and would multiply model work by headcount for no
--     product gain;
--   * a tour is a sequence of VERSIONS, not a mutable row, because seen state
--     has to survive the story being rewritten. Version 3 marking a beat read
--     must mean what it says after version 4 arrives. So the PK is
--     (work_item_id, version), stops are jsonb, and every stop carries a
--     stable `id` plus the `added_in_version` that introduced it: a beat
--     carried into a new version keeps its id and its origin, so a reader who
--     saw it stays caught up on THAT beat while the item badges as UPDATED;
--   * seen state is keyed on (user, work_item, stop_id) with the version
--     RECORDED rather than in the key. Keying on the version would resurrect
--     every carried-over stop as unseen on each rewrite — the opposite of the
--     product decision. `tour_version` is the newest version on which the
--     reader viewed that beat, and "seen" is `tour_version >=
--     added_in_version`, computed by the store;
--   * a decision reply is TEXT with an owner, not a gate. It carries the stop
--     id it answers and the conversation id it will be posted to, and nothing
--     here advances any run state: workflow gates keep the fixed
--     Approve/Request changes/Reject verbs, and mixing the two would let
--     model-written prose vote (ADR-0078 § Decision 4);
--   * `source_run_id` and `conversation_id` carry NO foreign key, for two
--     different reasons that point the same way. Runs are pruned by retention,
--     and the record of what a pruned run did must outlive it. A conversation,
--     likewise: deleting the thread must not erase the decision reply that was
--     sent into it. Neither id is a join key in any read here — the work
--     item's project already scopes both;
--   * `refs` is a jsonb object of the assistant's own claims (issue numbers,
--     PR numbers, commit SHAs, run ids). There is NO GitHub sync in this
--     design: nothing here is reconciled against the remote, so refs are
--     labelled data, not state, and are stored as one checked object;
--   * `projects.color` is NULLable with a CHECK against the palette rather
--     than NOT NULL with a default: an existing project has no colour until a
--     maintainer picks one, and the reads fall back to a deterministic pick by
--     project id. Backfilling would invent a choice nobody made and could not
--     be told from one they had made;
--   * the stops CHECK bounds the ARRAY (what it is, and that it is neither
--     empty nor runaway). The vocabulary inside each element — `importance`,
--     the evidence `type`, 1..4 decision options — is validated by the write
--     path in internal/domain/catchup.go, exactly as ADR-0071 kept an action
--     union's vocabulary in internal/api and its shape here: only our own
--     assistant writes these rows, and a CHECK over model-written objects with
--     keys that are opaque by design would be a jsonpath no maintainer can
--     read.
--
-- Forward-only per ADR-0013. The Down section exists for test resets only.

-- +goose Up

CREATE TABLE catchup_work_items (
    id          uuid        PRIMARY KEY DEFAULT uuidv7(),
    -- Cascades from projects: a work item about a project that is gone is a
    -- fact about nothing.
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    shape       text        NOT NULL CHECK (shape IN ('issue', 'pr', 'push')),
    title       text        NOT NULL CHECK (length (title) BETWEEN 1 AND 200),
    summary     text        NOT NULL CHECK (length (summary) BETWEEN 1 AND 500),
    resolution  text        NOT NULL CHECK (resolution IN
                  ('merged', 'branch_ready', 'open', 'run_failed', 'no_code')),
    -- The assistant's claims about what the work touched: issue_numbers,
    -- pr_numbers, commit_shas, run_ids. An object, never an array or a bare
    -- string; its members are the assistant's vocabulary, not a constraint.
    refs        jsonb       NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof (refs) = 'object'),
    -- No foreign keys on either (see the header). Both are uuid-typed so the
    -- ids a reader follows are at least ids.
    source_run_id   uuid,
    conversation_id uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Bumped by the assistant when the work moves (a new tour version, a new
    -- resolution). It is the clock "since T" filters on.
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Both are stored trimmed, so a bounded column means what a reader sees.
    CONSTRAINT catchup_work_items_title_is_trimmed
        CHECK (length (btrim (title)) = length (title)),
    CONSTRAINT catchup_work_items_summary_is_trimmed
        CHECK (length (btrim (summary)) = length (summary))
);

-- The assistant's re-grouping key: re-describing the same run updates its work
-- item instead of writing a second one. Partial, because a work item with no
-- run (a push nobody attributed to a run) must not collide with another.
CREATE UNIQUE INDEX catchup_work_items_run_key_idx
    ON catchup_work_items (project_id, source_run_id) WHERE source_run_id IS NOT NULL;

-- The list read: one project's items, newest activity first.
CREATE INDEX catchup_work_items_project_updated_idx
    ON catchup_work_items (project_id, updated_at DESC, id DESC);

CREATE TABLE catchup_tour_versions (
    -- Cascades from the work item: an orphan story tells nothing.
    work_item_id uuid        NOT NULL REFERENCES catchup_work_items (id) ON DELETE CASCADE,
    version      integer     NOT NULL CHECK (version >= 1),
    reason       text        NOT NULL CHECK (length (reason) BETWEEN 1 AND 300),
    -- The ordered beats (internal/domain/catchup.go: CatchUpStop). Bounded as
    -- an array here; the store validates every element on the way in.
    stops        jsonb       NOT NULL
                  CHECK (jsonb_typeof (stops) = 'array'
                         AND jsonb_array_length (stops) BETWEEN 1 AND 24),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (work_item_id, version),
    CONSTRAINT catchup_tour_versions_reason_is_trimmed
        CHECK (length (btrim (reason)) = length (reason))
);

-- "The latest version of this item's story", which is every read of a tour.
CREATE INDEX catchup_tour_versions_latest_idx
    ON catchup_tour_versions (work_item_id, version DESC);

CREATE TABLE catchup_seen_stops (
    -- Both cascade: seen state belongs to a reader and to a story, and
    -- outlives neither.
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    work_item_id uuid        NOT NULL REFERENCES catchup_work_items (id) ON DELETE CASCADE,
    -- The stop's stable id, as it appears inside the tour's jsonb. No foreign
    -- key is possible: stop ids live in the tour document, and a model-chosen
    -- string cannot be a key into a table the model rewrites.
    stop_id      text        NOT NULL CHECK (length (stop_id) BETWEEN 1 AND 128),
    -- The NEWEST tour version on which this reader viewed this beat, recorded
    -- rather than keyed (see the header). 0 is impossible: there is no
    -- version 0 of a tour.
    tour_version integer     NOT NULL CHECK (tour_version >= 1),
    seen_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, work_item_id, stop_id)
);

-- "Everything this reader has ever marked seen on this item", which is what
-- `updated` and the SeenBy roster ask for.
CREATE INDEX catchup_seen_stops_item_user_idx
    ON catchup_seen_stops (work_item_id, user_id, tour_version);

CREATE TABLE catchup_recaps (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    -- Cascades from users: a recap is one person's cached summary. There is no
    -- project_id column because a recap spans projects: `project_ids` names
    -- the ones it covered, and a uuid[] is not FK-able. Dropping a project
    -- leaves a recap that mentions it, which is a stale sentence, not a lie
    -- about a row another table needs.
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    "text"       text        NOT NULL CHECK (length ("text") BETWEEN 1 AND 600),
    -- The window the summary covers, as the UI named it ('24h', '7d', …).
    "window"     text        NOT NULL CHECK (length ("window") BETWEEN 1 AND 64),
    project_ids  uuid[]      NOT NULL DEFAULT '{}',
    written_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT catchup_recaps_text_is_trimmed
        CHECK (length (btrim ("text")) = length ("text"))
);

-- "This reader's most recent recap" — the only read the page makes.
CREATE INDEX catchup_recaps_user_written_idx
    ON catchup_recaps (user_id, written_at DESC, id DESC);

CREATE TABLE catchup_visits (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    visited_at timestamptz NOT NULL DEFAULT now()
);

-- "This reader's recent visits, newest first", to infer daily vs weekly.
CREATE INDEX catchup_visits_user_recent_idx
    ON catchup_visits (user_id, visited_at DESC, id DESC);

CREATE TABLE catchup_decision_replies (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    work_item_id uuid        NOT NULL REFERENCES catchup_work_items (id) ON DELETE CASCADE,
    stop_id      text        NOT NULL CHECK (length (stop_id) BETWEEN 1 AND 128),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- The chosen option or the typed text, stored verbatim: it is what will
    -- be posted to the agent conversation, so it is not edited on the way in.
    "text"       text        NOT NULL CHECK (length ("text") BETWEEN 1 AND 2000),
    -- The conversation the reply is destined for, copied from the work item
    -- at write time. NULL when the work has no conversation — the reply is
    -- still recorded, it simply has nowhere to go.
    conversation_id uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT catchup_decision_replies_text_is_trimmed
        CHECK (length (btrim ("text")) = length ("text"))
);

CREATE INDEX catchup_decision_replies_item_idx
    ON catchup_decision_replies (work_item_id, created_at DESC, id DESC);

-- The project chip. A CHECK against a fixed palette, not a general colour
-- grammar: the design chose eight hues precisely because they are not the
-- state colours the same screen uses for resolutions.
ALTER TABLE projects ADD COLUMN color text
    CONSTRAINT projects_color_check CHECK (color IN
        ('#6a4bc4', '#1f8077', '#4a5a78', '#a0527a', '#7a6a2a', '#2f6f9a',
         '#8a4b2a', '#5a7a3a'));

-- +goose Down

ALTER TABLE projects DROP COLUMN IF EXISTS color;
DROP TABLE IF EXISTS catchup_decision_replies;
DROP TABLE IF EXISTS catchup_visits;
DROP TABLE IF EXISTS catchup_recaps;
DROP TABLE IF EXISTS catchup_seen_stops;
DROP TABLE IF EXISTS catchup_tour_versions;
DROP TABLE IF EXISTS catchup_work_items;
