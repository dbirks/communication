// The `emu` fixture: the "play the user" recorder (e2e/emulator/README.md).
//
// For every page of a journey it
//   - records `pageerror` events and `console.error` messages (kind
//     pageerror / console),
//   - records every /api/ response with status >= 400 and every
//     `requestfailed` (kind api) — EXCEPT the ones the journey declared
//     expected through `emu.expectFailure(/regex/, status?)`,
//   - `emu.screen(badge, name)`: at the current page, for the desktop
//     (1280×900) AND the phone (390×844) viewport, waits for the page to
//     settle, asserts no sideways scroll (a violation is RECORDED, not
//     thrown — the screenshot still proves the screen), takes a full-page
//     screenshot into e2e/emulator/out/<passId>/ and records the screen
//     with its design render (docs/design/handoff-*/png/<badge>.png — the
//     repo-chat-nav renders are namespaced: badge `rcn-3a` is that handoff's
//     png/3a.png, see env.ts `EMU_DESIGN_DIRS`).
//     At 390 it additionally runs the reflow checks (reflow.ts): content
//     parity with the 1280 inventory, no clipped text without an ellipsis,
//     and touch targets ≥ 44px — every violation is likewise RECORDED. At
//     BOTH widths it runs the overlap check (`findOverlaps`): leaf text and
//     controls whose boxes paint over one another by more than 4px on both
//     axes is a defect on the desk as much as on the phone. At BOTH widths it
//     also asserts the screen's DESIGN LANDMARKS (design.ts): the headings,
//     tabs, buttons, sections and fields its design render draws, matched by
//     testid, by role+name or by design-owned copy — structure, never data. At
//     BOTH widths it also runs the NO-MADE-UP-DATA check (mockdata.ts): none
//     of the design mock's invented people, repo/workflow names, issue titles,
//     ids or amounts may appear in the page's visible text (kind
//     made-up-data). A
//     badge with a design render and no landmark entry is itself a defect
//     (coverage cannot lapse silently); a badge with no design render
//     (`run-gate`, `artifact`) is exempt.
//
// At each test's end the fixture appends one JSON line per screen and per
// defect to out/<passId>/results.json. A journey that FAILS records a
// kind=assertion defect (the failure is a real defect, not a harness
// failure), so a red journey still lands in the report and the issue filer.
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { test as base } from "@playwright/test";
import type { APIResponse, Page } from "@playwright/test";
import { EMU_DESIGN_DIRS, EMU_OUT_DIR, EMU_PASS_ID } from "./env.js";
import { scrollToTopForCapture } from "../tests/helpers.js";
import {
  collectReflowItems,
  collectStateFingerprint,
  findClippedText,
  findOverlaps,
  findSmallTargets,
  judgeParityPair,
  missingParityItems,
  type EmuChecks,
  type ParityCapture,
  type ReflowItem,
} from "./reflow.js";
import { landmarksFor, missingLandmarks, type Landmark } from "./design.js";
import { findMockTexts, MOCK_DATA_TEXTS, sourcesFor } from "./mockdata.js";

/** A defect kind, as reported in results.json and the issue title. */
export type EmuDefectKind =
  | "pageerror"
  | "console"
  | "api"
  | "sidescroll"
  | "assertion"
  | "reflow"
  | "clip"
  | "target"
  | "overlap"
  | "design"
  | "made-up-data";

export interface EmuDefect {
  kind: EmuDefectKind;
  journey: string;
  screen: string;
  viewport: string;
  detail: string;
  fingerprint: string;
  screenshot: string | null;
}

export interface EmuScreen {
  badge: string;
  name: string;
  width: number;
  /** The page URL the screen was taken on. */
  url: string;
  /** The screenshot path, relative to the pass output directory. */
  shot: string;
  /** The design render (absolute), if the badge has one. */
  designPng: string | null;
  /** The design render, relative to the pass output directory (for HTML). */
  designRel: string | null;
  /** Per-width check outcomes (true = pass); see reflow.ts, design.ts and
   * mockdata.ts. */
  checks: EmuScreenChecks;
}

/** reflow.ts's per-width checks, plus this screen's design landmarks and the
 * no-made-up-data check (mockdata.ts). */
export interface EmuScreenChecks extends EmuChecks {
  design: boolean;
  /** False when a MOCK_DATA string appears in the page's visible text — the
   * mock's sample data, which the app must never show. */
  data: boolean;
}

/** The recording handle the fixture hands to a journey. */
export interface Emu {
  /**
   * Declare an expected failure: /api/ responses or requestfailed events
   * whose URL matches `re` (and, if `status` is given, with exactly that
   * status) are not defects — the journey is deliberately exercising an
   * inline 409/422 or similar.
   */
  expectFailure(re: RegExp, status?: number): void;
  /** See the header comment: settle the page, sidescroll check, screenshot. */
  screen(badge: string, name: string): Promise<void>;
}

/**
 * A journey's authenticated API mutation through the page's own session.
 * The lab guards mutations with the double-submit CSRF header, and the
 * token is handed out by `GET /api/v1/me` — the same way the web client
 * bootstraps it. Returns the raw response; the journey asserts the status.
 */
export async function apiMutate(
  page: Page,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  data?: unknown,
): Promise<APIResponse> {
  const me = await page.request.fetch(new URL("/api/v1/me", url).toString());
  const token = ((await me.json().catch(() => ({}))) as { csrf_token?: string }).csrf_token ?? "";
  return page.request.fetch(url, {
    method,
    data: data as never,
    headers: { "x-csrf-token": token },
  });
}

const resultsFile = path.join(EMU_OUT_DIR, "results.json");

/**
 * The stable defect fingerprint: a hash of kind + journey + screen +
 * normalised detail, where normalisation strips the values that change
 * between passes (uuids, hex digests, numbers, hosts/ports) so that the
 * same defect on the same screen files ONE issue across passes.
 */
export function fingerprintOf(
  kind: EmuDefectKind,
  journey: string,
  screen: string,
  detail: string,
): string {
  const normalised = detail
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/0x[0-9a-f]{6,}/g, "<hex>")
    .replace(/localhost:\d+/g, "<host>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>");
  return createHash("sha256")
    .update(`${kind}|${journey}|${screen}|${normalised}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The badge's design render (absolute path) or null.
 *
 * Directories are namespaced (env.ts `EMU_DESIGN_DIRS`): a badge only matches
 * a directory when it carries that directory's prefix (`rcn-3a` →
 * handoff-repo-chat-nav/png/3a.png), and the prefix-less directories answer
 * the bare badges the older journeys always used.
 */
export function designPngFor(badge: string): string | null {
  for (const { dir, prefix } of EMU_DESIGN_DIRS) {
    if (prefix !== "" && !badge.startsWith(prefix)) continue;
    const name = prefix !== "" ? badge.slice(prefix.length) : badge;
    if (name === "") continue;
    const candidate = path.join(dir, `${name}.png`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The persisted half of a capture: the screen record WITHOUT the parity
 * working data — the inventory and the state fingerprint stay in memory
 * (results.json keeps the shape it has always had). */
function screenRecord(capture: EmuScreen & ParityCapture): EmuScreen {
  const record: EmuScreen & Partial<ParityCapture> = { ...capture };
  delete record.items;
  delete record.stateFingerprint;
  return record;
}

const MAX_DETAIL = 500;

/**
 * A `net::ERR_ABORTED` on a journal feed (SSE `EventSource` or a
 * `text/event-stream` fetch) is the BROWSER cancelling an already-open
 * subscription — the only ways such a request end in `ERR_ABORTED` are
 * client-side teardowns: the page navigating away or closing, and the app
 * replacing a socket (React Query/StrictMode remounts, the hook's own
 * reconnect ladder, an org-stream consumer unmounting on a route change).
 * None of those says anything about the API. A real break on `/api/v1/events`
 * still counts through the other doors: an error STATUS is recorded by the
 * `response` handler (4xx/5xx are statuses, not aborts), and a dead server
 * mid-stream fails with its own net error (`ERR_CONNECTION_RESET`,
 * `ERR_EMPTY_RESPONSE`, …), never `ERR_ABORTED`.
 *
 * The first cut of this filter (ABORT_NAV_GRACE_MS) tried to drop only the
 * aborts within a second of a `framenavigated`, and leaked: the app keeps
 * more than one consumer of the org stream (the sidebar's flag hook and the
 * page-level reads both call `useOrgEvents`), and a route change that
 * unmounts one of them closes its socket ~0.5–2s AFTER the navigation —
 * outside any grace window, dozens of times per pass (issues #103–#128,
 * acceptance run 41423602047: 20+ filed defects, every one of them
 * `GET /api/v1/events failed: net::ERR_ABORTED`).
 */
export function isBenignStreamAbort(input: {
  errorText: string;
  resourceType: string;
  accept: string;
  url: string;
}): boolean {
  return input.errorText.trim() === "net::ERR_ABORTED" && isEventStreamRequest(input);
}

/**
 * The request is one of the app's journal feeds (SSE or a fetch reading a
 * `text/event-stream` body). The path test is deliberately suffix-strict:
 * `/api/v1/events`, `/api/v1/projects/{id}/events`,
 * `/api/v1/conversations/{id}/events`, `/api/v1/runs/{id}/events`, … — an
 * abort on any OTHER endpoint is a real failed request and still files.
 */
function isEventStreamRequest(request: {
  resourceType: string;
  accept: string;
  url: string;
}): boolean {
  if (request.resourceType === "eventsource") return true;
  if ((request.accept ?? "").toLowerCase().includes("text/event-stream")) return true;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  return pathname.endsWith("/events") || pathname.endsWith("/stream");
}

class EmuRecorder {
  private screens: EmuScreen[] = [];
  private defects: EmuDefect[] = [];
  private expected: { re: RegExp; status?: number }[] = [];
  private currentScreen = "(before first screen)";
  private lastShot: string | null = null;
  private currentViewport = "";
  /** What a check chose NOT to file (an event-stream abort explained by a
   * subscription teardown, or a parity pair skipped for state drift). Never
   * a defect, never silent: finish() writes these to results.json as
   * `type: "note"` and note() echoes them to the pass log. */
  private notes: { screen: string; detail: string }[] = [];
  private isExpected(urlPath: string, status?: number): boolean {
    return this.expected.some(
      (entry) =>
        entry.re.test(urlPath) &&
        (entry.status === undefined || status === undefined || entry.status === status),
    );
  }

  constructor(
    private page: Page,
    private journey: string,
  ) {
    this.page.on("pageerror", (error) => {
      this.record(
        "pageerror",
        `pageerror: ${error.name ?? "Error"}: ${String(error.message ?? error)}`,
      );
    });
    this.page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      // A journey-declared expected failure also mints a browser-level
      // "Failed to load resource" console error; when the declared regex
      // matches the message text or the resource URL it is not a defect.
      const url = location?.url ?? "";
      if (
        url.startsWith("http") &&
        this.expected.some((entry) => entry.re.test(url) || entry.re.test(message.text()))
      ) {
        return;
      }
      this.record(
        "console",
        `console.error: ${message.text()}${location?.url ? ` @ ${location.url}` : ""}`,
      );
    });
    this.page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/")) return;
      if (this.isExpected(url.pathname, response.status())) return;
      this.record("api", `${response.request().method()} ${url.pathname} -> ${response.status()}`);
    });
    this.page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (this.isExpected(url.pathname, undefined)) return;
      const failure = request.failure()?.errorText ?? " request failed";
      if (
        isBenignStreamAbort({
          errorText: failure,
          resourceType: request.resourceType(),
          accept: request.headers()["accept"] ?? "",
          url: request.url(),
        })
      ) {
        // Dropped, but loud: the pass log and results.json carry the note.
        this.note(
          `event-stream abort dropped: ${request.method()} ${url.pathname} failed: ` +
            `${failure.trim()} — a journal feed the client closed (navigation, unload or ` +
            `reconnect), not an API failure`,
        );
        return;
      }
      this.record("api", `${request.method()} ${url.pathname} failed: ${failure}`);
    });
  }

  expectFailure(re: RegExp, status?: number): void {
    this.expected.push({ re, status });
  }

  /** Record a NOTE: not a defect, not a failure — a fact about the CHECK
   * (a parity pair that could not be judged). Logged, and written out. */
  private note(detail: string): void {
    this.notes.push({ screen: this.currentScreen, detail });
    console.log(`[emu] NOTE ${this.journey} @ ${this.currentScreen}: ${detail}`);
  }

  /** The page's current viewport, e.g. "390x844". */
  private viewport(): string {
    return this.currentViewport;
  }

  /**
   * One screen at two widths. Settles the page (network idle is best-effort:
   * the app's SSE stream keeps a connection open, so an idle wait is capped;
   * fonts are awaited) and proves the screen renders sideways-free — a
   * sideways-scrolling screen is a RECORDED defect, the screenshot is taken
   * anyway because the report is where it is seen. At 1280 it collects the
   * content-parity inventory; at 390 it re-collects it and records the
   * reflow/clip/target defects (reflow.ts) — one aggregated defect per kind
   * per screen, so fingerprints stay stable. 390-only checks trivially pass
   * on the 1280 record (they are defined against the phone reflow). The
   * PARITY diff runs only between captures of the SAME page state: each
   * capture reads a state fingerprint (reflow.ts `collectStateFingerprint`)
   * and a moved state RE-CAPTURES the 1280 side at the 390 moment (its
   * screenshot and screen record replace the stale ones, so the report's
   * pair shows one state); a pair still moving after that is SKIPPED with a
   * note in the pass log and results.json — never a defect (pass-2
   * `2e schedule-run-approved` compared a `● RUNNING` 1280 header with a
   * `✓ DONE` 390 one and filed Pause/Cancel “lost” on a run that had simply
   * finished), never silent. The
   * overlap check (reflow.ts `findOverlaps`) is NOT 390-only: content painting
   * over content is a defect at either width, so it runs on every screen at
   * 1280 and 390. The design landmarks (design.ts) run at both widths too: a
   * screen that reflows perfectly but is missing its dialog's FOLDER select —
   * or drew the wrong page altogether — is not the screen its render drew.
   * The no-made-up-data check (mockdata.ts) runs at both widths as well: any
   * MOCK_DATA string (the mock's invented people, repos, workflow names,
   * issues, ids…) visible on the page is a `made-up-data` defect — the
   * honesty rule the design READMEs state ("All data is made up. Never fake
   * data the API doesn't serve") turned into an assertion.
   */
  async screen(badge: string, name: string): Promise<void> {
    this.currentScreen = `${badge} ${name}`;
    const design = designPngFor(badge);
    // A badge WITH a design render must have landmarks. A badge with none
    // (`run-gate`, `artifact`) is exempt: nothing to match, `checks.design`
    // trivially passes.
    const landmarks: Landmark[] | null = landmarksFor(badge, name) ?? null;
    if (design !== null && landmarks === null) {
      this.record(
        "design",
        `design landmark missing: no landmarks defined for "${badge} ${name}" — ` +
          `${badge}.png is a design render, so this screen's structure is unasserted`,
      );
    }
    // One defect per missing landmark per SCREEN (not one per width): the
    // fingerprint is kind + journey + screen + normalised detail, and a
    // landmark missing at both widths is one problem, filed once.
    const reportedLandmarks = new Set<string>();
    // Same dedupe rule for made-up-data hits: one string on the page at both
    // widths is one problem, filed once.
    const reportedMockHits = new Set<string>();
    // A state re-capture (see below) re-runs one width's checks on the SAME
    // screen: a finding already recorded for this kind+viewport+detail must
    // not file twice, so every width check records through this dedupe.
    const reportedFindings = new Set<string>();
    const recordOnce = (kind: EmuDefectKind, detail: string): void => {
      const dedupeKey = `${kind}|${this.currentViewport}|${detail}`;
      if (reportedFindings.has(dedupeKey)) return;
      reportedFindings.add(dedupeKey);
      this.record(kind, detail);
    };
    const labels = (items: ReflowItem[]): string =>
      items
        .slice(0, 5)
        .map((item) => item.label)
        .join("; ");
    // One width's capture: settle, screenshot and every width-local check,
    // PLUS the parity inventory and the page-state fingerprint read at that
    // SAME moment. The parity diff itself belongs to the caller: it may only
    // run between two captures of the same state.
    const capture = async (width: number, height: number): Promise<EmuScreen & ParityCapture> => {
      await this.page.setViewportSize({ width, height });
      this.currentViewport = `${width}x${height}`;
      await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {}); // SSE keeps the page alive; settle, don't hang
      await this.page.evaluate(() => document.fonts?.ready.catch(() => undefined)).catch(() => {});
      await this.page.waitForTimeout(250);
      const geometry = await this.page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        href: location.href,
      }));
      const checks: EmuScreenChecks = {
        sidescroll: true,
        parity: true,
        clip: true,
        target: true,
        overlap: true,
        design: true,
        data: true,
      };
      const shot = `${badge}-${name}-${width}.png`;
      // The capture goes from the TOP. A journey that clicked its way down a
      // list leaves the window (or the shell's `<main>`) scrolled, and a
      // `fullPage` shot is stitched from that scroll offset: the sticky phone
      // band painted across the middle of the 390 renders, over content it was
      // never sitting on. Nothing is restored — the screen's record is the
      // screen as designed, and the checks below (parity, targets, overlaps,
      // landmarks) are all top-anchored measurements anyway.
      await scrollToTopForCapture(this.page);
      await this.page.screenshot({
        path: path.join(EMU_OUT_DIR, shot),
        fullPage: true,
      });
      this.lastShot = shot;
      if (geometry.scrollWidth > geometry.innerWidth) {
        checks.sidescroll = false;
        recordOnce(
          "sidescroll",
          `sideways scroll on ${new URL(geometry.href).pathname}: scrollWidth ` +
            `${geometry.scrollWidth}px > innerWidth ${geometry.innerWidth}px`,
        );
      }
      const items = await this.page.evaluate(collectReflowItems);
      // (e) overlap: runs at BOTH widths — two things painting over each other
      // is a defect on the desk too, and this is the check that would have
      // caught the canvas caption over the last step card.
      const overlaps = await this.page.evaluate(findOverlaps);
      checks.overlap = overlaps.length === 0;
      if (!checks.overlap) {
        const pair = (hit: (typeof overlaps)[number]): string =>
          `${hit.a} × ${hit.b} (${hit.dx}×${hit.dy}px)`;
        const extra = overlaps.length > 3 ? ` (+${overlaps.length - 3} more)` : "";
        recordOnce(
          "overlap",
          `${overlaps.length} overlapping pair(s): ${overlaps.slice(0, 3).map(pair).join("; ")}${extra}`,
        );
      }
      // (f) no made-up data: the mock's sample values must never be on the
      // page. Case-sensitive, whole-word match over document.body.innerText
      // (the page's visible text) — see mockdata.ts for the list and its
      // exclusions, and mockdata-scan.mjs for the browser-free twin.
      const mockHits = await this.page.evaluate(findMockTexts, [...MOCK_DATA_TEXTS]);
      checks.data = mockHits.length === 0;
      for (const hit of mockHits) {
        if (reportedMockHits.has(hit)) continue;
        reportedMockHits.add(hit);
        recordOnce(
          "made-up-data",
          `made-up data: the mock's sample value "${hit}" is visible on this screen ` +
            `— mock source: ${sourcesFor(hit)}`,
        );
      }
      if (landmarks !== null) {
        const absent = await missingLandmarks(this.page, landmarks, width);
        checks.design = absent.length === 0;
        for (const landmark of absent) {
          if (reportedLandmarks.has(landmark.id)) continue;
          reportedLandmarks.add(landmark.id);
          recordOnce("design", `design landmark missing: ${landmark.desc}`);
        }
      }
      const stateFingerprint = await this.page.evaluate(collectStateFingerprint);
      if (width !== 1280) {
        const clips = await this.page.evaluate(findClippedText);
        checks.clip = clips.length === 0;
        if (!checks.clip) {
          const extra = clips.length > 1 ? ` (+${clips.length - 1} more)` : "";
          recordOnce("clip", `clipped text: ${clips[0].label} "${clips[0].text}"${extra}`);
        }
        const targets = await this.page.evaluate(findSmallTargets);
        checks.target = targets.length === 0;
        if (!checks.target) {
          recordOnce(
            "target",
            `${targets.length} touch targets under 44px: ` +
              `${targets
                .slice(0, 5)
                .map((hit) => `${hit.name}:${hit.height}px`)
                .join(", ")}`,
          );
        }
      }
      return {
        badge,
        name,
        width,
        url: geometry.href,
        shot,
        designPng: design,
        designRel: design ? path.relative(EMU_OUT_DIR, design) : null,
        checks,
        items,
        stateFingerprint,
      };
    };
    let desktop = await capture(1280, 900);
    const phone = await capture(390, 844);
    let verdict = judgeParityPair(desktop, phone);
    if (!verdict.comparable) {
      // The page moved between the widths. Preferred repair: re-capture the
      // 1280 side at the 390 moment (the screenshot name is stable, so the
      // report's pair then shows ONE state) and retry the diff.
      this.note(
        "state moved between the 1280 and the 390 capture — re-capturing the " +
          "1280 side at the 390 moment so the parity pair sees one page state",
      );
      desktop = await capture(1280, 900);
      verdict = judgeParityPair(desktop, phone);
      if (!verdict.comparable) {
        // Still moving (a run ticking through its stages between widths):
        // the diff could say nothing true. Skip the pair — LOUDLY: a note in
        // the pass log and in results.json, never a defect, never silently.
        this.note(
          `parity diff SKIPPED for this pair — the page is still changing between widths ` +
            `(would-be missing: ${labels(missingParityItems(desktop.items, phone.items)) || "nothing"}); ` +
            `a state drift, not a product defect`,
        );
      }
    }
    if (verdict.comparable && verdict.missing.length > 0) {
      // Attribute the defect to the 390 capture, wherever the viewport last was.
      this.currentViewport = "390x844";
      this.lastShot = phone.shot;
      phone.checks.parity = false;
      this.record(
        "reflow",
        `390 lost ${verdict.missing.length} of the 1280 items: ${labels(verdict.missing)}`,
      );
    }
    this.screens.push(screenRecord(desktop), screenRecord(phone));
    // Restore the desktop viewport: journeys act at 1280×900; the 390×844
    // capture was for the report.
    await this.page.setViewportSize({ width: 1280, height: 900 });
    this.currentViewport = "1280x900";
  }

  /** Record a defect (and keep the last screen/shot for context). */
  private record(kind: EmuDefectKind, detail: string): void {
    this.defects.push(this.defectFor(kind, detail));
  }

  /** Build a defect now, with the screen/viewport/shot as of now (a deferred
   * abort must report where it happened, not where the test ended). */
  private defectFor(kind: EmuDefectKind, detail: string): EmuDefect {
    // eslint-disable-next-line no-control-regex -- intentional: strip ANSI escapes
    const clean = detail.replace(/\u001b\[[0-9;]*m/g, "");
    const trimmed = clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL)}…` : clean;
    return {
      kind,
      journey: this.journey,
      screen: this.currentScreen,
      viewport: this.viewport(),
      detail: trimmed,
      fingerprint: fingerprintOf(kind, this.journey, this.currentScreen, trimmed),
      screenshot: this.lastShot,
    };
  }

  /**
   * At the test's end: a FAILED journey records its own assertion (kind
   * assertion — the brief's contract: a journey that hits a missing design
   * element is a real defect), then everything is appended to
   * results.json, one JSON object per line.
   */
  async finish(status: string, error: unknown): Promise<void> {
    if (status !== "passed" && status !== "skipped") {
      const raw =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : error != null && typeof (error as { message?: unknown }).message === "string"
              ? (error as { message: string }).message
              : String(error ?? status);
      const message = raw.split("\n").slice(0, 3).join(" ").trim();
      this.record("assertion", `assertion: ${message}`);
    }
    await mkdir(EMU_OUT_DIR, { recursive: true });
    const lines = [
      ...this.screens.map((screen) =>
        JSON.stringify({ type: "screen", pass: EMU_PASS_ID, ...screen }),
      ),
      ...this.notes.map((note) =>
        JSON.stringify({ type: "note", pass: EMU_PASS_ID, journey: this.journey, ...note }),
      ),
      ...this.defects.map((defect) =>
        JSON.stringify({ type: "defect", pass: EMU_PASS_ID, ...defect }),
      ),
    ];
    if (lines.length > 0) {
      await appendFile(resultsFile, `${lines.join("\n")}\n`);
    }
    if (this.defects.length > 0) {
      console.log(`[emu] ${this.journey}: ${this.defects.length} defect(s) recorded`);
      for (const defect of this.defects) {
        console.log(`[emu]   ${defect.kind} @ ${defect.screen}: ${defect.detail.slice(0, 120)}`);
      }
    }
  }
}

function journeyOf(titlePath: readonly string[]): string {
  // The describe() that owns the journey: "setup.spec.ts > workflows-index > test".
  return titlePath[1] ?? titlePath[0];
}

export const test = base.extend<{ emu: Emu }>({
  emu: async ({ page }, use, testInfo) => {
    const recorder = new EmuRecorder(page, journeyOf(testInfo.titlePath));
    const emu: Emu = {
      expectFailure: (re, status) => recorder.expectFailure(re, status),
      screen: (badge, name) => recorder.screen(badge, name),
    };
    await use(emu);
    await recorder.finish(testInfo.status ?? "failed", testInfo.error);
  },
});

export { expect } from "@playwright/test";
