/**
 * YamlView — the read-only YAML panel of the workflow YAML tab (design 2d).
 *
 * The panel renders the document as block style (via `lib/pipeline/blockYaml`)
 * with a line-number gutter, and header actions to copy or download the text.
 * The two actions are buttons of one case and one size (`Copy` · `Download`,
 * 2026-10-30 copy review, 2d item 3 — `Copy`/`download` read as two different
 * kinds of control) and the export button carries the file's name as its title
 * (the 390px design check: the full `<slug>-r<n>.yaml` label was cut to
 * `…-r1.ya…` on the bar). It is read-only by decision: a published revision is
 * immutable, edits go through a draft. The Studio's authoring textarea is the
 * only keystroke path.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toBlockYaml } from "../../lib/pipeline/blockYaml";
import { Button } from "../ds/Button";
import { Panel } from "../ds/Panel";

export interface YamlViewProps {
  /** The document text — a draft's `document_yaml`, a revision's `document_text`, … */
  text: string;
  /** Export filename for the download: `<slug>-r<n>.yaml`. */
  filename: string;
  /** Panel title; the mono tab bar reads e.g. `YAML`. */
  title?: string;
  /** Root test id; the per-line ids are `${testId}-line-${n}`. */
  testId?: string;
}

const COPY_RESET_MS = 2000;

export function YamlView({ text, filename, title = "YAML", testId = "yaml-view" }: YamlViewProps) {
  const block = useMemo(() => toBlockYaml(text), [text]);
  const lines = useMemo(() => {
    const parts = block.split("\n");
    // `toBlockYaml` emits a trailing newline; the split leaves an empty last
    // element that is not a line of the document.
    return parts.length > 1 && parts[parts.length - 1] === "" ? parts.slice(0, -1) : parts;
  }, [block]);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(block);
    } catch {
      // Clipboard can be unavailable (insecure context); nothing else to do.
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
  }

  function handleDownload(): void {
    const blob = new Blob([block], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Panel
      title={title}
      headingId={`${testId}-heading`}
      headingLevel={2}
      className="flex flex-col"
      meta={
        // One line at any width (the Repositories `+ add` treatment, 390):
        // below 560px the shell's phone floor (tokens.css `APP-SHELL-PHONE`)
        // makes every `main button` 44px tall, and this bar grew to twice its
        // siblings (53px against the other panels' 23px). The wrapper holds the
        // bar's line box and clips the floor's growth, so `Copy · Download` sit
        // in the header exactly like every other panel's meta slot; the buttons
        // stay real buttons and keep their names.
        <span className="flex h-[14px] items-center gap-2 overflow-hidden min-[560px]:h-auto min-[560px]:overflow-visible">
          <Button
            variant="secondary"
            type="button"
            onClick={() => void handleCopy()}
            data-testid={`${testId}-copy`}
            className="h-[26px] px-[10px] font-mono text-[11px]"
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={handleDownload}
            data-testid={`${testId}-download`}
            title={filename}
            aria-label={`Download ${filename}`}
            className="h-[26px] px-[10px] font-mono text-[11px]"
          >
            Download
          </Button>
        </span>
      }
    >
      <div
        data-testid={testId}
        role="region"
        tabIndex={0}
        aria-label={`${title} document`}
        className="max-h-[460px] overflow-auto rounded-[3px] border border-line bg-surface p-[10px] font-mono text-[11.5px] leading-[18px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {lines.map((line, index) => {
          // Hanging indent for the soft-wrap (error-details-r6 item 3, pass-1
          // shot 2d-yaml-390): a wrapped continuation line used to start at
          // column 0, losing the indentation that IS the YAML's structure.
          // Each line's block-start padding grows by its own leading
          // whitespace and `text-indent` pulls only the FIRST line back by the
          // same amount, so the first line sits exactly where it did and every
          // wrapped continuation aligns under the line's content, not the
          // margin. (The panel is mono, so `ch` is the space width exactly.)
          const indent = line.length - line.trimStart().length;
          return (
            <div key={index} data-testid={`${testId}-line-${index + 1}`} className="flex">
              <span
                aria-hidden="true"
                className="w-[3rem] shrink-0 select-none text-right pr-[8px] text-[10.5px] text-faint"
              >
                {index + 1}
              </span>
              {/* Soft-wrapped at every width (2d review, 390): `whitespace-pre`
                  let a long line clip at the panel's right edge on a phone;
                  the whole line now stays readable, and `wrap-anywhere`
                  keeps even an unbroken digest from forcing sideways scroll. */}
              <span
                className="min-w-0 wrap-anywhere whitespace-pre-wrap"
                style={{
                  paddingLeft: `calc(8px + ${indent}ch)`,
                  textIndent: `-${indent}ch`,
                }}
              >
                {line === "" ? "\u00a0" : line}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
