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
//     with its design render (docs/design/handoff-*/png/<badge>.png).
//     At 390 it additionally runs the reflow checks (reflow.ts): content
//     parity with the 1280 inventory, no clipped text without an ellipsis,
//     and touch targets ≥ 44px — every violation is likewise RECORDED.
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
import type { APIResponse, Page, Request } from "@playwright/test";
import { EMU_DESIGN_DIRS, EMU_OUT_DIR, EMU_PASS_ID } from "./env.js";
import {
  collectReflowItems,
  findClippedText,
  findSmallTargets,
  missingParityItems,
  type EmuChecks,
  type ReflowItem,
} from "./reflow.js";

/** A defect kind, as reported in results.json and the issue title. */
export type EmuDefectKind =
  | "pageerror"
  | "console"
  | "api"
  | "sidescroll"
  | "assertion"
  | "reflow"
  | "clip"
  | "target";

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
  /** Per-width check outcomes (true = pass); see reflow.ts. */
  checks: EmuChecks;
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

/** The badge's design render (absolute path) or null. */
export function designPngFor(badge: string): string | null {
  for (const dir of EMU_DESIGN_DIRS) {
    const candidate = path.join(dir, `${badge}.png`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const MAX_DETAIL = 500;

/**
 * A `net::ERR_ABORTED` on an event stream is the browser cancelling an SSE
 * subscription because the page navigated away or closed — normal behaviour,
 * not a defect — but ONLY when a navigation/close actually happened around
 * it. Any other abort (server went away mid-journal, the socket died for a
 * reason the page did not cause) still counts.
 */
const ABORT_NAV_GRACE_MS = 1_000;

/** The request is one of the app's journal feeds (SSE or a fetch reading a
 * `text/event-stream` body). */
function isEventStreamRequest(request: Request): boolean {
  if (request.resourceType() === "eventsource") return true;
  if ((request.headers()["accept"] ?? "").toLowerCase().includes("text/event-stream")) return true;
  const pathname = new URL(request.url()).pathname;
  return pathname.endsWith("/events") || pathname.endsWith("/stream");
}

class EmuRecorder {
  private screens: EmuScreen[] = [];
  private defects: EmuDefect[] = [];
  private expected: { re: RegExp; status?: number }[] = [];
  private currentScreen = "(before first screen)";
  private lastShot: string | null = null;
  private currentViewport = "";
  /** Timestamps of main-frame navigations, and of the page closing — the
   * events that make an event-stream abort legitimate. */
  private navTimes: number[] = [];
  private closedAt: number | null = null;
  /** `net::ERR_ABORTED` on an event stream: held until finish(), when the
   * navigation timestamps around it are all known, then dropped or recorded. */
  private deferredAborts: { at: number; defect: EmuDefect }[] = [];
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
    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) return;
      this.navTimes.push(Date.now());
      if (this.navTimes.length > 100) this.navTimes.shift();
    });
    this.page.on("close", () => {
      this.closedAt ??= Date.now();
    });
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
      const failure = request.failure()?.errorText ?? "request failed";
      if (failure.trim() === "net::ERR_ABORTED" && isEventStreamRequest(request)) {
        this.deferredAborts.push({
          at: Date.now(),
          defect: this.defectFor("api", `${request.method()} ${url.pathname} failed: ${failure}`),
        });
        return;
      }
      this.record("api", `${request.method()} ${url.pathname} failed: ${failure}`);
    });
  }

  /** True when a navigation (or the page closing) happened within the grace
   * window of `at` — in either direction, since the abort and the navigation
   * event do not race each other in a fixed order. */
  private nearNavigation(at: number): boolean {
    if (this.closedAt !== null && Math.abs(this.closedAt - at) <= ABORT_NAV_GRACE_MS) return true;
    return this.navTimes.some((nav) => Math.abs(nav - at) <= ABORT_NAV_GRACE_MS);
  }

  expectFailure(re: RegExp, status?: number): void {
    this.expected.push({ re, status });
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
   * on the 1280 record (they are defined against the phone reflow).
   */
  async screen(badge: string, name: string): Promise<void> {
    this.currentScreen = `${badge} ${name}`;
    let desktopItems: ReflowItem[] | null = null;
    for (const [width, height] of [
      [1280, 900],
      [390, 844],
    ] as const) {
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
      const checks: EmuChecks = { sidescroll: true, parity: true, clip: true, target: true };
      const shot = `${badge}-${name}-${width}.png`;
      await this.page.screenshot({
        path: path.join(EMU_OUT_DIR, shot),
        fullPage: true,
      });
      this.lastShot = shot;
      if (geometry.scrollWidth > geometry.innerWidth) {
        checks.sidescroll = false;
        this.record(
          "sidescroll",
          `sideways scroll on ${new URL(geometry.href).pathname}: scrollWidth ` +
            `${geometry.scrollWidth}px > innerWidth ${geometry.innerWidth}px`,
        );
      }
      const items = await this.page.evaluate(collectReflowItems);
      if (width === 1280) {
        desktopItems = items;
      } else {
        const missing = missingParityItems(desktopItems ?? [], items);
        checks.parity = missing.length === 0;
        if (!checks.parity) {
          this.record(
            "reflow",
            `390 lost ${missing.length} of the 1280 items: ` +
              `${missing
                .slice(0, 5)
                .map((item) => item.label)
                .join("; ")}`,
          );
        }
        const clips = await this.page.evaluate(findClippedText);
        checks.clip = clips.length === 0;
        if (!checks.clip) {
          const extra = clips.length > 1 ? ` (+${clips.length - 1} more)` : "";
          this.record("clip", `clipped text: ${clips[0].label} "${clips[0].text}"${extra}`);
        }
        const targets = await this.page.evaluate(findSmallTargets);
        checks.target = targets.length === 0;
        if (!checks.target) {
          this.record(
            "target",
            `${targets.length} touch targets under 44px: ` +
              `${targets
                .slice(0, 5)
                .map((hit) => `${hit.name}:${hit.height}px`)
                .join(", ")}`,
          );
        }
      }
      const design = designPngFor(badge);
      this.screens.push({
        badge,
        name,
        width,
        url: geometry.href,
        shot,
        designPng: design,
        designRel: design ? path.relative(EMU_OUT_DIR, design) : null,
        checks,
      });
    }
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
    // Decide the held event-stream aborts now: dropped when a navigation or
    // the page close happened within the grace window, recorded otherwise.
    for (const held of this.deferredAborts) {
      if (!this.nearNavigation(held.at)) this.defects.push(held.defect);
    }
    this.deferredAborts = [];
    await mkdir(EMU_OUT_DIR, { recursive: true });
    const lines = [
      ...this.screens.map((screen) =>
        JSON.stringify({ type: "screen", pass: EMU_PASS_ID, ...screen }),
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
