#!/usr/bin/env python3
"""test_c4_logic.py — offline unit proof for e2e_m4_exit.py's C4 SQL builders.

live4's C4 gate died before a single C4b/C4c/C4e CHECK ran: psql returned
`ERROR: column reference "status" is ambiguous` for the C4a row read, which
joins attempts to node_executions — BOTH carry a status column, so a bare
status has no resolution and rc=1 aborts the gate (live4/C4.out).

A green here means the SQL the driver SENDS is resolvable against the real
schema (the column lists read out of internal/store/postgres/migrations), plus
a driver-wide sweep for the same crash shape. It never substitutes for C4's
live § 7 run (12-test-strategy.md: a mocked green is not done).

usage: python3 e2e/m4/test_c4_logic.py [-v]
"""
import ast
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "e2e_m4_exit.py")
MIG_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "internal", "store", "postgres",
                                       "migrations"))

_TABLE_RE = re.compile(r"CREATE TABLE ([a-z_][a-z0-9_]*) \((.*?)\n\);", re.S)
_NOT_COLUMN = ("constraint", "check", "unique", "primary", "foreign", "exclude")
_ALIAS_STOP = {"on", "where", "join", "left", "right", "inner", "outer", "cross", "group",
               "order", "limit", "lateral", "using", "set", "having", "filter"}
_ALIAS_RE = re.compile(r"\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?",
                       re.I)
_QUALIFIED_RE = re.compile(r"\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b")
_BARE_STATUS_RE = re.compile(r"(?<![\w.'])\bstatus\b")


def migration_tables():
    """{table: [column, ...]} from the CREATE TABLE blocks in the migrations."""
    tables = {}
    for fn in sorted(os.listdir(MIG_DIR)):
        if not fn.endswith(".sql"):
            continue
        with open(os.path.join(MIG_DIR, fn), encoding="utf-8") as fh:
            for name, body in _TABLE_RE.findall(fh.read()):
                cols = tables.setdefault(name, [])
                for line in body.splitlines():
                    line = line.split("--")[0].strip()
                    if not line or line.lower().startswith(_NOT_COLUMN):
                        continue
                    cols.append(line.split()[0].lower())
    return tables


TABLES = migration_tables()


def table_aliases(sql):
    """{alias_or_table: table} for every FROM/JOIN in one built query."""
    out = {}
    for hit in _ALIAS_RE.finditer(sql.lower()):
        table, alias = hit.group(1), hit.group(2) or ""
        if alias in _ALIAS_STOP:
            alias = ""
        out[alias or table] = table
    return out


def unresolved_columns(sql):
    """`alias.column` refs whose column is NOT in that table's migration block."""
    aliases = table_aliases(sql)
    bad = []
    for alias, col in _QUALIFIED_RE.findall(sql.lower()):
        table = aliases.get(alias)
        if table is None or table not in TABLES:
            continue                       # a subquery-local alias we do not model
        if col not in TABLES[table]:
            bad.append(f"{alias}.{col} -> {table}.{col}")
    return bad


SQL_EXECUTING = {"psql", "c6_row", "c7_sql", "c8_sql", "c10_sql", "c12_sql",
                 "c4_live_attempt"}


def _literal(node, builders=None):
    """Static text of a (possibly f-string / concatenated) expression; builders
    lets a call to a `return "..."` helper resolve to its own SQL text."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(_literal(v, builders) for v in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _literal(node.left, builders) + _literal(node.right, builders)
    if isinstance(node, ast.FormattedValue):
        return _literal(node.value, builders) if builders else ""
    if isinstance(node, ast.Call) and builders:
        name = node.func.id if isinstance(node.func, ast.Name) else ""
        return builders.get(name, "")
    return ""


def sql_builders(tree):
    """{name: SQL} for module-level `def *_sql(...): return <literal>` helpers —
    without this, psql(c1_run_digest_sql(run_id)) reads as an empty query."""
    out = {}
    for node in tree.body:
        if (isinstance(node, ast.FunctionDef) and isinstance(node.body[-1], ast.Return)
                and node.name.endswith("_sql")):
            text = _literal(node.body[-1].value, out)
            if text:
                out[node.name] = text
    return out


def sql_call_texts(path=DRIVER):
    """First-argument SQL text of every psql/c*_row/c*_sql call in the driver."""
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    builders = sql_builders(tree)
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
        if fn in SQL_EXECUTING and node.args:
            out.append((node.lineno, _literal(node.args[0], builders)))
    return out


def strip_literals(sql):
    """Quoted bodies are data, not column references — `' status=' ` must not
    read as a bare status column."""
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def bare_status_in_join_calls(path=DRIVER):
    """live4/C4's crash shape, driver-wide: a joined query whose SELECT list
    names status with no table qualifier. Returns [(line, fragment), ...]."""
    hits = []
    for line, sql in sql_call_texts(path):
        if not re.search(r"\bjoin\b", sql, re.I):
            continue
        head = re.split(r"\bfrom\b", strip_literals(sql), maxsplit=1, flags=re.I)[0]
        if _BARE_STATUS_RE.search(head):
            hits.append((line, head.strip()[:120]))
    return hits


class C4FrozenAttemptSqlTest(unittest.TestCase):
    SQL = None

    @classmethod
    def setUpClass(cls):
        cls.SQL = m.c4_frozen_attempt_sql("att-1")

    def test_status_is_always_qualified(self):
        # every `status` token in the built query must sit behind a dot
        for hit in re.finditer(r"\bstatus\b", self.SQL, re.I):
            self.assertEqual(self.SQL[hit.start() - 1], ".",
                             f"unqualified status at {hit.start()}: {self.SQL[:hit.start() + 8]}")

    def test_select_list_leads_with_the_attempt_status(self):
        self.assertTrue(self.SQL.startswith("SELECT a.status || ' worker='"), self.SQL[:80])

    def test_every_referenced_column_exists_in_the_migration(self):
        self.assertEqual(unresolved_columns(self.SQL), [], self.SQL)

    def test_the_join_and_its_tables_are_the_live_ones(self):
        aliases = table_aliases(self.SQL)
        self.assertEqual(aliases.get("a"), "attempts")
        self.assertEqual(aliases.get("ne"), "node_executions")
        self.assertEqual(aliases.get("w"), "workers")

    def test_the_attempt_id_is_the_only_hole(self):
        self.assertIn("WHERE a.id = 'att-1'", self.SQL)
        self.assertNotIn("{", self.SQL)


class DriverSqlSweepTest(unittest.TestCase):
    """The grep the live4 crashes asked for: no other query repeats either shape."""

    def test_the_driver_actually_has_join_queries_to_sweep(self):
        joined = [(ln, sql) for ln, sql in sql_call_texts() if re.search(r"\bjoin\b", sql, re.I)]
        self.assertGreater(len(joined), 10, f"only {len(joined)} joined queries found "
                                            "— the sweep would pass vacuously")

    def test_no_joined_query_selects_a_bare_status(self):
        self.assertEqual(bare_status_in_join_calls(), [])

    def test_no_query_reads_digest_scope_without_the_revision_it_pins(self):
        """live4/C1's shape: digest_scope lives on pipeline_revisions (and
        pipeline_drafts), never on runs, so a query naming it must name the
        pinned revision's table too."""
        bad = [(ln, sql[:140]) for ln, sql in sql_call_texts()
               if "digest_scope" in sql.lower() and "pipeline_revisions" not in sql.lower()]
        self.assertEqual(bad, [])


class MigrationReaderTest(unittest.TestCase):
    def test_the_tables_this_gate_reads_are_parsed(self):
        for table in ("runs", "pipeline_revisions", "attempts", "node_executions", "workers"):
            self.assertIn(table, TABLES, f"{table} block unreadable in {MIG_DIR}")
        self.assertIn("status", TABLES["attempts"])
        self.assertIn("status", TABLES["node_executions"])
        self.assertIn("node_instance_key", TABLES["node_executions"])
        self.assertIn("fencing_token", TABLES["attempts"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
