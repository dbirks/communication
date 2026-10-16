package compiler_test

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
)

// contract § 7 C13c / ADR-0021 § 3 invariant 5 and Security: a credential
// pasted into config.env passes EVERY schema (the spike
// secret-literal-in-config proved a schema cannot express it), so the
// compiler's detector is the boundary. It must (a) block, (b) locate the
// finding on the exact instance pointer the editor highlights, and (c) never
// quote the value — the validate body is echoed to a browser and stored
// verbatim on the draft row.

func secretDoc(env string) string {
	return `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: secret-literal-probe
spec:
  inputs:
    type: object
  nodes:
    - id: s1
      kind: process.exec
      timeoutSeconds: 60
      config:
        executable: python3
` + env
}

func TestSecretLiteralInConfigEnvIsABlock(t *testing.T) {
	const literal = "postgres://u:p@h/d"
	_, diags := compileValid(t, secretDoc("        env:\n          DATABASE_URL: \""+literal+"\"\n"),
		compiler.Options{})
	if diags.Valid() {
		t.Fatalf("the document carrying a credential in config.env was accepted: %v", diags)
	}
	d := firstCode(t, diags, diag.CodeSecretLiteral)
	if d == nil {
		t.Fatalf("no secret_literal_detected finding: %v", diags)
	}
	if got := string(d.InstanceLocation); got != "/spec/nodes/0/config/env/DATABASE_URL" {
		t.Errorf("instance_location = %s, want /spec/nodes/0/config/env/DATABASE_URL", got)
	}
	t.Logf("finding: %s", d.Message)
	if d.Source != diag.SourceCompiler {
		t.Errorf("source = %s, want compiler", d.Source)
	}
	// The value must not appear in any finding, message or hint.
	for _, e := range diags {
		if strings.Contains(e.Message, literal) || strings.Contains(e.Hint, literal) {
			t.Errorf("finding %s echoes the literal value: %s", e.Code, e.Message)
		}
	}
}

func TestSecretLiteralShapesRefused(t *testing.T) {
	for _, tc := range []struct{ name, cfg, wantLoc string }{
		{"credential url",
			"        env:\n          DATABASE_URL: \"postgres://u:p@h/d\"\n",
			"/spec/nodes/0/config/env/DATABASE_URL"},
		{"secret shaped name",
			"        env:\n          STRIPE_API_KEY: \"supersecretvalue12\"\n",
			"/spec/nodes/0/config/env/STRIPE_API_KEY"},
		{"provider token",
			"        env:\n          CARGO_REGISTRY_TOKEN: \"ghp_01234567890123456789012345678901234\"\n",
			"/spec/nodes/0/config/env/CARGO_REGISTRY_TOKEN"},
		{"dsn inline password",
			"        env:\n          OPTIONS: \"Host=h;Password=s3cr3tvalue;Db=d\"\n",
			"/spec/nodes/0/config/env/OPTIONS"},
		{"pem private key",
			"        env:\n          SIGNING_PRIVATE_KEY: \"-----BEGIN RSA PRIVATE KEY-----MII\"\n",
			"/spec/nodes/0/config/env/SIGNING_PRIVATE_KEY"},
		{"credential url in args",
			"        args: [\"curl\", \"https://admin:hunter2@host/api\"]\n",
			"/spec/nodes/0/config/args/1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, diags := compileValid(t, secretDoc(tc.cfg), compiler.Options{})
			d := firstCode(t, diags, diag.CodeSecretLiteral)
			if d == nil {
				t.Fatalf("accepted a %s literal: %v", tc.name, diags)
			}
			if got := string(d.InstanceLocation); got != tc.wantLoc {
				t.Errorf("instance_location = %s, want %s", got, tc.wantLoc)
			}
		})
	}
}

// The legal form is a reference: the value is materialised by the worker from
// the assignment-level mount (ADR-0018), never written into the document.
// The legal form is a reference: config.secretRefs names an assignment-level
// mount and the worker materialises the value at execution time (ADR-0018);
// nothing credential-shaped is written into the document at all.
func TestSecretReferenceInConfigEnvStaysLegal(t *testing.T) {
	_, diags := compileValid(t, secretDoc("        env:\n"+
		"          LOG_LEVEL: debug\n"+
		"          REPO_URL: https://github.com/acme/widgets\n"+
		"        secretRefs: [project/database_url]\n"), compiler.Options{})
	if !diags.Valid() {
		t.Fatalf("a credential-free env block was refused: %v", diags)
	}
}

// The redaction scan uses the same detector as the walk, so a finding raised
// by another stage (the schema quotes offending scalars) can still be stripped
// before the body is answered or stored.
func TestSecretLiteralValuesScansTheDocument(t *testing.T) {
	const literal = "postgres://u:p@h/d"
	doc, d := loader.Load([]byte(secretDoc("        env:\n          DATABASE_URL: \"" + literal + "\"\n")))
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	got := compiler.SecretLiteralValues(doc)
	if len(got) != 1 || got[0] != literal {
		t.Fatalf("SecretLiteralValues = %q, want [%s]", got, literal)
	}
	diags := diag.List{{
		Code:    diag.CodeSchemaShape,
		Message: "pattern: got " + literal + ", want relativePath",
	}}
	diags.Redact(got...)
	if strings.Contains(diags[0].Message, literal) {
		t.Errorf("Redact left the literal in %q", diags[0].Message)
	}
}
