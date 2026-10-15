// Package loader turns authored YAML bytes into the JSON value tree the schema
// validator sees, enforcing the rules ADR-0021 § 4 assigns to the loader
// because JSON Schema cannot see them: single document, duplicate keys, alias
// budget, and YAML's silent scalar-type coercions.
//
// The walk runs over yaml.Node, not the decoded value, because every one of
// those rules needs the authored scalar text and its resolved tag — `0123` is
// only a hazard if you can still see the authored `0`, and `2026-10-14` is only
// dangerous because YAML resolves it to a timestamp.
package loader

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"

	yaml "go.yaml.in/yaml/v3"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// MaxDocumentBytes is the draft document bound (contract § 6; the DB carries
// the same CHECK on pipeline_drafts.document_text).
const MaxDocumentBytes = 262144

// Budgets from contract § 6. yaml.v3's own alias abort stays the backstop, not
// the contract (ADR-0021 § 4).
const (
	MaxAliasNodes  = 512
	MaxAliasDepth  = 64
	MaxMappingKeys = 4096
)

// Document kinds with a registered schema branch (ADR-0021 § 2). A kind not
// listed here is unknown_document_kind — never a fallback to Pipeline.
const (
	KindPipeline     = "Pipeline"
	KindNodeTemplate = "NodeTemplate"
)

// Document is a parsed, loader-clean document.
type Document struct {
	Text  []byte      // the authored bytes
	Root  *yaml.Node  // the document's root content node (a mapping)
	Value canon.Value // the JSON tree the schema validator sees
	Kind  string      // the kind envelope member
	Name  string      // metadata.name, when present
	Notes []string    // ADR-0021 § 4: expansions that changed what is hashed
}

// Map returns the document root as an object, or nil when it is not a mapping.
func (d Document) Map() map[string]canon.Value {
	m, _ := d.Value.(map[string]canon.Value)
	return m
}

// SourceSHA256 is the digest of the exact imported bytes (ADR-0021 § 6): it is
// stored on the draft record only, so GitOps drift has a textual answer that
// does not pretend text equals identity.
func (d Document) SourceSHA256() string {
	return canon.Digest(d.Text)[len("sha256:"):]
}

// Load parses one document and enforces the loader rules. A non-empty
// diagnostic list means the document never reaches the schema validator:
// loader rules gate the JSON the schema sees (contract § 2.2).
func Load(text []byte) (Document, diag.List) {
	var diags diag.List
	doc := Document{Text: text}
	if len(text) > MaxDocumentBytes {
		diags.Addf(diag.SourceLoader, diag.CodeDocumentTooLarge, ptr.Root,
			"document is %d bytes; the limit is %d", len(text), MaxDocumentBytes)
		return doc, diags
	}
	if len(bytes.TrimSpace(text)) == 0 {
		diags.Addf(diag.SourceLoader, diag.CodeInvalidYAML, ptr.Root, "document is empty")
		return doc, diags
	}

	roots, ok := parseDocuments(text, &diags)
	if !ok || len(diags) > 0 {
		return doc, diags
	}
	if len(roots) == 0 {
		diags.Addf(diag.SourceLoader, diag.CodeInvalidYAML, ptr.Root, "document is empty")
		return doc, diags
	}
	if len(roots) > 1 {
		diags.Addf(diag.SourceLoader, diag.CodeMultipleDocuments, ptr.Root,
			"file holds %d YAML documents; exactly one is allowed", len(roots))
		return doc, diags
	}
	root := roots[0]
	doc.Root = root
	if root.Kind != yaml.MappingNode {
		diags.Addf(diag.SourceLoader, diag.CodeUnknownDocument, ptr.Root,
			"a v1alpha1 document must be a mapping at the root, got %s", nodeKindName(root.Kind))
		return doc, diags
	}

	w := &walker{diags: &diags}
	w.inspect(root, ptr.Root, 0)
	if len(diags) > 0 {
		return doc, diags
	}
	value, verr := w.toValue(root, ptr.Root)
	if verr != nil || len(diags) > 0 {
		return doc, diags
	}
	doc.Value = value
	doc.Notes = w.notes()

	obj := doc.Map()
	kind, _ := obj["kind"].(string)
	if kind == "" {
		diags.Addf(diag.SourceLoader, diag.CodeUnknownDocument, ptr.Root,
			"no kind: a v1alpha1 document needs an apiVersion/kind envelope (only Pipeline and NodeTemplate are schema'd in M4)")
		return doc, diags
	}
	switch kind {
	case KindPipeline, KindNodeTemplate:
	default:
		diags.Addf(diag.SourceLoader, diag.CodeUnknownDocument, ptr.Root.Child("kind"),
			"kind %q has no registered schema branch, and a kind without a schema cannot be published (ADR-0021 § 2)", kind)
		return doc, diags
	}
	doc.Kind = kind
	if meta, ok := obj["metadata"].(map[string]canon.Value); ok {
		doc.Name, _ = meta["name"].(string)
	}
	return doc, diags
}

// parseDocuments decodes every document in the file. The target is a yaml.Node,
// so duplicate-key detection is the walker's job, not the decoder's.
func parseDocuments(text []byte, diags *diag.List) ([]*yaml.Node, bool) {
	var docs []*yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(text))
	for {
		var n yaml.Node
		err := dec.Decode(&n)
		if errors.Is(err, io.EOF) {
			return docs, true
		}
		if err != nil {
			var te *yaml.TypeError
			if errors.As(err, &te) {
				for _, m := range te.Errors {
					diags.Addf(diag.SourceLoader, diag.CodeInvalidYAML, ptr.Root, "%s", m)
				}
				return nil, false
			}
			diags.Addf(diag.SourceLoader, diag.CodeInvalidYAML, ptr.Root, "%s", firstLine(err.Error()))
			return nil, false
		}
		if n.Kind == yaml.DocumentNode {
			if len(n.Content) != 1 {
				diags.Addf(diag.SourceLoader, diag.CodeInvalidYAML, ptr.Root, "malformed document node")
				return nil, false
			}
			docs = append(docs, n.Content[0])
		} else {
			docs = append(docs, &n)
		}
		if len(docs) > 1 { // one extra document is enough to name the failure
			return docs, true
		}
	}
}

type walker struct {
	diags     *diag.List
	aliases   int
	aliasUsed bool
	mergeUsed bool
	bailed    bool
}

func (w *walker) fail(at ptr.Pointer, code diag.Code, format string, args ...any) {
	if w.bailed {
		return
	}
	w.bailed = true
	w.diags.Addf(diag.SourceLoader, code, at, format, args...)
}

// inspect enforces the node-tree rules: duplicate keys, alias budget, and the
// scalar coercions YAML 1.1 habits hide in the document.
func (w *walker) inspect(n *yaml.Node, at ptr.Pointer, aliasDepth int) {
	if n == nil || w.bailed {
		return
	}
	switch n.Kind {
	case yaml.AliasNode:
		w.aliases++
		w.aliasUsed = true
		if w.aliases > MaxAliasNodes {
			w.fail(at, diag.CodeAliasBudget, "document uses more than %d alias nodes", MaxAliasNodes)
			return
		}
		if aliasDepth+1 > MaxAliasDepth {
			w.fail(at, diag.CodeAliasBudget, "alias expansion is deeper than %d levels", MaxAliasDepth)
			return
		}
		if n.Alias == nil {
			w.fail(at, diag.CodeInvalidYAML, "alias %q has no anchor in this document", n.Value)
			return
		}
		w.inspect(n.Alias, at, aliasDepth+1)
	case yaml.MappingNode:
		seen := make(map[string]int, len(n.Content)/2)
		if len(n.Content)/2 > MaxMappingKeys {
			w.fail(at, diag.CodeGraphTooLarge, "mapping has %d keys; the limit is %d", len(n.Content)/2, MaxMappingKeys)
			return
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			if isMergeKey(k) {
				w.mergeUsed = true
				w.inspectMerge(v, at, aliasDepth)
				continue
			}
			if k.Kind != yaml.ScalarNode {
				w.fail(at, diag.CodeInvalidYAML, "object keys must be strings, got %s", nodeKindName(k.Kind))
				return
			}
			if _, dup := seen[k.Value]; dup {
				w.fail(at, diag.CodeDuplicateKey, "mapping key %q is defined twice", k.Value)
				return
			}
			seen[k.Value] = k.Line
			inUI := at == "/metadata/ui" || strings.HasPrefix(string(at), "/metadata/ui/")
			w.checkScalar(k, at, inUI)
			w.inspect(v, at.Child(k.Value), aliasDepth)
		}
	case yaml.SequenceNode:
		for i, c := range n.Content {
			w.inspect(c, at.Index(i), aliasDepth)
		}
	case yaml.ScalarNode:
		inUI := at == "/metadata/ui" || strings.HasPrefix(string(at), "/metadata/ui/")
		w.checkScalar(n, at, inUI)
	}
}

// inspectMerge walks a `<<` value: the keys it contributes are not duplicates
// of the document's own, but the referenced mapping still gets checked.
func (w *walker) inspectMerge(v *yaml.Node, at ptr.Pointer, aliasDepth int) {
	if v == nil {
		return
	}
	if v.Kind == yaml.SequenceNode {
		for _, c := range v.Content {
			w.inspectMerge(c, at, aliasDepth)
		}
		return
	}
	if v.Kind == yaml.AliasNode {
		w.inspect(v, at, aliasDepth)
		return
	}
	w.inspect(v, at, aliasDepth)
}

// checkScalar enforces ADR-0021 § 4's timestamp and numeric rules. metadata.ui
// is exempt from the timestamp rule because it is served, never digested.
func (w *walker) checkScalar(n *yaml.Node, at ptr.Pointer, inUI bool) {
	switch n.Tag {
	case "!!timestamp":
		if inUI {
			return
		}
		w.fail(at, diag.CodeUnquotedDate,
			"scalar %q resolved to a timestamp; quote it to keep it a string", n.Value)
	case "!!int":
		if isOverflowInt(n.Value) {
			w.fail(at, diag.CodeInvalidNumber, "integer %q does not fit int64", n.Value)
			return
		}
		if hasLeadingZero(n.Value) {
			w.fail(at, diag.CodeInvalidNumber,
				"integer %q has a leading zero and decodes as %s; write it without the leading zero, or quote it to make it a string",
				n.Value, octalHint(n.Value))
		}
	case "!!float":
		f, err := strconv.ParseFloat(strings.ReplaceAll(n.Value, "_", ""), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			w.fail(at, diag.CodeInvalidNumber, "number %q is not a finite JSON number", n.Value)
		}
	}
}

func (w *walker) toValue(n *yaml.Node, at ptr.Pointer) (canon.Value, error) {
	if n == nil || w.bailed {
		return nil, errors.New("loader stopped")
	}
	switch n.Kind {
	case yaml.ScalarNode:
		return w.scalar(n, at)
	case yaml.SequenceNode:
		out := make([]canon.Value, 0, len(n.Content))
		for i, c := range n.Content {
			v, err := w.toValue(c, at.Index(i))
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		out := make(map[string]canon.Value, len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, vn := n.Content[i], n.Content[i+1]
			if isMergeKey(k) {
				if err := w.mergeInto(out, vn, at); err != nil {
					return nil, err
				}
				continue
			}
			if k.Kind != yaml.ScalarNode {
				w.fail(at, diag.CodeInvalidYAML, "object keys must be strings, got %s", nodeKindName(k.Kind))
				return nil, errors.New("non-string key")
			}
			key, err := w.keyText(k, at)
			if err != nil {
				return nil, err
			}
			v, err := w.toValue(vn, at.Child(key))
			if err != nil {
				return nil, err
			}
			out[key] = v
		}
		return out, nil
	case yaml.AliasNode:
		return w.toValue(n.Alias, at)
	}
	return nil, nil
}

// mergeInto applies YAML's merge-key precedence: an explicit key in the
// receiving mapping wins over a merged one.
func (w *walker) mergeInto(out map[string]canon.Value, v *yaml.Node, at ptr.Pointer) error {
	if v == nil {
		return nil
	}
	if v.Kind == yaml.SequenceNode {
		for _, c := range v.Content {
			if err := w.mergeInto(out, c, at); err != nil {
				return err
			}
		}
		return nil
	}
	src, err := w.toValue(v, at)
	if err != nil {
		return err
	}
	mm, ok := src.(map[string]canon.Value)
	if !ok {
		w.fail(at, diag.CodeInvalidYAML, "merge key value must be a mapping, got %s", jsonKind(src))
		return errors.New("bad merge")
	}
	for k, val := range mm {
		if _, exists := out[k]; !exists {
			out[k] = val
		}
	}
	return nil
}

func (w *walker) keyText(k *yaml.Node, at ptr.Pointer) (string, error) {
	if k.Tag != "!!str" {
		w.fail(at, diag.CodeInvalidYAML, "object keys must be strings, got %s (%s); quote the key", nodeKindName(k.Kind), k.Tag)
		return "", errors.New("non-string key")
	}
	return k.Value, nil
}

// scalar decodes a scalar node by its resolved tag. Walking nodes rather than
// decoding blind is what makes `2026-10-14`, `0123` and `.inf` visible before
// anything hashes the document.
func (w *walker) scalar(n *yaml.Node, at ptr.Pointer) (canon.Value, error) {
	switch n.Tag {
	case "!!null":
		return nil, nil
	case "!!bool":
		switch strings.ToLower(n.Value) {
		case "true", "yes", "on", "y":
			return true, nil
		case "false", "no", "off", "n":
			return false, nil
		}
		w.fail(at, diag.CodeInvalidYAML, "scalar %q is not a boolean", n.Value)
		return nil, errors.New("bad bool")
	case "!!int":
		i, err := strconv.ParseInt(strings.ReplaceAll(n.Value, "_", ""), 0, 64)
		if err != nil {
			w.fail(at, diag.CodeInvalidNumber, "integer %q is not representable", n.Value)
			return nil, errors.New("bad int")
		}
		return i, nil
	case "!!float":
		f, err := strconv.ParseFloat(strings.ReplaceAll(n.Value, "_", ""), 64)
		if err != nil {
			w.fail(at, diag.CodeInvalidNumber, "number %q is not representable", n.Value)
			return nil, errors.New("bad float")
		}
		return f, nil
	case "!!str", "":
		return n.Value, nil
	case "!!timestamp":
		// metadata.ui is exempt from the timestamp rule (ADR-0021 § 4: the
		// subtree is served, never digested), so the same authored text that
		// inspect() lets through must not die here — scalar() previously
		// refused it through the default branch, making the exemption dead
		// code. It is carried as its authored text.
		if at == "/metadata/ui" || strings.HasPrefix(string(at), "/metadata/ui/") {
			return n.Value, nil
		}
		w.fail(at, diag.CodeUnquotedDate,
			"scalar %q resolved to a timestamp; quote it to keep it a string", n.Value)
		return nil, errors.New("timestamp")
	default:
		w.fail(at, diag.CodeInvalidYAML, "tag %s is not allowed in a pipeline document", n.Tag)
		return nil, errors.New("disallowed tag")
	}
}

func (w *walker) notes() []string {
	if !w.aliasUsed {
		return nil
	}
	if w.mergeUsed {
		return []string{"merge keys and aliases were expanded before hashing; the export is regenerated from the canonical document"}
	}
	return []string{"aliases were expanded before hashing; the export is regenerated from the canonical document"}
}

func isMergeKey(k *yaml.Node) bool {
	return k.Kind == yaml.ScalarNode && (k.Tag == "!!merge" || k.Value == "<<")
}

// hasLeadingZero reports YAML 1.1's octal trap. 0x/0o/0b spellings are explicit
// and stay legal; a bare `0123` silently becomes 83.
func hasLeadingZero(v string) bool {
	s := strings.TrimLeft(v, "+-")
	if strings.ContainsAny(s, "xXoObB") {
		return false
	}
	return len(s) >= 2 && s[0] == '0' && s[1] >= '0' && s[1] <= '9'
}

func octalHint(v string) string {
	if i, err := strconv.ParseInt(strings.TrimLeft(v, "+-"), 8, 64); err == nil {
		return fmt.Sprintf("%d", i)
	}
	return "an octal number"
}

func isOverflowInt(v string) bool {
	s := strings.ReplaceAll(v, "_", "")
	if _, err := strconv.ParseInt(s, 0, 64); err == nil {
		return false
	}
	_, err := strconv.ParseFloat(s, 64)
	return err == nil
}

func jsonKind(v canon.Value) string {
	switch v.(type) {
	case map[string]canon.Value:
		return "mapping"
	case []canon.Value:
		return "sequence"
	case string:
		return "string"
	case nil:
		return "null"
	default:
		return fmt.Sprintf("%T", v)
	}
}

func nodeKindName(k yaml.Kind) string {
	switch k {
	case yaml.DocumentNode:
		return "document"
	case yaml.MappingNode:
		return "mapping"
	case yaml.SequenceNode:
		return "sequence"
	case yaml.ScalarNode:
		return "scalar"
	case yaml.AliasNode:
		return "alias"
	}
	return "node"
}

func firstLine(s string) string {
	if i := strings.Index(s, "\n"); i >= 0 {
		return s[:i]
	}
	return s
}
