#!/usr/bin/env python3
"""test_c3_logic.py — offline unit proof for e2e_m4_exit.py's C3a hand-out reads.

Runs WITHOUT a stack (stdlib unittest only). Two things are graded here:

1. THE SQL SHAPE. C3a GAPped in accept 20261029-100606-1c190fe (m4.out:470-492)
   with "no worker|count rows read — the fan-out opened no child attempts", while
   the same run listed 25 completed child runs five lines earlier. The real cause
   was the driver: both hand-out projections collapse to ONE concatenated text
   column (so psql -tA can print them) but still ended in § 7.1's literal
   `order by 3 desc` / `order by 2 desc` over a one-column select —
   `ERROR: ORDER BY position N is not in select list` — and `GROUP BY 1` over a
   projection that contains count(*) (the same class as D4's C14 bug,
   docs/m4-live-findings.md). A failed read was swallowed as '' and re-reported
   as a product gap. sql_statements_are_well_formed() is the guard that refuses
   to let that shape back in, and the negative-control tests prove it catches the
   exact SQL that broke.
2. THE VERDICT ALGEBRA over the rows the fixed read produces: which workers
   leased how many child attempts, whether the hand-out crossed both online
   workers, and the rule that a FAILED READ gaps with its own reason instead of
   blaming the queue.

3. WHAT "CONTENTION" MEANS, AND THE LEDGER THAT PROVES IT (§ 7.1 C3a, live run
   01a188cd-…). The arm used to read `workers.status` raw — so C6's throwaway
   (communication-m4-worker-c: container removed by stop_throwaway, row still
   status='online' with an hour-old heartbeat) counted as a claimant — and it verdicted
   the CHILD hand-out alone, so "worker-a=25" FAILed while worker-b (capacity 1) had been
   full the whole time with the SAME run's parent chain. Graded here: the online read
   applies the store's own 3×heartbeat window (worker_registry.go:22-29/236), claims are
   counted over the whole run family with their overlap windows, and the load/queue curve
   tells "busy" from "never polled" — the FAIL is kept for the second case only.

A green here means the reads are parseable and the verdicts honest — it never
substitutes for C3's live two-worker § 7 run (12-test-strategy.md).

usage: python3 e2e/m4/test_c3_logic.py [-v]
"""
import contextlib
import io
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

RUN = "01a18822-18ba-71ba-9309-0bd3c950dd71"

# --- the pure SQL-shape checker ----------------------------------------------
#
# Postgres resolves `ORDER BY <n>` / `GROUP BY <n>` against the OUTPUT columns of
# the SELECT, and forbids aggregates inside GROUP BY entirely. Both rules were
# broken in C3a's reads, both are decidable from the statement text: find the
# outer projection, count its items, look at the ordinals.

_AGG_RE = re.compile(r"\b(count|sum|avg|min|max|string_agg|array_agg|bool_and|bool_or)"
                     r"\s*\(", re.I)
_KEYWORDS = ("SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "UNION",
             "OFFSET", "FETCH")


def strip_literals(sql):
    """Blank out single-quoted literals (with '' escaping) and -- comments so
    commas/pipes inside strings never confuse the top-level splitter."""
    sql = re.sub(r"--[^\n]*", " ", sql)
    out, i = [], 0
    while i < len(sql):
        if sql[i] == "'":
            j = i + 1
            while j < len(sql):
                if sql[j] == "'":
                    if j + 1 < len(sql) and sql[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            out.append("''")
            i = j + 1
        else:
            out.append(sql[i])
            i += 1
    return "".join(out)


def _segments(sql):
    """[(depth0 keyword, start, end)] for the outer query only — everything inside
    parentheses (CTEs, subqueries, OVER (...), FILTER (WHERE ...)) is depth > 0 and
    belongs to another query block."""
    text = strip_literals(sql)
    depth, marks = 0, []
    for i, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and text[i:i + 1].isalpha() and (i == 0 or not re.match(
                r"[A-Za-z0-9_]", text[i - 1])):
            word = re.match(r"[A-Za-z_][A-Za-z0-9_]*", text[i:]).group(0).upper()
            if word in _KEYWORDS and not re.match(r"[A-Za-z0-9_]", text[i + len(word):]):
                marks.append((word, i))
    marks.append(("END", len(text)))
    return text, marks


def select_items(sql):
    """The outer projection split on top-level commas ([] when there is no SELECT)."""
    text, marks = _segments(sql)
    for idx, (word, pos) in enumerate(marks):
        if word != "SELECT":
            continue
        end = next((p for w, p in marks[idx + 1:] if w in ("FROM", "END")), None)
        if end is None:
            continue
        return [s.strip() for s in _split_top(text[pos + len("SELECT"):end], ",")
                if s.strip()]
    return []


def _split_top(text, sep):
    parts, depth, cur = [], 0, []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return parts


def clause_items(sql, keyword, stop=("HAVING", "ORDER", "LIMIT", "OFFSET", "FETCH", "END")):
    """Top-level GROUP BY / ORDER BY items ([] when the clause is absent)."""
    text, marks = _segments(sql)
    if keyword == "GROUP BY":
        need, key = "GROUP", r"GROUP\s+BY"
    else:
        need, key = "ORDER", r"ORDER\s+BY"
    for idx, (word, pos) in enumerate(marks):
        if word != need:
            continue
        mm = re.match(key, text[pos:].upper())
        if not mm:
            continue
        end = next((p for w, p in marks[idx + 1:] if w in stop), None)
        return [s.strip() for s in _split_top(text[pos + mm.end():end], ",") if s.strip()]
    return []


def _norm(expr):
    return re.sub(r"\s+", " ", str(expr)).strip().lower()


def sql_statements_are_well_formed(sql):
    """[] when the statement cannot hit the ordinal/aggregate errors that silenced
    C3a, else the reasons. Pure text analysis, no database."""
    problems = []
    items = select_items(sql)
    group_by = clause_items(sql, "GROUP BY")
    order_by = clause_items(sql, "ORDER BY")
    if not items:
        return ["no outer SELECT projection readable — the checker cannot vouch for it"]
    grouped = bool(group_by) or any(_AGG_RE.search(s) for s in items)

    for i, item in enumerate(items, 1):
        if _norm(item) in ("", ","):
            problems.append(f"select item {i} is empty")

    for g in group_by:
        m_ord = re.fullmatch(r"(\d+)", g)
        if m_ord:
            n = int(m_ord.group(1))
            if not 1 <= n <= len(items):
                problems.append(f"GROUP BY position {n} is not in select list "
                                f"({len(items)} column(s) projected)")
            elif _AGG_RE.search(items[n - 1]):
                problems.append(f"aggregate functions are not allowed in GROUP BY "
                                f"(ordinal {n} is `{items[n - 1][:60]}...`)")
        elif _AGG_RE.search(g):
            problems.append(f"aggregate functions are not allowed in GROUP BY "
                            f"(`{g[:60]}...`)")

    for o in order_by:
        expr = re.sub(r"\b(ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)\b", "", o, flags=re.I).strip()
        m_ord = re.fullmatch(r"(\d+)", expr)
        if m_ord:
            n = int(m_ord.group(1))
            if not 1 <= n <= len(items):
                problems.append(f"ORDER BY position {n} is not in select list "
                                f"({len(items)} column(s) projected)")
            continue
        if grouped and not _AGG_RE.search(expr):
            covered = any(_norm(expr) in _norm(s) for s in items) or \
                any(_norm(expr) in _norm(g) for g in group_by)
            if not covered:
                problems.append(f"ORDER BY `{expr[:60]}` is neither an aggregate, an "
                                "output column nor a grouped expression")
    return problems


# --- the old, broken shapes (kept as negative controls) -----------------------

OLD_PARENT_SQL = (f"SELECT coalesce(a.worker_id::text, '(unclaimed)') || ' ' || a.status"
                  f" || ' ' || count(*)::text FROM attempts a JOIN node_executions ne "
                  f"ON ne.id = a.node_execution_id WHERE a.run_id = '{RUN}' "
                  f"GROUP BY a.worker_id, a.status ORDER BY 3 DESC")
OLD_CHILD_SQL = (f"SELECT coalesce(w.name, '(unclaimed)') || '|' || count(*)::text "
                 f"FROM attempts a JOIN runs c ON c.id = a.run_id "
                 f"LEFT JOIN workers w ON w.id = a.worker_id "
                 f"WHERE c.parent_run_id = '{RUN}' GROUP BY 1 ORDER BY 2 DESC")


class SqlShapeCheckerTest(unittest.TestCase):
    """The checker itself: it must reject what Postgres rejected, and only that."""

    def test_it_catches_the_exact_parent_error(self):
        problems = sql_statements_are_well_formed(OLD_PARENT_SQL)
        self.assertTrue(any("ORDER BY position 3 is not in select list" in p
                            for p in problems), problems)

    def test_it_catches_the_exact_child_errors(self):
        problems = sql_statements_are_well_formed(OLD_CHILD_SQL)
        self.assertTrue(any("ORDER BY position 2 is not in select list" in p
                            for p in problems), problems)
        self.assertTrue(any("aggregate functions are not allowed in GROUP BY" in p
                            for p in problems), problems)

    def test_it_accepts_a_healthy_projection(self):
        self.assertEqual(sql_statements_are_well_formed(
            "SELECT type || '|' || count(*)::text FROM domain_events "
            "WHERE run_id = 'x' GROUP BY type ORDER BY count(*) DESC"), [])

    def test_ordinal_clause_over_a_matching_arity_is_fine(self):
        self.assertEqual(sql_statements_are_well_formed(
            "SELECT a, b, count(*)::text FROM t GROUP BY 1, 2 ORDER BY 3 DESC"), [])

    def test_string_commas_and_windows_do_not_confuse_the_splitter(self):
        items = select_items("SELECT x || ',' || count(*) FILTER (WHERE y > 1) AS n, "
                             "row_number() OVER (ORDER BY ts, d, id) AS rn FROM t")
        self.assertEqual(len(items), 2)
        self.assertEqual(clause_items("SELECT rn FROM (SELECT 1 AS rn) q", "ORDER BY"), [])


# --- the ledger's real shape, read straight off the migrations ---------------

_MIGRATIONS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                            "..", "..", "internal", "store", "postgres",
                                            "migrations"))
_TYPES = ("uuid|text|integer|bigint|smallint|jsonb|timestamptz|boolean|numeric|real|"
          "double precision|date|bytea|char|varchar|interval")
_NON_COLUMN = re.compile(r"^(CONSTRAINT|UNIQUE|PRIMARY|FOREIGN|CHECK|EXCLUDE)\b", re.I)


def migration_columns():
    """{table: {column}} from internal/store/postgres/migrations/*.sql — CREATE TABLE
    bodies (split on top-level commas, so `started_at timestamptz, finished_at
    timestamptz` counts twice) plus ALTER TABLE ... ADD COLUMN, minus DROP COLUMN.
    This is what the C3a reads are checked against; the driver's +goose Down section
    lives after '-- +goose Down' and is ignored."""
    cols = {}
    for name in sorted(os.listdir(_MIGRATIONS)):
        if not name.endswith(".sql"):
            continue
        with open(os.path.join(_MIGRATIONS, name)) as fh:
            text = fh.read().split("-- +goose Down")[0]
        for mm in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\("
                              r"(.*?)\n\);", text, re.S):
            # comments and literals first: `-- invalid_output evidence,` and
            # `('queued','leased', ...)` both carry commas the splitter must not see
            body = [f.strip() for f in _split_top(strip_literals(mm.group(2)), ",")]
            cols[mm.group(1)] = {c.group(1) for f in body if not _NON_COLUMN.match(f)
                                 for c in [re.match(r"([a-z_][a-z0-9_]*)\s+(" + _TYPES + r")\b",
                                                    f, re.I)] if c}
        for mm in re.finditer(r"ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN "
                              r"(?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s+(" + _TYPES + r")\b",
                              text, re.I):
            cols.setdefault(mm.group(1), set()).add(mm.group(2))
        for mm in re.finditer(r"ALTER TABLE ([a-z_][a-z0-9_]*)\s+DROP COLUMN",
                              text, re.I):
            drop = re.search(r"DROP COLUMN (?:IF EXISTS )?([a-z_][a-z0-9_]*)", mm.group(0))
            if drop and mm.group(1) in cols:
                cols[mm.group(1)].discard(drop.group(1))
    return cols


def alias_map(sql):
    """{alias: table} for the `FROM|JOIN <table> <alias>` pairs a statement uses."""
    text = strip_literals(sql)
    skip = {"WHERE", "GROUP", "ORDER", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "JOIN",
            "ON", "USING", "UNION", "SET", "VALUES", "LIMIT", "HAVING", "AS"}
    return {a.lower(): t.lower() for t, a in re.findall(
        r"\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b", text, re.I)
        if a.upper() not in skip}


class C3HandoutSqlTest(unittest.TestCase):
    """Every C3a ledger read must be well-formed AND still name the real columns."""

    def test_child_handout_sql_is_well_formed(self):
        self.assertEqual(sql_statements_are_well_formed(m.c3_child_handout_sql(RUN)), [])

    def test_parent_handout_sql_is_well_formed(self):
        self.assertEqual(sql_statements_are_well_formed(m.c3_parent_handout_sql(RUN)), [])

    def test_child_groups_sql_is_well_formed(self):
        self.assertEqual(sql_statements_are_well_formed(m.c3_child_groups_sql(RUN)), [])

    def test_claim_overlap_sql_is_well_formed(self):
        self.assertEqual(sql_statements_are_well_formed(m.c3_claim_overlap_sql(RUN)), [])

    def test_child_handout_reads_the_child_attempts_the_worker_leased(self):
        sql = m.c3_child_handout_sql(RUN)
        for fact in ("attempts a", "runs c", "c.parent_run_id = '" + RUN + "'",
                     "a.worker_id", "workers w", "count(*)"):
            self.assertIn(fact, sql, sql)

    def test_child_handout_never_prints_a_leased_attempt_as_unclaimed(self):
        sql = m.c3_child_handout_sql(RUN)
        self.assertIn("a.worker_id IS NULL THEN '(unclaimed)'", sql)
        self.assertIn("'worker:' || left(a.worker_id::text, 8)", sql)

    def test_handout_orders_by_the_count_not_an_absent_position(self):
        self.assertIn("ORDER BY count(*) DESC", m.c3_child_handout_sql(RUN))
        self.assertIn("ORDER BY count(*) DESC", m.c3_parent_handout_sql(RUN))

    def test_grouped_projection_names_the_grouping_expression(self):
        sql = m.c3_child_handout_sql(RUN)
        group = clause_items(sql, "GROUP BY")
        self.assertEqual(len(group), 1, sql)
        self.assertIn("CASE WHEN", group[0])

    def test_qualified_columns_exist_in_the_migrations(self):
        """1c190fe's C7a GAPped because a gate read a column no migration created.
        Every `alias.column` the C3a reads name (attempts / runs / workers /
        node_executions) is resolved against the real migration text here, so a typo
        is caught offline instead of as a GAP line in the acceptance output."""
        cols = migration_columns()
        sql = " ".join(read(RUN) for read in (m.c3_child_handout_sql,
                                              m.c3_parent_handout_sql,
                                              m.c3_child_groups_sql,
                                              m.c3_claim_overlap_sql))
        aliases = alias_map(sql)
        self.assertTrue(aliases, "no FROM/JOIN table aliases found — the checker is blind")
        refs = set(re.findall(r"\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b", strip_literals(sql)))
        seen = set()
        for alias, column in sorted(refs):
            table = aliases.get(alias)
            if table is None:
                continue          # a CTE name (ev/q) or a qualified type — not a table read
            self.assertIn(table, cols, f"table {table} (alias {alias}) has no CREATE TABLE")
            self.assertIn(column, cols[table],
                          f"{table}.{column} (C3a read) is not a column of {table}: "
                          + ", ".join(sorted(cols[table])))
            seen.add(f"{table}.{column}")
        for must in ("attempts.worker_id", "attempts.run_id", "attempts.status",
                     "attempts.started_at", "attempts.finished_at",
                     "runs.parent_run_id", "workers.name", "node_executions.node_instance_key"):
            self.assertIn(must, seen, f"the C3a reads no longer touch {must}")


class C3HandoutGroupsTest(unittest.TestCase):
    def test_parses_the_fixed_two_column_rows(self):
        self.assertEqual(m.c3_handout_groups("worker-a|13\nworker-b|12\n"),
                         [{"worker": "worker-a", "n": "13"}, {"worker": "worker-b", "n": "12"}])

    def test_drops_the_ragged_lines_a_failed_psql_leaves_behind(self):
        self.assertEqual(m.c3_handout_groups("ERROR:  something\n\nworker-a|9"),
                         [{"worker": "worker-a", "n": "9"}])

    def test_c3_psql_reports_a_failed_read_as_no_rows(self):
        """c3_psql keeps swallowing the error (the leg must not crash); c3_psql2 keeps
        the reason so the GAP can name it."""
        real, out = m.psql, {}
        m.psql = lambda sql: (_ for _ in ()).throw(RuntimeError("psql failed rc=1: boom"))
        try:
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                out["rows"], out["err"] = m.c3_psql2("SELECT 1", "hand-out")
                out["plain"] = m.c3_psql("SELECT 1", "hand-out")
        finally:
            m.psql = real
        self.assertEqual(out["rows"], "")
        self.assertEqual(out["plain"], "")
        self.assertIn("boom", out["err"])
        self.assertIn("hand-out", buf.getvalue())


class C3FanoutVerdictTest(unittest.TestCase):
    """The C3a arms over the rows the fixed read produces — and the honest GAP when
    a read fails instead of the 1c190fe false accusation."""

    def groups(self, *pairs):
        return [{"worker": w, "n": str(n)} for w, n in pairs]

    def test_two_workers_leasing_the_queue_passes_every_arm(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 16), ("worker-b", 9)),
                                         2, [(1, 2), (2, 3)])
        self.assertTrue(all(ok is True for _l, ok, _d in v), v)
        handout = [d for l, _o, d in v if "handed child attempts out" in l][0]
        self.assertIn("25 of 25 child attempts carry a worker_id", handout)

    def test_unclaimed_children_are_counted_but_never_credited(self):
        v = m.c3_fanout_handout_verdicts(
            self.groups(("worker-a", 10), ("(unclaimed)", 15)), 2, [(1, 3)])
        detail = [d for l, _o, d in v if "handed child attempts out" in l][0]
        self.assertIn("10 of 25", detail)

    def test_a_failed_read_gaps_naming_the_driver_not_the_queue(self):
        err = ("psql failed rc=1: ERROR:  ORDER BY position 2 is not in select list")
        v = m.c3_fanout_handout_verdicts([], 2, [], read_error=err, child_runs=25)
        label, ok, detail = [t for t in v if "handed child attempts out" in t[0]][0]
        self.assertIsNone(ok)
        self.assertIn("the driver, not the queue", detail)
        self.assertIn("ORDER BY position 2", detail)
        self.assertIn("25 child run(s)", detail)

    def test_an_empty_ledger_still_gaps_without_the_read_error_wording(self):
        _l, ok, detail = [t for t in m.c3_fanout_handout_verdicts([], 2, [], child_runs=0)
                          if "handed child attempts out" in t[0]][0]
        self.assertIsNone(ok)
        self.assertNotIn("the driver", detail)

    def test_read_error_wording_survives_a_partial_parse(self):
        """Rows the parser can read are still verdicted; only the no-rows arm cites
        the read failure, so a broken ORDER BY can never turn into a PASS."""
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 4)), 2, [(1, 2)],
                                         read_error="psql failed rc=1: boom")
        self.assertTrue([ok for l, ok, _d in v if "handed child attempts out" in l][0])
        self.assertFalse([ok for l, ok, _d in v if "BOTH online workers" in l][0])

    def test_legacy_three_position_call_still_works(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 5), ("worker-b", 5)),
                                         2, [(1, 2)])
        self.assertTrue(all(ok is True for _l, ok, _d in v), v)

    def test_zero_counts_gap_never_pass(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 0)), 2, [(1, 2)])
        self.assertIsNone([ok for l, ok, _d in v if "handed child attempts out" in l][0])


class C3LivenessReadTest(unittest.TestCase):
    """(1) of the fix: the online-worker read uses the PRODUCT's staleness rule."""

    def test_the_window_is_the_ones_the_store_computes(self):
        """30s = 10s heartbeat × 3 intervals: regDefaultHeartbeat (worker_registry.go:29)
        × regLivenessIntervals (worker_registry.go:25), the lab's
        COMMUNICATION_WORKER_HEARTBEAT: "10s" (compose.m4.yml:190/:246)."""
        self.assertEqual(m.C3_WORKER_HEARTBEAT_S, 10)
        self.assertEqual(m.C3_LIVENESS_INTERVALS, 3)
        self.assertEqual(m.C3_LIVENESS_WINDOW_S, 30)

    def test_the_sql_downgrades_a_stale_online_row(self):
        sql = m.c3_worker_liveness_sql()
        self.assertIn("last_heartbeat_at < now() - make_interval(secs => 30)", sql)
        self.assertIn("THEN 'offline' ELSE status END", sql)
        self.assertIn("capacity::text", sql)
        self.assertIn("active_attempts::text", sql)
        self.assertEqual(sql_statements_are_well_formed(sql), [])

    def test_an_unreadable_window_never_means_every_worker_is_dead(self):
        self.assertIn("make_interval(secs => 30)", m.c3_effective_status_expr(""))
        self.assertIn("make_interval(secs => 30)", m.c3_effective_status_expr(-1))
        self.assertIn("make_interval(secs => 60)", m.c3_effective_status_expr("60"))

    def test_liveness_columns_exist_in_the_migrations(self):
        cols = migration_columns()
        for must in ("last_heartbeat_at", "status", "capacity", "active_attempts", "name"):
            self.assertIn(must, cols["workers"], f"workers.{must} is not a real column")

    def test_parses_the_three_row_lab_shape_and_drops_the_dead_throwaway(self):
        """The live precondition: worker-a/worker-b online (fresh beats), worker-c's row
        still 'online' from 17:11:26 — an hour stale, container gone."""
        rows = m.c3_worker_liveness_rows(
            "worker-a|online|online|2.0|3|3\n"
            "worker-b|online|online|1.0|1|1\n"
            "communication-m4-worker-c|online|offline|3714.0|1|0\n"
            "ERROR:  something ragged")
        self.assertEqual(len(rows), 3, rows)
        self.assertEqual([w["worker"] for w in m.c3_online_workers(rows)],
                         ["worker-a", "worker-b"])   # 2 claimants, not 3
        label, ok, detail = m.c3_workers_online_verdict(rows)[0]
        self.assertIs(ok, True, detail)
        self.assertIn("communication-m4-worker-c", detail)
        self.assertIn("stale heartbeat", detail)
        self.assertIn("30s", label)                  # the window is quoted, not assumed

    def test_one_effective_worker_fails_the_precondition_not_the_count(self):
        rows = m.c3_worker_liveness_rows("worker-a|online|online|1.0|3|0\n"
                                         "worker-b|online|offline|91.0|1|0\n")
        _l, ok, detail = m.c3_workers_online_verdict(rows)[0]
        self.assertIs(ok, False)
        self.assertIn("1 effectively online of 2 row(s)", detail)

    def test_an_unreadable_workers_table_gaps_never_fails_or_passes(self):
        _l, ok, detail = m.c3_workers_online_verdict([], "psql failed rc=1: boom")[0]
        self.assertIsNone(ok)
        self.assertIn("boom", detail)

    def test_draining_is_untouched_by_the_staleness_rule(self):
        """The store keeps draining as a deliberate state (worker_registry.go:216-219);
        the read side must not silently downgrade it to offline."""
        self.assertIn("ELSE status END", m.c3_effective_status_expr())
        rows = m.c3_worker_liveness_rows("worker-b|draining|draining|800.0|1|0\n")
        self.assertEqual(m.c3_online_workers(rows), [])   # draining is not online


# --- (2) the ledger shape of live run 01a188cd-… : one run, two claimants ------
#
# worker-a (capacity 3) took ALL 25 fan-out children; worker-b (capacity 1) was busy the
# whole time with the SAME run's own chain (/plan, /publish_plan, /emit_items,
# /build_until_verified[1..2]/{implement,test,review,test_evidence}, /publish_verified —
# 15 s holds back-to-back), so its single slot was never free for a child.
# Times are seconds from the start of the leg so the arithmetic is reviewable.
E = 1_755_000_000.0


def fam_row(scope, worker, created, started, finished):
    fmt = lambda v: "-" if v is None else f"{v:.3f}"
    return f"{scope}|{worker}|{fmt(created)}|{fmt(started)}|{fmt(finished)}"


def busy_row(worker, started, delta):
    return f"{started:.3f}|{worker}|load|{delta}"


def queue_row(at, delta):
    return f"{at:.3f}|(queue)|queue|{delta}"


def observed_ledger(worker_b_claims_chain=True):
    """(family-claim text, load/queue-curve text) for the run above. With
    worker_b_claims_chain=False the SAME queue drains while worker-b holds nothing at all
    — the case that MUST stay a FAIL."""
    fam = []
    if worker_b_claims_chain:
        for i in range(8):                     # 8 × 15 s back-to-back: E+0 … E+120
            fam.append(fam_row("parent", "worker-b", E + 15 * i, E + 15 * i, E + 15 * (i + 1)))
    else:
        fam.append(fam_row("parent", "worker-b", E, E, E + 15))   # done before the queue
    fam.append(fam_row("parent", "worker-a", E + 120, E + 120, E + 135))
    for i in range(25):                        # queued together at E+30, claimed in threes
        started = E + 40 + 9 * (i // 3)
        fam.append(fam_row("child", "worker-a", E + 30, started, started + 15))
    curve = []
    if worker_b_claims_chain:
        for i in range(8):
            curve.append(busy_row("worker-b", E + 15 * i, 1))
            curve.append(busy_row("worker-b", E + 15 * (i + 1), -1))
    else:
        curve += [busy_row("worker-b", E, 1), busy_row("worker-b", E + 15, -1)]
    curve.append(busy_row("worker-a", E + 120, 1))
    curve.append(busy_row("worker-a", E + 135, -1))
    for i in range(25):
        started = E + 40 + 9 * (i // 3)
        curve.append(busy_row("worker-a", started, 1))
        curve.append(busy_row("worker-a", started + 15, -1))
    return ("\n".join(fam), "\n".join([queue_row(E + 30, 25)]
                                    + [queue_row(E + 40 + 9 * (i // 3), -1) for i in range(25)]
                                    + curve))


def observed_contention(worker_b_claims_chain=True, errors=()):
    """The whole pure pipeline over the ledger text: rows → windows → overlap → arms."""
    fam_text, curve_text = observed_ledger(worker_b_claims_chain)
    fam_rows = m.c3_claim_rows(fam_text)
    load, queue = m.c3_capacity_events(curve_text)
    caps = {"worker-a": 3, "worker-b": 1}
    return m.c3_contention_verdicts(
        {w: n for w, n in m.c3_family_claims(fam_rows)["child"].items()}, 2,
        {"family": m.c3_family_claims(fam_rows),
         "overlap": m.c3_cross_worker_overlap(fam_rows),
         "windows": m.c3_slot_windows(load, queue, caps),
         "online": ["worker-a", "worker-b"], "errors": list(errors)})


def arm(verdicts, needle):
    return [(l, ok, d) for l, ok, d in verdicts if needle in l]


class C3FamilyClaimReadTest(unittest.TestCase):
    def test_family_sql_is_well_formed_and_reads_both_scopes(self):
        sql = m.c3_family_claims_sql(RUN)
        self.assertEqual(sql_statements_are_well_formed(sql), [])
        for fact in (f"a.run_id = '{RUN}'", "(SELECT r.id FROM runs r WHERE "
                     f"r.parent_run_id = '{RUN}')", "a.worker_id", "a.started_at",
                     "a.finished_at", "coalesce(a.created_at, a.scheduled_at)"):
            self.assertIn(fact, sql, sql)

    def test_capacity_curve_sql_is_well_formed_and_bounded(self):
        sql = m.c3_capacity_events_sql(RUN)
        self.assertEqual(sql_statements_are_well_formed(sql), [])
        for fact in ("'load' AS kind", "'queue' AS kind", "x.started_at < b.t1",
                     "greatest(x.started_at, b.t0)", "least(coalesce(x.finished_at, b.t1), b.t1)"):
            self.assertIn(fact, sql, sql)

    def test_claim_rows_count_a_leased_row_that_never_began_as_a_claim(self):
        """started_at is set by BeginAttempt, not by the claim, so a leased row carries a
        worker_id and no interval: it is a CLAIM (never dropped) and no overlap."""
        rows = m.c3_claim_rows("child|worker-a|100.0|100.0|115.0\nchild|worker-b|100.0|-|-\n")
        fam = m.c3_family_claims(rows)
        self.assertEqual(fam["child"], {"worker-a": 1, "worker-b": 1})
        self.assertEqual(m.c3_worker_live_segments(rows), [(100.0, "worker-a", 1),
                                                           (115.0, "worker-a", -1)])

    def test_unclaimed_children_are_counted_and_never_credited(self):
        fam = m.c3_family_claims(m.c3_claim_rows(
            "child|(unclaimed)|100.0|-|-\nchild|worker-a|100.0|100.0|115.0\n"))
        self.assertEqual((fam["unclaimed_children"], fam["attempts"], fam["child"]),
                         (1, 2, {"worker-a": 1}))


class C3SlotWindowTest(unittest.TestCase):
    """The read that separates "busy" from "never polled" (workers.capacity × the
    attempts ledger), and the arithmetic it must get right."""

    def windows(self, load_text, queue_text, caps):
        load, _q = m.c3_capacity_events(load_text)
        _l, queue = m.c3_capacity_events(queue_text)
        return m.c3_slot_windows(load, queue, caps)

    def test_a_capacity_one_worker_holding_an_attempt_the_whole_queue_is_never_free(self):
        load = "\n".join([busy_row("worker-b", E, 1), busy_row("worker-b", E + 100, -1)])
        queue = "\n".join([queue_row(E, 1), queue_row(E + 90, -1)])
        win = self.windows(load, queue, {"worker-a": 3, "worker-b": 1})["worker-b"]
        self.assertEqual((win["queue_s"], win["free_queue_s"], win["busy_queue_s"]),
                         (90.0, 0.0, 90.0))

    def test_a_capacity_one_worker_holding_nothing_is_idle_for_the_whole_queue(self):
        load = "\n".join([busy_row("worker-a", E, 1), busy_row("worker-a", E + 90, -1)])
        queue = "\n".join([queue_row(E, 1), queue_row(E + 90, -1)])
        win = self.windows(load, queue, {"worker-a": 3, "worker-b": 1})["worker-b"]
        self.assertEqual((win["queue_s"], win["free_queue_s"], win["max_free"]),
                         (90.0, 90.0, 1))

    def test_capacity_three_is_only_full_at_three(self):
        load = "\n".join([busy_row("worker-a", E, 1), busy_row("worker-a", E, 1),
                           busy_row("worker-a", E, 1), busy_row("worker-a", E + 5, -1),
                           busy_row("worker-a", E + 5, -1), busy_row("worker-a", E + 10, -1)])
        queue = "\n".join([queue_row(E, 1), queue_row(E + 10, -1)])
        win = self.windows(load, queue, {"worker-a": 3})["worker-a"]
        self.assertEqual((win["busy_queue_s"], win["free_queue_s"]), (5.0, 5.0))

    def test_the_counter_never_goes_negative_when_a_claim_starts_before_the_window(self):
        """The SQL clips loads to the window (greatest(started_at, t0)); a -1 with no
        matching +1 must still not make a full worker look free."""
        load = "\n".join([busy_row("worker-b", E + 50, -1)])
        queue = "\n".join([queue_row(E, 1), queue_row(E + 100, -1)])
        win = self.windows(load, queue, {"worker-b": 1})["worker-b"]
        self.assertEqual((win["queue_s"], win["free_queue_s"]), (100.0, 100.0))

    def test_unknown_capacity_is_absent_not_idle_and_empty_curves_are_zero(self):
        queue = "\n".join([queue_row(E, 1), queue_row(E + 10, -1)])
        win = self.windows("", queue, {"worker-a": 3, "worker-x": 0})
        self.assertEqual(list(win), ["worker-a"])          # cap 0 is unmeasurable, not idle
        self.assertEqual(win["worker-a"]["free_queue_s"], 10.0)
        self.assertEqual(self.windows("", "", {"worker-a": 3})["worker-a"]["queue_s"], 0.0)

    def test_capacity_is_parsed_from_the_ledger_text_not_assumed(self):
        rows = m.c3_worker_liveness_rows("worker-a|online|online|1.0|3|3\n")
        self.assertEqual(m._int(rows[0]["capacity"]), 3)


class C3OverlapTest(unittest.TestCase):
    def test_serial_claims_never_overlap(self):
        rows = m.c3_claim_rows("child|worker-a|1|1|2\nchild|worker-b|1|2|3\n")
        o = m.c3_cross_worker_overlap(rows)
        self.assertEqual((o["peak_workers"], o["overlap_s"], o["points"]), (1, 0.0, 3))

    def test_two_workers_holding_one_run_at_once_are_contention_in_time(self):
        rows = m.c3_claim_rows("parent|worker-b|1|1|100\nchild|worker-a|1|10|20\n")
        o = m.c3_cross_worker_overlap(rows)
        self.assertEqual((o["peak_workers"], o["overlap_s"]), (2, 10.0))
        self.assertEqual(o["pairs"], {"worker-a+worker-b": 10.0})

    def test_no_readable_windows_is_zero_points_not_zero_overlap(self):
        self.assertEqual(m.c3_cross_worker_overlap([])["points"], 0)


class C3ContentionVerdictTest(unittest.TestCase):
    """The honest § 7.1 C3a verdict over the live ledger shape."""

    def contention(self, *a, **kw):
        return observed_contention(*a, **kw)

    def arm(self, v, needle):
        return arm(v, needle)

    def test_observed_run_is_contention_at_the_run_level_not_a_starved_claimant(self):
        """25 children on worker-a, worker-b's one slot full of THIS run's chain for every
        second the queue waited: the contract's read is over the parent run, and the
        parent chain + children DID cross both claimants while both were live."""
        v = self.contention()
        ok = [o for _l, o, _d in self.arm(v, "BOTH online workers")][0]
        self.assertIs(ok, True)
        detail = self.arm(v, "BOTH online workers")[0][2]
        self.assertIn("worker-a=25", detail)
        self.assertIn("full capacity", detail)
        fam_ok = [o for _l, o, _d in self.arm(v, "whole run")][0]
        self.assertIs(fam_ok, True)
        self.assertIn("worker-b=8", self.arm(v, "whole run")[0][2])
        self.assertIn("peak workers holding this run at once=2", self.arm(v, "whole run")[0][2])
        idle_ok = [o for _l, o, _d in self.arm(v, "sat idle")][0]
        self.assertIs(idle_ok, True)

    def test_a_worker_with_a_free_slot_and_no_claims_still_fails(self):
        """THE anti-weakening case: same 25-child queue, worker-b genuinely idle → the
        hand-out arm FAILs and the idle arm names the seconds."""
        v = self.contention(worker_b_claims_chain=False)
        self.assertIs([o for _l, o, _d in self.arm(v, "BOTH online workers")][0], False)
        self.assertIn("free slot", self.arm(v, "BOTH online workers")[0][2])
        idle_ok, idle_detail = self.arm(v, "sat idle")[0][1], self.arm(v, "sat idle")[0][2]
        self.assertIs(idle_ok, False)
        self.assertIn("IDLE WITH WORK TO DO", idle_detail)
        self.assertIn("worker-b", idle_detail)

    def test_children_split_across_both_claimants_passes_on_the_strict_reading(self):
        v = self.contention()
        # override the hand-out with the two-claimant child split the fix must still like
        fam_rows = m.c3_claim_rows(observed_ledger()[0])
        load, queue = m.c3_capacity_events(observed_ledger()[1])
        v = m.c3_contention_verdicts({"worker-a": 13, "worker-b": 12}, 2,
                                     {"family": m.c3_family_claims(fam_rows),
                                      "overlap": m.c3_cross_worker_overlap(fam_rows),
                                      "windows": m.c3_slot_windows(load, queue,
                                                                   {"worker-a": 3,
                                                                    "worker-b": 1}),
                                      "online": ["worker-a", "worker-b"], "errors": []})
        _lab, _ok, det = self.arm(v, "BOTH online workers")[0]
        self.assertIs(_ok, True)
        self.assertIn("both online claimants drew children", det)

    def test_no_curve_is_a_gap_and_never_a_pass(self):
        fam_rows = m.c3_claim_rows("child|worker-a|1|1|2\nparent|worker-b|1|1|2\n")
        v = m.c3_contention_verdicts({"worker-a": 1}, 2,
                                     {"family": m.c3_family_claims(fam_rows),
                                      "overlap": m.c3_cross_worker_overlap(fam_rows),
                                      "windows": {}, "online": ["worker-a", "worker-b"],
                                      "errors": ["psql failed rc=1: boom"]})
        self.assertIsNone([o for _l, o, _d in self.arm(v, "BOTH online workers")][0])
        self.assertIn("boom", self.arm(v, "BOTH online workers")[0][2])
        self.assertIsNone([o for _l, o, _d in self.arm(v, "sat idle")][0])

    def test_saturated_but_never_crossing_gaps_with_the_experiment_fix(self):
        """worker-b was full the whole queue window, but only with ANOTHER run's work, so
        this run never gave the two claimants a shared instant: unmeasured, never a PASS
        and never a blamed FAIL."""
        fam_rows = m.c3_claim_rows("child|worker-a|100|100|115\nchild|worker-a|100|115|130\n")
        load = [(100.0, "worker-b", 1), (130.0, "worker-b", -1)]
        queue = [(100.0, 1), (130.0, -1)]
        v = m.c3_contention_verdicts({"worker-a": 2}, 2,
                                     {"family": m.c3_family_claims(fam_rows),
                                      "overlap": m.c3_cross_worker_overlap(fam_rows),
                                      "windows": m.c3_slot_windows(load, queue,
                                                                   {"worker-a": 3,
                                                                    "worker-b": 1}),
                                      "online": ["worker-a", "worker-b"], "errors": []})
        _label, ok, detail = self.arm(v, "BOTH online workers")[0]
        self.assertIsNone(ok)
        self.assertIn("UNMEASURED", detail)
        self.assertIn("single slot is free", detail)
        self.assertIs([o for _l, o, _d in self.arm(v, "sat idle")][0], True)

    def test_one_effective_claimant_gaps_the_contention_arm(self):
        v = self.contention()
        fam_rows = m.c3_claim_rows(observed_ledger()[0])
        v1 = m.c3_contention_verdicts({"worker-a": 25}, 1,
                                      {"family": m.c3_family_claims(fam_rows),
                                       "overlap": m.c3_cross_worker_overlap(fam_rows),
                                       "windows": {}, "online": ["worker-a"], "errors": []})
        _l, ok, detail = self.arm(v1, "BOTH online workers")[0]
        self.assertIsNone(ok)
        self.assertIn("EFFECTIVELY online", detail)
        self.assertIn("30s", detail)

    def test_crossed_the_family_but_never_at_once_is_a_measured_fail_on_the_overlap_arm(self):
        fam_rows = m.c3_claim_rows("parent|worker-b|1|1|10\nchild|worker-a|1|20|30\n")
        v = m.c3_contention_verdicts({"worker-a": 1}, 2,
                                     {"family": m.c3_family_claims(fam_rows),
                                      "overlap": m.c3_cross_worker_overlap(fam_rows),
                                      "windows": {"worker-a": {"queue_s": 40.0,
                                                               "free_queue_s": 0.0,
                                                               "busy_queue_s": 40.0,
                                                               "busy_s": 30.0, "max_free": 0,
                                                               "capacity": 3},
                                                 "worker-b": {"queue_s": 40.0,
                                                              "free_queue_s": 0.0,
                                                              "busy_queue_s": 40.0,
                                                              "busy_s": 30.0, "max_free": 0,
                                                              "capacity": 1}},
                                      "online": ["worker-a", "worker-b"], "errors": []})
        self.assertIs([o for _l, o, _d in self.arm(v, "whole run")][0], False)
        self.assertIsNone([o for _l, o, _d in self.arm(v, "BOTH online workers")][0])

    def test_a_window_row_without_capacity_still_verdicts_instead_of_crashing(self):
        """The gate must not die on a partially readable curve: capacity is quoted with
        .get(), so a row missing it yields the same honest GAP as no row at all."""
        fam_rows = m.c3_claim_rows("child|worker-a|100|100|115\nparent|worker-b|100|100|115\n")
        v = m.c3_contention_verdicts({"worker-a": 1}, 2,
                                     {"family": m.c3_family_claims(fam_rows),
                                      "overlap": m.c3_cross_worker_overlap(fam_rows),
                                      "windows": {"worker-b": {"queue_s": 15.0,
                                                               "free_queue_s": 0.0,
                                                               "busy_queue_s": 15.0,
                                                               "busy_s": 15.0,
                                                               "max_free": 0}},
                                      "online": ["worker-a", "worker-b"], "errors": []})
        self.assertIs([o for _l, o, _d in self.arm(v, "BOTH online workers")][0], True)
        self.assertIn("cap None", self.arm(v, "sat idle")[0][2])   # quoted, not invented

    def test_every_line_is_a_c3a_arm_with_its_own_numbers(self):
        """No arm may print without evidence in its detail: a PASS with an empty reason is
        how a mocked green reads as a real one (§ 7.1's reporting rule)."""
        for kw in ({}, {"worker_b_claims_chain": False}):
            v = self.contention(**kw)
            self.assertEqual(len(v), 3, v)
            for label, ok, detail in v:
                self.assertTrue(label.startswith("C3a "), label)
                self.assertIn(ok, (True, False))
                self.assertGreater(len(detail), 40, (label, detail))
                self.assertRegex(detail, r"\d", (label, detail))

    def test_the_fanout_call_without_capacity_evidence_keeps_the_strict_fail(self):
        """The old contract stays reachable: with no curve, one claimant out of two online
        workers FAILs — the honest reading is only unlocked by the evidence."""
        v = m.c3_fanout_handout_verdicts([{"worker": "worker-a", "n": "25"}], 2, [(1, 3)])
        self.assertIs([o for _l, o, _d in self.arm(v, "BOTH online workers")][0], False)
        self.assertEqual(len(self.arm(v, "BOTH online workers")), 1)

    def test_the_fanout_call_with_capacity_evidence_emits_the_extra_arms_once(self):
        cont = {"family": m.c3_family_claims(m.c3_claim_rows(observed_ledger()[0])),
                "overlap": m.c3_cross_worker_overlap(m.c3_claim_rows(observed_ledger()[0])),
                "windows": m.c3_slot_windows(*m.c3_capacity_events(observed_ledger()[1]),
                                             {"worker-a": 3, "worker-b": 1}),
                "online": ["worker-a", "worker-b"], "errors": []}
        v = m.c3_fanout_handout_verdicts([{"worker": "worker-a", "n": "25"}], 2, [(1, 3)],
                                         contention=cont)
        self.assertEqual(len(self.arm(v, "BOTH online workers")), 1)
        self.assertEqual(len(self.arm(v, "sat idle")), 1)
        self.assertTrue(all(o is not None for _l, o, _d in v), v)


if __name__ == "__main__":
    unittest.main(verbosity=2)
