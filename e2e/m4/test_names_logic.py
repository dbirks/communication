#!/usr/bin/env python3
"""test_names_logic.py - offline proof that e2e_m4_exit.py authors SCHEMA-LEGAL names.

Live evidence this guards (m4-exit C6/C7/C10): every re-authored revision was
refused with schema_shape "'m4x-c6-restore-T083004Z' does not match pattern
'^[a-z][a-z0-9.-]{0,127}$'" at /metadata/name — the driver built names from
time.strftime("%Y%m%dT%H%M%SZ"), whose uppercase T/Z the metadata.name pattern
forbids. The pattern below is READ from the schema asset, never copied, so the
test fails the day the schema tightens and the helper stops following it.

usage: python3 e2e/m4/test_names_logic.py [-v]
"""
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCHEMA = os.path.join(REPO, "internal", "pipelines", "schema", "assets",
                      "pipeline-v1alpha1.schema.json")
DRIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_m4_exit.py")

# Every builder whose argument lands in a document's metadata.name (Pipeline or
# NodeTemplate) — with its POSITION in that signature, because the splice helpers
# take (doc, name) and the authoring helpers take (name, nodes). Callers in the
# driver must feed it a legal name.
NAME_ARG = {
    "c6_restore_doc": 1, "c7_exhaustion_doc": 1, "c10_malformed_doc": 1,
    "c12_rename": 1, "c12_splice": 1, "c12_one_word_doc": 1, "c12_ws_doc": 1,
    "c12_operator_doc": 1, "c12_budget_number_doc": 1,
    "c13_doc": 0, "c13_root_doc": 0, "c13_root_probe_doc": 0,
    "c13_root_misuse_doc": 0, "c13_template_doc": 0, "c12_until_doc": 0,
    "c12_exprs_doc": 0, "c12_fanout_doc": 0, "c12_fanout_run_doc": 0,
    "c12_exec_budget_doc": 0,
}


def name_patterns(path=SCHEMA):
    """metadata.name's pattern, for every document kind the schema defines."""
    with open(path, encoding="utf-8") as f:
        schema = json.load(f)
    out = {}
    for kind, d in schema["$defs"].items():
        props = ((d.get("properties") or {}).get("metadata") or {}).get("properties") or {}
        if "name" in props and "pattern" in props["name"]:
            out[kind] = props["name"]["pattern"]
    return out


PATTERNS = name_patterns()


class SchemaName(unittest.TestCase):
    def test_pattern_is_read_not_copied(self):
        self.assertIn("PipelineDocument", PATTERNS)
        self.assertIn("NodeTemplateDocument", PATTERNS)
        self.assertTrue(all(re.match(r"^\^?\[a-z\]", p) for p in PATTERNS.values()), PATTERNS)

    def test_helper_output_emits_unquoted_and_round_trips(self):
        """A name is pasted into YAML text by c13_doc/c12_rename and re-exported by
        doc_yaml_emit: it must survive both as the SAME bytes, not quoted away."""
        for prefix in ("m4x-c6-restore", "m4x-c7-exhaust", "m4x-c10-invalid"):
            got = m.schema_name(prefix)
            self.assertEqual(m.doc_scalar(got), got)
            self.assertTrue(m.doc_plain_ok(got), got)
            self.assertEqual(m.c12_rename("metadata:\n  name: old\n", got),
                             "metadata:\n  name: " + got + "\n")

    def test_helper_matches_every_document_name_pattern(self):
        for prefix in ("m4x-c6-restore", "m4x-c7-exhaust", "m4x-c7-pred",
                       "m4x-c10-invalid", "m4x-c12a-0", "m4x-c13b-typo"):
            for suffix in (None, "", "20261016T083004Z", "abc 123"):
                got = m.schema_name(prefix, suffix) if suffix is not None \
                    else m.schema_name(prefix)
                for kind, pat in PATTERNS.items():
                    self.assertRegex(got, pat, f"{prefix}/{suffix!r} -> {got} ({kind})")

    def test_the_old_generated_name_would_still_fail(self):
        """The regression this whole file exists for: the test must BITE."""
        bad = "m4x-c6-restore-T083004Z"
        for pat in PATTERNS.values():
            self.assertNotRegex(bad, pat)
        self.assertRegex(m.schema_name("m4x-c6-restore", "20261016T083004Z"),
                         PATTERNS["PipelineDocument"])

    def test_hostile_prefixes_stay_legal_and_bounded(self):
        cases = ["", "-", ".", "9lives", "UPPER-Case", "has spaces here", "emoji ✗ ok",
                 "a" * 200, "m4x-c6-restore-" + "x" * 200, "..ds//..", "tab\there",
                 "m4x/c12/exprs", "###", "0", "_leading"]
        for prefix in cases:
            for suffix in ("", "20261016T083004Z", "-X-"):
                got = m.schema_name(prefix, suffix)
                self.assertLessEqual(len(got), 128, f"{prefix[:20]!r} -> {got}")
                for kind, pat in PATTERNS.items():
                    self.assertRegex(got, pat, f"{prefix[:20]!r}/{suffix!r} -> {got} ({kind})")

    def test_stamp_kept_and_prefix_truncated_at_cap(self):
        got = m.schema_name("m4x-" + "q" * 200, "20261016T083004Z")
        self.assertEqual(len(got), 128)
        self.assertTrue(got.endswith("20261016t083004z"), got[-24:])
        whole = m.schema_name("m4x-" + "q" * 200)          # the default UTC stamp
        self.assertEqual(len(whole), 128)
        self.assertRegex(whole, r"-\d{14}$", whole[-16:])

    def test_default_stamp_is_lowercase_digits_only(self):
        got = m.schema_name("m4x-c6-restore")
        self.assertRegex(got, r"^m4x-c6-restore-\d{14}$", got)

    def test_no_stamp_mode_is_verbatim_for_legal_names(self):
        self.assertEqual(m.schema_name("m4x-c12a-0", ""), "m4x-c12a-0")
        self.assertEqual(m.schema_name("m4x-c13-scratch", ""), "m4x-c13-scratch")

    def test_distinct_calls_are_distinct(self):
        seen = {m.schema_name("m4x-c6-restore", s) for s in
                ("20261016T083004Z", "20261016T083104Z", "20261016T083204Z")}
        self.assertEqual(len(seen), 3, seen)


class DriverCallSites(unittest.TestCase):
    """Every name the driver hands a document builder is either a literal the
    schema already accepts or the product of schema_name() — no gate may paste a
    strftime stamp into a document again."""

    def call_sites(self):
        with open(DRIVER, encoding="utf-8") as f:
            src = f.read()
        sites = []
        for fn, want in NAME_ARG.items():
            for mo in re.finditer(r"(?<![\w.])%s\(\s*(?!\))" % re.escape(fn), src):
                args, arg, i, depth = [], "", mo.end(), 1
                while i < len(src):
                    ch = src[i]
                    if ch in "([{":
                        depth += 1
                    elif ch in ")]}":
                        depth -= 1
                        if depth == 0:
                            break
                    elif ch == "," and depth == 1:
                        args.append(arg.strip())
                        arg = ""
                        i += 1
                        continue
                    arg += ch
                    i += 1
                args.append(arg.strip())
                if want < len(args):
                    sites.append((fn, args[want]))
        return sites

    def test_there_are_call_sites_to_check(self):
        self.assertGreater(len(self.call_sites()), 15, "the scan found nothing to scan")

    def test_every_document_name_argument_is_legal(self):
        for fn, arg in self.call_sites():
            if arg.startswith('"') and arg.endswith('"') and len(arg.split('"')) == 3:
                got = arg[1:-1]
                self.assertTrue(got, fn)
                for kind, pat in PATTERNS.items():
                    self.assertRegex(got, pat, f"{fn}({arg}) violates {kind}")
            elif arg.startswith("schema_name("):
                continue
            elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", arg):
                continue                      # a parameter: its callers are scanned too
            else:
                self.fail(f"{fn}({arg}) — a computed document name that is not "
                          "schema_name(...); it must go through the helper")

    def test_no_strftime_stamp_is_pasted_into_a_document(self):
        """The stamps stay where they belong — the API's idempotency key, which
        accepts uppercase — and never reach a document name."""
        with open(DRIVER, encoding="utf-8") as f:
            for line in f:
                if re.match(r"^\s*(def |#)", line):
                    continue
                for fn in NAME_ARG:
                    if re.search(r"%s\([^)]*\{(suffix|stamp)" % re.escape(fn), line):
                        self.fail(f"raw stamp interpolated into a document name: {line.strip()}")


class OtherPatternedFields(unittest.TestCase):
    """The document fields the schema pattern-checks that the driver also writes:
    process.exec `executable` and the node ids (the schema's `identifier`, which
    forbids '-' and '.' entirely). Same rule as metadata.name — the pattern is read
    from the asset, so a probe cannot quietly carry a second, unrelated refusal."""

    def patterns(self):
        with open(SCHEMA, encoding="utf-8") as f:
            schema = json.load(f)
        return (schema["$defs"]["configProcessExec"]["properties"]["executable"]["pattern"],
                schema["$defs"]["identifier"]["pattern"])

    def test_executable_values_are_schema_legal(self):
        pat, _ident = self.patterns()
        with open(DRIVER, encoding="utf-8") as f:
            vals = re.findall(r"executable:\s*([^\s,}'\"\\]+)", f.read())
        self.assertGreater(len(vals), 3, vals)
        for v in sorted(set(vals)):
            if v.startswith("$") or v.startswith("@@"):
                continue                       # a binding or a splice marker, not a literal
            self.assertRegex(v, pat, f"executable: {v}")

    def test_authored_node_ids_are_schema_legal(self):
        _pat, ident = self.patterns()
        with open(DRIVER, encoding="utf-8") as f:
            src = f.read()
        # Only identifier-looking tokens: an id carrying '-' or '.' is exactly what
        # this catches, while a log path (`/event:`) or a URL is not an id at all.
        ids = re.findall(r"(?m)^\s*-?\s*id:\s*([A-Za-z_][A-Za-z0-9_.@-]*)", src) \
            + re.findall(r"\{id:\s*([A-Za-z_][A-Za-z0-9_.@-]*)", src)
        self.assertGreater(len(ids), 5, sorted(set(ids)))
        for v in sorted(set(ids)):
            if v.startswith("$") or "@@" in v or v in ("name", "nid"):
                continue
            self.assertRegex(v, ident, f"node id {v}")


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
