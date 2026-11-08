/**
 * Full-size evidence rendering, shared by the piece-of-work page (design 8b)
 * and the tour player (7b). A stop's evidence is model output with a server
 * stamped `type`; nothing here follows a url this layer cannot vouch for
 * beyond rendering an `<img>` the API itself supplied, and nothing is ever
 * injected as HTML.
 *
 * - `log` — the dark block: `--color-ink` ground, `--color-line` mono text,
 *   a `--color-ink-2` header strip carrying the excerpt's label.
 * - `diff` — `+` lines on the done-pale tint, `−` lines on the failed-pale
 *   tint (state tokens; colour never alone — the sign glyph stays visible).
 * - `files` — a plain mono list.
 * - `screenshot` — before/after images when the payload carries urls, else
 *   the honest "No screenshot was captured."
 */
import type { CatchUpEvidence } from "../../api/catchup";

function headLine(evidence: CatchUpEvidence): string | null {
  for (const key of ["path", "file", "header", "label"] as const) {
    const value = evidence[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function textPayload(evidence: CatchUpEvidence): string | null {
  for (const key of ["text", "excerpt", "log", "patch", "hunk", "content", "body"] as const) {
    const value = evidence[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function listPayload(evidence: CatchUpEvidence): string[] | null {
  for (const key of ["files", "paths", "list"] as const) {
    const value = evidence[key];
    if (Array.isArray(value)) {
      const lines = value
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : entry &&
                typeof entry === "object" &&
                "path" in entry &&
                typeof entry.path === "string"
              ? entry.path
              : null,
        )
        .filter((line): line is string => line != null && line.length > 0);
      if (lines.length > 0) return lines;
    }
  }
  return null;
}

function urlString(evidence: CatchUpEvidence, key: string): string | null {
  const value = evidence[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const FRAME = "h-full overflow-hidden rounded-panel border border-line-strong";

function LogBlock({ evidence }: { evidence: CatchUpEvidence }) {
  const head = headLine(evidence);
  return (
    <div
      className={`${FRAME} bg-ink font-mono text-[11px]/[1.55] break-words whitespace-pre-wrap text-line`}
    >
      {head ? (
        <div className="border-b border-ink-2 bg-ink-2 px-[10px] py-[3px] font-mono text-[9.5px] font-semibold tracking-[.04em] text-line">
          {head}
        </div>
      ) : null}
      <div className="px-[10px] py-[6px]">{textPayload(evidence) ?? ""}</div>
    </div>
  );
}

function DiffBlock({ evidence }: { evidence: CatchUpEvidence }) {
  const head = headLine(evidence);
  const lines = (textPayload(evidence) ?? "").split("\n");
  return (
    <div className={`${FRAME} bg-surface font-mono text-[11px]/[1.55]`}>
      {head ? (
        <div className="border-b border-line bg-fill px-[10px] py-[3px] text-[9.5px] font-semibold tracking-[.04em] text-ink-2">
          {head}
        </div>
      ) : null}
      {lines.map((line, index) => {
        const added = line.startsWith("+");
        const removed = line.startsWith("-");
        return (
          <div
            key={index}
            className={`grid grid-cols-[16px_minmax(0,1fr)] px-[10px] ${
              added ? "bg-st-done-pale-body" : removed ? "bg-st-failed-pale-body" : ""
            }`}
          >
            <span
              className={
                added ? "text-st-done-tag-fg" : removed ? "text-st-failed-tag-fg" : "text-faint"
              }
            >
              {added || removed ? line[0] : ""}
            </span>
            <span className="break-words whitespace-pre-wrap text-ink">
              {added || removed ? line.slice(1) : line}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FilesBlock({ evidence }: { evidence: CatchUpEvidence }) {
  const head = headLine(evidence);
  const lines = listPayload(evidence) ?? (textPayload(evidence) ?? "").split("\n").filter(Boolean);
  return (
    <div className={`${FRAME} bg-surface font-mono text-[11px]/[1.6]`}>
      {head ? (
        <div className="border-b border-line bg-fill px-[10px] py-[3px] text-[9.5px] font-semibold tracking-[.04em] text-ink-2">
          {head}
        </div>
      ) : null}
      {lines.map((line, index) => (
        <div key={index} className="px-[10px] break-words whitespace-pre-wrap text-ink-2">
          {line}
        </div>
      ))}
    </div>
  );
}

function ScreenshotBlock({ evidence }: { evidence: CatchUpEvidence }) {
  const before = urlString(evidence, "before_url") ?? urlString(evidence, "before");
  const after = urlString(evidence, "after_url") ?? urlString(evidence, "after");
  const single = urlString(evidence, "url") ?? urlString(evidence, "image_url");
  const head = headLine(evidence);
  if (!before && !after && !single) {
    // The honest empty: the model referenced a screenshot this build cannot
    // show. We never invent one and never follow an unlabelled url.
    return (
      <div
        data-testid="catchup-evidence-no-screenshot"
        className={`${FRAME} grid place-items-center bg-st-queued-pale-body px-[10px] py-[16px] text-center font-mono text-[10.5px] text-muted`}
      >
        No screenshot was captured.
      </div>
    );
  }
  const images =
    before || after
      ? [
          { src: before, alt: "Before" },
          { src: after, alt: "After" },
        ]
      : [{ src: single, alt: head ?? "Screenshot" }];
  return (
    <div className={`${FRAME} bg-surface`}>
      {head ? (
        <div className="border-b border-line bg-fill px-[10px] py-[3px] font-mono text-[9.5px] font-semibold tracking-[.04em] text-ink-2">
          {head}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-[8px] p-[8px]">
        {images.map((image, index) =>
          image.src ? (
            <figure key={index} className="flex min-w-0 flex-col gap-[4px]">
              {images.length > 1 ? (
                <figcaption className="font-mono text-[9.5px] font-semibold tracking-[.04em] text-muted uppercase">
                  {image.alt}
                </figcaption>
              ) : null}
              <img
                src={image.src}
                alt={image.alt}
                className="max-h-[280px] max-w-full rounded-panel border border-line object-contain"
              />
            </figure>
          ) : null,
        )}
      </div>
    </div>
  );
}

export function Evidence({
  evidence,
  className = "",
}: {
  evidence: CatchUpEvidence;
  /** Height/border the caller's layout owns (the cards fix 124px, the piece
   * page lets blocks size themselves). */
  className?: string;
}) {
  const wrap = className || "h-full";
  if (evidence.type === "log")
    return (
      <div className={wrap}>
        <LogBlock evidence={evidence} />
      </div>
    );
  if (evidence.type === "diff")
    return (
      <div className={className || "h-full"}>
        <DiffBlock evidence={evidence} />
      </div>
    );
  if (evidence.type === "files")
    return (
      <div className={className || "h-full"}>
        <FilesBlock evidence={evidence} />
      </div>
    );
  if (evidence.type === "screenshot")
    return (
      <div className={className || "h-full"}>
        <ScreenshotBlock evidence={evidence} />
      </div>
    );
  // Unknown type — never render model payload we cannot draw.
  return (
    <div
      className={`${className || "h-full"} ${FRAME} grid place-items-center border-dashed bg-st-queued-pale-body font-mono text-[10px] text-muted`}
    >
      {headLine(evidence) ?? evidence.type}
    </div>
  );
}

/** The card-sized empty frame (no evidence at all) the tour cards draw. */
export function EvidenceFrame() {
  return (
    <div className="h-full rounded-panel border border-dashed border-line-strong" aria-hidden />
  );
}
