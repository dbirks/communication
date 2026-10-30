#!/usr/bin/env python3
"""Fail when a `go test -json` report contains a skipped test.

Why this exists: the repository's own rule is that CI runs every test
(communication-spec/00-product-vision.md, 12-test-strategy.md — "no test is
skipped"), and a skip is an assertion that never ran. It is invisible in a
green job: the package reports ok, the step exits 0, and the capability the
test existed to prove goes unproven while the badge says otherwise. That is
how a compatibility table gets prefilled with PASS it never observed
(AGENTS.md), so the verdict is read out of the machine-readable event stream
instead of the prose.

What counts as a skip: `go test -json` records one as {"Action":"skip"} with a
"Test" field naming the test (or the subtest — "TestA/b"). A {"Action":"skip"}
WITHOUT a "Test" field is the package-level verdict, which is what Go emits for
a package that has no test files at all ("?   pkg [no test files]", observed on
go1.27: Action=skip, no Test). That is a statement about file layout, not an
assertion that did not run, so it is not a failure here.

A report that carries no test-shaped event at all is a failure too. An empty,
truncated or absent report proves nothing ran, which is the same hole approached
from the other side — so "0 tests, 0 skips" must never read as success.

Usage: check-go-test-skips.py [go-test.json]   (exit 0 clean, 1 skips found,
2 the report itself is unusable). Stdlib only: the runner's system python3 is
enough, and nothing here adds a dependency (the same rule as the
m4-gate-logic job).
"""

import json
import sys

TEST_ACTIONS = ("run", "pass", "fail", "skip")


def main(argv):
    path = argv[1] if len(argv) > 1 else "go-test.json"
    try:
        report = open(path, encoding="utf-8", errors="replace")
    except OSError as exc:
        print(f"::error::{path}: {exc}")
        print(f"error: cannot read the go test report: {exc}")
        return 2

    skipped = []          # (package, test), first occurrence order
    seen = set()
    started = set()       # (package, test) that reported Action=run
    events = 0
    unparsed = 0

    with report:
        for line in report:
            line = line.strip()
            if not line:
                continue
            events += 1
            try:
                event = json.loads(line)
            except ValueError:
                unparsed += 1
                continue
            if not isinstance(event, dict):
                unparsed += 1
                continue
            action = event.get("Action")
            test = event.get("Test")
            if not test or not isinstance(test, str) or action not in TEST_ACTIONS:
                continue  # a package- or build-level event: not a test verdict
            key = (event.get("Package", "?"), test)
            if action == "run":
                started.add(key)
            elif action == "skip" and key not in seen:
                seen.add(key)
                skipped.append(key)

    if events == 0:
        print(f"::error::{path} is empty: go test produced no events at all")
        print(f"error: no test event found in {path}; an empty report is not a pass")
        return 2
    if not started:
        print(
            "::error::{} reported {} event(s) and not one started test: the run "
            "never executed anything (build failure, truncated output, or no test "
            "files matched)".format(path, events)
        )
        return 2

    print(
        "go test report: {} events, {} tests started, {} skipped, {} unparsed "
        "line(s)".format(events, len(started), len(skipped), unparsed)
    )
    if not skipped:
        print("no skipped test: every test CI registered also ran")
        return 0

    print("::error::{} test(s) skipped — the rule is that CI runs every test "
          "(12-test-strategy); a skipped assertion is an unproven one".format(len(skipped)))
    for pkg, test in skipped:
        print("  SKIP {}/{}".format(pkg, test))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
