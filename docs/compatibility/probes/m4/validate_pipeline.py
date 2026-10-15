#!/usr/bin/env python3
"""Offline schema validation of pipeline.yaml (docs/compatibility/probes/m4).

The handlers do not exist yet, so the § 7 seed cannot validate through
POST /drafts/{id}/validate. This is the sanctioned stand-in (the M4 seed
brief): validate every YAML document of pipeline.yaml against the pinned
canonical schema asset internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json
with a draft 2020-12 validator — the same vocabulary the server's santhosh
validator implements. This checks STRUCTURE only; loader/compiler rules (DAG,
unknown ids, CEL, secret policy) are the server's and arrive with the gates.

Host deps (already present in the lab, NOT repo dependencies): python3,
PyYAML, jsonschema (draft 2020-12 capable). Exit 0 only with zero errors on
every document. Usage:

    python3 validate_pipeline.py [FILE ...]     # default: ./pipeline.yaml
"""
import json
import os
import sys

import yaml
import jsonschema

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
SCHEMA_AT = os.path.join(REPO, "internal", "pipelines", "schema",
                         "assets", "pipeline-v1alpha1.schema.json")


def validate(path):
    with open(SCHEMA_AT, "rb") as f:
        schema = json.load(f)
    validator = jsonschema.Draft202012Validator(schema)
    with open(path, encoding="utf-8") as f:
        docs = list(yaml.safe_load_all(f))
    errors = 0
    for i, doc in enumerate(docs, 1):
        name = (doc or {}).get("metadata", {}).get("name", "?")
        kind = (doc or {}).get("kind", "?")
        errs = sorted(validator.iter_errors(doc),
                      key=lambda e: list(e.absolute_path))
        for e in errs:
            errors += 1
            loc = "/" + "/".join(str(p) for p in e.absolute_path)
            print(f"ERROR {path}#{i} {name}: {loc}: {e.message}"
                  f"  [schema={'/'.join(str(k) for k in e.absolute_schema_path)}]")
        if not errs:
            print(f"OK   {path}#{i} kind={kind} name={name} "
                  f"nodes={len((doc or {}).get('spec', {}).get('nodes', []))}")
    print(f"docs={len(docs)} errors={errors}")
    return errors


def main(argv):
    files = argv[1:] or [os.path.join(HERE, "pipeline.yaml")]
    total = sum(validate(p) for p in files)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
