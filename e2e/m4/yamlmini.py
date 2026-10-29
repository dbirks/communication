#!/usr/bin/env python3
"""yamlmini.py — the tiny stdlib-only YAML subset the e2e/m4 logic tests need.

CI's m4-gate-logic job runs on the runner's plain system python3, which has no
PyYAML (and adding a dependency for an offline test is off the table). The
logic tests still have to prove things about the YAML the gates author: the
seed's hand-written pipeline.yaml, the 4-space route-14-style canonical
exports the gates splice against, and the bytes e2e_m4_exit.py's doc_yaml_emit
prints. Every one of those documents is machine-shaped or authored to one
house style, so a targeted reader/writer beats skipping the proof.

Implemented subset (everything the tests actually feed it):
  * block mappings and block sequences, sequence dashes either indented under
    their key or level with it, any indent width;
  * flow mappings/sequences on one line ({type: string}, [a, [b, c]]);
  * plain scalars with YAML 1.1 core resolution (null/bool/int/float/string),
    single-quoted scalars with '' escapes, double-quoted scalars with JSON
    escapes (that is exactly what doc_yaml_emit writes);
  * literal (|) and folded (>) block scalars with -/+ chomping;
  * whole-line and trailing (' #') comments; a single leading '---'.

Anything OUTSIDE the subset (tabs in indentation, anchors, tags, multi-line
quoted/plain scalars, a second document in safe_load) raises YAMLError — the
tests then fail loudly instead of quietly proving nothing. The API mirrors the
PyYAML call sites one-for-one: safe_load, safe_load_all (returns a LIST),
safe_dump/dump with indent/sort_keys (extra kwargs accepted and ignored).

usage: import yamlmini as yaml  (after sys.path knows this directory)
"""
import json
import re

__all__ = ["YAMLError", "safe_load", "safe_load_all", "safe_dump", "dump"]


class YAMLError(Exception):
    """Raised for input outside the implemented subset, or malformed within it."""


_NULL = frozenset({"", "~", "null", "Null", "NULL"})
_TRUE = frozenset({"true", "True", "TRUE", "yes", "Yes", "YES", "on", "On", "ON"})
_FALSE = frozenset({"false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF"})
_INT_RX = re.compile(r"[-+]?\d+$")
_FLOAT_RX = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$")


def _resolve_plain(s):
    if s in _NULL:
        return None
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    if _INT_RX.match(s):
        return int(s)
    if ("." in s or "e" in s or "E" in s) and _FLOAT_RX.match(s):
        return float(s)
    return s


def _skip(line):
    st = line.strip()
    return st == "" or st.startswith("#")


def _scan_single(text, pos):
    """text[pos] == "'": return (decoded, pos_after_closing_quote)."""
    out, n = [], len(text)
    i = pos + 1
    while i < n:
        c = text[i]
        if c == "'":
            if i + 1 < n and text[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            return "".join(out), i + 1
        out.append(c)
        i += 1
    raise YAMLError("unterminated single-quoted scalar")


_ESCAPES = {"0": "\0", "a": "\a", "b": "\b", "t": "\t", "n": "\n", "v": "\v",
            "f": "\f", "r": "\r", "e": "\x1b", "\\": "\\", '"': '"', "/": "/",
            " ": " ", "N": "\x85", "_": "\xa0", "L": "\u2028", "P": "\u2029"}


def _scan_double(text, pos):
    """text[pos] == '"': return (decoded, pos_after_closing_quote)."""
    out, n = [], len(text)
    i = pos + 1
    while i < n:
        c = text[i]
        if c == '"':
            return "".join(out), i + 1
        if c == "\\":
            if i + 1 >= n:
                break
            e = text[i + 1]
            if e in ("x", "u", "U"):
                digits = {"x": 2, "u": 4, "U": 8}[e]
                try:
                    out.append(chr(int(text[i + 2:i + 2 + digits], 16)))
                except ValueError:
                    raise YAMLError(f"bad \\{e} escape in {text[pos:i + 8]!r}")
                i += 2 + digits
                continue
            if e not in _ESCAPES:
                raise YAMLError(f"unsupported escape \\{e}")
            out.append(_ESCAPES[e])
            i += 2
            continue
        out.append(c)
        i += 1
    raise YAMLError("unterminated double-quoted scalar")


def _scan_flow(text, pos):
    """text[pos] is '{' or '[': return (value, pos_after_closing_bracket)."""
    opener = text[pos]
    closer = "}" if opener == "{" else "]"
    n = len(text)
    i = pos + 1
    items = []  # (value,) for sequences; (key, value) pairs for mappings
    is_map = opener == "{"
    while True:
        while i < n and text[i] in " \t":
            i += 1
        if i >= n:
            raise YAMLError("unterminated flow collection")
        if text[i] == closer:
            i += 1
            break
        key = _flow_scalar(text, i)
        i = key[1]
        j = i
        while j < n and text[j] in " \t":
            j += 1
        if is_map:
            if j >= n or text[j] != ":":
                raise YAMLError("flow mapping entry without ':'")
            val, i = _flow_scalar(text, j + 1)
            items.append((key[0], val))
        else:
            items.append((key[0], None))
            i = j
        while i < n and text[i] in " \t":
            i += 1
        if i < n and text[i] == ",":
            i += 1
            continue
        if i < n and text[i] == closer:
            i += 1
            break
        raise YAMLError("flow collection: expected ',' or '%s'" % closer)
    if is_map:
        return dict(items), i
    return [v for v, _ in items], i


def _flow_scalar(text, pos):
    """Parse one flow-context scalar (or nested collection) at pos."""
    n = len(text)
    while pos < n and text[pos] in " \t":
        pos += 1
    if pos >= n:
        raise YAMLError("flow collection: missing value")
    c = text[pos]
    if c in "[{":
        return _scan_flow(text, pos)
    if c == "'":
        return _scan_single(text, pos)
    if c == '"':
        return _scan_double(text, pos)
    i = pos
    depth = 0
    while i < n:
        ch = text[i]
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and ch in ",:":
            if ch == "," or i + 1 >= n or text[i + 1] in " \t,[]{}":
                break
        elif depth == 0 and ch == "}" or depth == 0 and ch == "]":
            break
        i += 1
    return _resolve_plain(text[pos:i].strip()), i


def _split_key(text):
    """(key, rest, found) for a block-mapping line `key: value`."""
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if c in "'\"":
            val, i2 = (_scan_single if c == "'" else _scan_double)(text, i)
            j = i2
            while j < n and text[j] in " \t":
                j += 1
            if j < n and text[j] == ":" and (j + 1 >= n or text[j + 1] in " \t"):
                return val, text[j + 1:].lstrip(" \t"), True
            i = i2
            continue
        if c in "[{":
            _, i = _scan_flow(text, i)
            continue
        if c == ":" and (i + 1 >= n or text[i + 1] in " \t"):
            head = text[:i].strip()
            if head == "":
                raise YAMLError(f"value without a key: {text!r}")
            return _resolve_plain(head), text[i + 1:].lstrip(" \t"), True
        i += 1
    return None, None, False


class _Reader:
    def __init__(self, text):
        if isinstance(text, bytes):
            text = text.decode("utf-8")
        if not isinstance(text, str):
            raise YAMLError(f"expected a YAML string, got {type(text).__name__}")
        self.lines = text.split("\n")

    def next_content(self, i):
        while i < len(self.lines):
            if _skip(self.lines[i]):
                i += 1
                continue
            return i
        return i

    @staticmethod
    def indent(line):
        n = len(line) - len(line.lstrip(" "))
        if line[:n + 1][n:] == "\t" or "\t" in line[:n]:
            raise YAMLError(f"tab in indentation: {line!r}")
        return n

    def load(self, allow_marker=True):
        i = self.next_content(0)
        if i < len(self.lines) and allow_marker and self.lines[i].strip() == "---":
            i = self.next_content(i + 1)
        value, i = self.parse_block(i)
        j = self.next_content(i)
        if j < len(self.lines):
            raise YAMLError("expected a single document "
                            "(use safe_load_all to split on '---')")
        return value

    def parse_block(self, i, col=None):
        i = self.next_content(i)
        if i >= len(self.lines):
            return None, i
        line = self.lines[i]
        ind = self.indent(line)
        if col is None:
            col = ind
        if ind < col:
            return None, i
        st = line[ind:]
        if st == "-" or st.startswith("- "):
            return self.parse_sequence(i, col)
        return self.parse_mapping(i, col)

    def parse_sequence(self, i, col):
        items = []
        while True:
            i = self.next_content(i)
            if i >= len(self.lines):
                break
            line = self.lines[i]
            ind = self.indent(line)
            if ind < col:
                break
            if ind > col:
                raise YAMLError(f"unexpected indent in sequence: {line!r}")
            st = line[col:]
            if not (st == "-" or st.startswith("- ")):
                break
            start = i
            rest = st[1:]
            if rest and not rest.startswith((" ", "\t")):
                raise YAMLError(f"malformed sequence entry: {line!r}")
            stripped = rest.strip()
            if not stripped or stripped.startswith("#"):
                # bare dash: the item is the deeper block below, or null
                j = self.next_content(i + 1)
                if j < len(self.lines) and self.indent(self.lines[j]) > col:
                    sub, i = self.parse_block(j, self.indent(self.lines[j]))
                else:
                    sub, i = None, i + 1
                items.append(sub)
            else:
                vcol = col + 1 + (len(rest) - len(rest.lstrip(" \t")))
                if stripped[0] in "[{":
                    sub, i = self.parse_inline(stripped, col, i)
                elif stripped[0] in "'\"":
                    _q, after = (_scan_single if stripped[0] == "'"
                                 else _scan_double)(stripped, 0)
                    tail = stripped[after:].lstrip(" \t")
                    if tail.startswith(":"):
                        sub, i = self.parse_mapping(i, vcol, first_text=stripped)
                    else:
                        sub, i = self.parse_inline(stripped, col, i)
                else:
                    _k, _r, found = _split_key(stripped)
                    if found:
                        sub, i = self.parse_mapping(i, vcol, first_text=stripped)
                    else:
                        sub, i = self.parse_inline(stripped, col, i)
                items.append(sub)
            if i <= start:
                raise YAMLError(f"parser made no progress at: {line!r}")
        return items, i

    def parse_mapping(self, i, col, first_text=None):
        out = {}
        first = True
        while True:
            i = self.next_content(i)
            if i >= len(self.lines):
                break
            line = self.lines[i]
            ind = self.indent(line)
            start = i
            if first and first_text is not None:
                # compact `- key: value` item: the physical line starts with the
                # dash at a SMALLER column than `col`; its text is the entry
                first = False
                st = first_text
            else:
                first = False
                if ind < col:
                    break
                st = line[col:]
                if st == "-" or st.startswith("- "):
                    break
                if ind > col:
                    raise YAMLError(f"unexpected indent in mapping: {line!r}")
            key, rest, found = _split_key(st)
            if not found:
                raise YAMLError(f"expected 'key: value': {line!r}")
            if rest == "" or rest.startswith("#"):
                j = self.next_content(i + 1)
                if j < len(self.lines):
                    nind = self.indent(self.lines[j])
                    nst = self.lines[j][nind:]
                    if nind > col:
                        out[key], i = self.parse_block(j, nind)
                        if i <= j:
                            raise YAMLError(f"parser made no progress at: {line!r}")
                        continue
                    if nind == col and (nst == "-" or nst.startswith("- ")):
                        out[key], i = self.parse_sequence(j, col)
                        if i <= j:
                            raise YAMLError(f"parser made no progress at: {line!r}")
                        continue
                out[key] = None
                i += 1
                continue
            out[key], i = self.parse_inline(rest, col, i, raw_line=st)
            if i <= start:
                raise YAMLError(f"parser made no progress at: {line!r}")
        return out, i

    def parse_inline(self, rest, col, i, raw_line=None):
        """Value that starts on line i (block-scalar bodies consume following lines)."""
        if rest.startswith("|") or rest.startswith(">"):
            return self.parse_block_scalar(rest, col, i)
        if rest[0] in "[{":
            val, after = _scan_flow(rest, 0)
            tail = rest[after:].strip()
            if tail and not tail.startswith("#"):
                raise YAMLError(f"trailing content after flow value: {rest!r}")
            return val, i + 1
        if rest[0] == "'":
            val, after = _scan_single(rest, 0)
            tail = rest[after:].strip()
            if tail and not tail.startswith("#"):
                if ":" in tail:
                    raise YAMLError(f"mapping value after quoted scalar: {rest!r}")
                raise YAMLError(f"trailing content after quoted scalar: {rest!r}")
            return val, i + 1
        if rest[0] == '"':
            val, after = _scan_double(rest, 0)
            tail = rest[after:].strip()
            if tail and not tail.startswith("#"):
                raise YAMLError(f"trailing content after quoted scalar: {rest!r}")
            return val, i + 1
        # plain scalar: single line; a ': ' inside it is PyYAML's "mapping values
        # are not allowed here" — the emitter's doc_plain_ok guarantees never.
        cut = rest
        k = _plain_comment_cut(cut)
        comment, body = cut[k:].strip(), cut[:k].rstrip()
        if comment and not comment.startswith("#"):
            raise YAMLError(f"corrupt plain scalar: {rest!r}")
        if ": " in body or body.endswith(":"):
            raise YAMLError(f"mapping values are not allowed here: {rest!r}")
        return _resolve_plain(body), i + 1

    def parse_block_scalar(self, header, col, i):
        style = header[0]
        h = header[1:].split("#")[0].strip()
        chomp = "clip"
        explicit = None
        for ch in h:
            if ch == "-":
                chomp = "strip"
            elif ch == "+":
                chomp = "keep"
            elif ch.isdigit():
                explicit = int(ch)
            else:
                raise YAMLError(f"unsupported block scalar header: {header!r}")
        j = i + 1
        while j < len(self.lines) and self.lines[j].strip() == "":
            j += 1
        if j >= len(self.lines):
            return _finish_scalar("", style, chomp, header), i + 1
        ind = self.indent(self.lines[j])
        if ind <= col:
            return _finish_scalar("", style, chomp, header), i + 1
        ci = explicit + col if explicit else ind
        body = []
        while j < len(self.lines):
            line = self.lines[j]
            if line.strip() == "":
                body.append("")
                j += 1
                continue
            if self.indent(line) < ci:
                if self.indent(line) > col:
                    raise YAMLError(f"inconsistent block scalar indent: {line!r}")
                break
            body.append(line[ci:])
            j += 1
        while body and body[-1] == "":
            body.pop()
        return _finish_scalar(_join_scalar(body, style), style, chomp, header), j


def _plain_comment_cut(s):
    """Index where a trailing ' #' comment starts in a plain scalar, or len(s)."""
    idx = s.find(" #")
    return len(s) if idx < 0 else idx + 1


def _join_scalar(body, style):
    if style == "|":
        return "\n".join(body)
    out = []
    for k, ln in enumerate(body):
        if ln == "":
            out.append("\n")
            continue
        if out and not out[-1].endswith(("\n", " ")) and not ln.startswith(" "):
            out.append(" ")
        out.append(ln)
    return "".join(out)


def _finish_scalar(text, style, chomp, header):
    if chomp == "keep":
        return text + "\n" if text else text
    if chomp == "strip":
        return text
    return text + "\n" if text else ""


def safe_load(text):
    return _Reader(text).load()


_DOC_SPLIT = re.compile(r"(?m)^---[ \t]*$")


def safe_load_all(text):
    if isinstance(text, bytes):
        text = text.decode("utf-8")
    parts = _DOC_SPLIT.split(text)
    return [_Reader(p).load(allow_marker=False) for p in parts if not _all_skip(p)]


def _all_skip(p):
    return all(_skip(ln) for ln in p.split("\n"))


_PLAIN_SAFE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9 ._@+/*'\"()$<>=;,!\u00a1-\uffff-]*$")


def _plain_ok(s):
    return bool(s) and s == s.strip() and "\n" not in s and "\t" not in s \
        and ": " not in s and " #" not in s and not s.endswith(":") \
        and _PLAIN_SAFE.match(s) and s not in _NULL and s not in _TRUE \
        and s not in _FALSE and not _INT_RX.match(s) \
        and not _FLOAT_RX.match(s)


def _scalar(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, str):
        return v if _plain_ok(v) else json.dumps(v)
    raise YAMLError(f"cannot emit {type(v).__name__} as a YAML scalar")


def _key(k):
    k = k if isinstance(k, str) else json.dumps(k)
    return k if _plain_ok(k) else json.dumps(k)


def _emit(value, col, out, indent, sort_keys):
    pad = " " * col
    if isinstance(value, dict):
        if not value:
            out.append(pad + "{}\n")
            return
        items = sorted(value.items(), key=lambda kv: str(kv[0])) if sort_keys \
            else list(value.items())
        for k, v in items:
            if isinstance(v, (dict, list)) and v:
                out.append(f"{pad}{_key(k)}:\n")
                _emit(v, col + indent, out, indent, sort_keys)
            elif isinstance(v, dict):
                out.append(f"{pad}{_key(k)}: {{}}\n")
            elif isinstance(v, list):
                out.append(f"{pad}{_key(k)}: []\n")
            else:
                out.append(f"{pad}{_key(k)}: {_scalar(v)}\n")
        return
    if isinstance(value, list):
        if not value:
            out.append(pad + "[]\n")
            return
        for item in value:
            if isinstance(item, (dict, list)) and item:
                out.append(pad + "-\n")
                _emit(item, col + indent, out, indent, sort_keys)
            elif isinstance(item, dict):
                out.append(pad + "- {}\n")
            elif isinstance(item, list):
                out.append(pad + "- []\n")
            else:
                out.append(f"{pad}- {_scalar(item)}\n")
        return
    out.append(pad + _scalar(value) + "\n")


def safe_dump(value, indent=4, sort_keys=True, **_ignored):
    if not isinstance(indent, int) or not 1 <= indent <= 10:
        raise YAMLError(f"unsupported indent {indent!r}")
    out = []
    if isinstance(value, (dict, list)) and not value:
        out.append("{}\n" if isinstance(value, dict) else "[]\n")
    else:
        _emit(value, 0, out, indent, sort_keys)
    return "".join(out)


dump = safe_dump
