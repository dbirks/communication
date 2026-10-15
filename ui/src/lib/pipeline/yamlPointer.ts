/**
 * JSON pointer → YAML line, for the read-only viewer.
 *
 * A validation finding from § 2.2 carries `instance_location` as a JSON
 * pointer into the *document*; the viewer's job is to put a marker on the line
 * that pointer names, and to say honestly when it cannot.
 *
 * This is a *reader*, not a YAML parser: it understands block mappings, block
 * sequences, block scalars (`|`, `>`) and flow values it deliberately refuses
 * to descend into. That is enough for the canonical serialized document (the
 * server emits block style with two-space indents, contract § 2 route 14) and
 * for the hand-written documents a draft carries. Anything it cannot resolve
 * exactly resolves to its closest recorded ancestor with `exact: false`, and
 * the component says so in words — a marker that silently lands on the wrong
 * line is worse than no marker.
 */

export interface PointerLocation {
  /** 1-based line number. */
  line: number;
  /** True when the whole pointer resolved; false when an ancestor did. */
  exact: boolean;
  /** The pointer actually resolved. */
  resolved: string;
}

interface Line {
  indent: number;
  content: string;
  number: number;
}

const BLOCK_SCALAR = /^[|>][+-]?\d*\s*(#.*)?$/;

/** Structural lines only: blanks, comments and block-scalar bodies are dropped. */
function scan(text: string): Line[] {
  const raw = text.split(/\r?\n/);
  const out: Line[] = [];
  let skipIndent: number | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (skipIndent !== null) {
      if (trimmed === "" || indent > skipIndent) continue;
      skipIndent = null;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    out.push({ indent, content: trimmed, number: index + 1 });

    const value = trimmed.replace(/^[^:]+:\s*/, "");
    if (BLOCK_SCALAR.test(value)) skipIndent = indent;
  }
  return out;
}

/** RFC 6901 unescape. */
function decodeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function encodeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** `key: value` split on a plain or quoted mapping key. */
function mappingKey(content: string): { key: string; rest: string } | null {
  const quoted = /^("[^"]*"|'[^']*')\s*:\s*(.*)$/.exec(content);
  if (quoted) return { key: quoted[1].slice(1, -1), rest: quoted[2] };
  const plain = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(content);
  if (!plain) return null;
  // `a: b: c` is not a mapping; refuse rather than guess.
  if (plain[1].includes(": ")) return null;
  return { key: plain[1], rest: plain[2] };
}

function isFlow(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

/**
 * Every resolvable pointer in the document, mapped to its line.
 * `exact: false` entries are the ones a flow value swallowed.
 */
export function indexPointers(text: string): Map<string, PointerLocation> {
  const lines = scan(text);
  const map = new Map<string, PointerLocation>();
  let pos = 0;

  const record = (pointer: string, line: number, exact: boolean) => {
    if (!map.has(pointer)) map.set(pointer, { line, exact, resolved: pointer });
  };

  const parseBlock = (indent: number, base: string) => {
    if (pos >= lines.length) return;
    if (lines[pos].content.startsWith("- ")) parseSequence(indent, base);
    else if (lines[pos].content === "-") parseSequence(indent, base);
    else parseMapping(indent, base);
  };

  const parseMapping = (indent: number, base: string) => {
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) return;
      if (line.indent > indent) {
        pos += 1;
        continue;
      }
      const parsed = mappingKey(line.content);
      if (!parsed) {
        pos += 1;
        continue;
      }
      const pointer = `${base}/${encodeToken(parsed.key)}`;
      const value = parsed.rest.replace(/\s+#.*$/, "");
      record(pointer, line.number, true);
      pos += 1;
      if (value === "" || BLOCK_SCALAR.test(value)) {
        const next = lines[pos];
        if (!next) continue;
        if (next.indent > line.indent) parseBlock(next.indent, pointer);
        else if (next.indent === line.indent && next.content.startsWith("-"))
          parseSequence(next.indent, pointer);
      } else if (isFlow(value)) {
        // Flow content is recorded at its own line but never descended into:
        // a marker for a pointer inside it resolves to this line, inexact.
        descendFlow(pointer, map, line.number, value);
      }
    }
  };

  const parseSequence = (indent: number, base: string) => {
    let index = 0;
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent !== indent || !line.content.startsWith("-")) return;
      const pointer = `${base}/${index}`;
      record(pointer, line.number, true);
      const after = line.content.slice(1);
      const rest = after.trim();
      // The item's own keys start where its first character does, which is the
      // dash's indent plus the dash and its spaces — the block style the
      // server's canonical serializer emits (`- id: plan`, then `  kind: …`).
      const contentIndent = line.indent + 1 + (after.length - after.trimStart().length);
      if (rest === "") {
        pos += 1;
        const next = lines[pos];
        if (next && next.indent > line.indent) parseBlock(next.indent, pointer);
      } else if (mappingKey(rest) && !isFlow(rest)) {
        // Rewrite the dash line as the item's first mapping key and parse the
        // item from there; the record above already gave the item its own line.
        lines[pos] = { indent: contentIndent, content: rest, number: line.number };
        parseMapping(contentIndent, pointer);
      } else {
        pos += 1;
        if (isFlow(rest)) descendFlow(pointer, map, line.number, rest);
      }
      index += 1;
    }
  };

  if (lines.length > 0) parseBlock(lines[0].indent, "");
  return map;
}

/** Record the keys of an inline `{...}` mapping so lookups land on its line. */
function descendFlow(
  pointer: string,
  map: Map<string, PointerLocation>,
  line: number,
  value: string,
): void {
  if (!value.startsWith("{")) return;
  const inner = value.replace(/^\{/, "").replace(/\}\s*$/, "");
  for (const part of inner.split(",")) {
    const parsed = mappingKey(part.trim());
    if (!parsed) continue;
    map.set(`${pointer}/${encodeToken(parsed.key)}`, {
      line,
      exact: false,
      resolved: pointer,
    });
  }
}

/**
 * Resolve `pointer` (e.g. `/spec/nodes/2/config/passWhen`) against `text`.
 * Falls back to the longest recorded ancestor prefix.
 */
export function resolvePointer(text: string, pointer: string | null): PointerLocation | null {
  if (!pointer || !pointer.startsWith("/")) return null;
  const map = indexPointers(text);
  const tokens = pointer.split("/").slice(1).map(decodeToken);
  let built = "";
  let best: PointerLocation | null = null;
  for (const token of tokens) {
    built = `${built}/${encodeToken(token)}`;
    const hit = map.get(built);
    if (!hit) {
      // The pointer runs past what the reader could resolve — an index below a
      // flow value, or a location the document does not carry. The closest
      // recorded ancestor's line is shown with that fact in words, because a
      // marker that lands on the wrong line silently misdirects the reader.
      return best ? { ...best, exact: false } : null;
    }
    best = hit;
  }
  return best;
}

/** A stable digest of a document's own text, for the viewer's label. */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return "—";
  return digest.startsWith("sha256:") ? digest.slice(7, 19) : digest.slice(0, 12);
}
