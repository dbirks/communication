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
import type { Page } from "@playwright/test";
import { EMU_DESIGN_DIRS, EMU_OUT_DIR, EMU_PASS_ID } from "./env.js";

/** A defect kind, as reported in results.json and the issue title. */
export type EmuDefectKind = "pageerror" | "console" | "api" | "sidescroll" | "assertion";

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

class EmuRecorder {
  private screens: EmuScreen[] = [];
  private defects: EmuDefect[] = [];
  private expected: { re: RegExp; status?: number }[] = [];
  private currentScreen = "(before first screen)";
  private lastShot: string | null = null;
  private currentViewport = "";
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
      this.record("api", `${request.method()} ${url.pathname} failed: ${failure}`);
    });
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
   * anyway because the report is where it is seen.
   */
  async screen(badge: string, name: string): Promise<void> {
    this.currentScreen = `${badge} ${name}`;
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
      if (geometry.scrollWidth > geometry.innerWidth) {
        this.record(
          "sidescroll",
          `sideways scroll on ${new URL(geometry.href).pathname}: scrollWidth ` +
            `${geometry.scrollWidth}px > innerWidth ${geometry.innerWidth}px`,
        );
      }
      const shot = `${badge}-${name}-${width}.png`;
      await this.page.screenshot({
        path: path.join(EMU_OUT_DIR, shot),
        fullPage: true,
      });
      this.lastShot = shot;
      const design = designPngFor(badge);
      this.screens.push({
        badge,
        name,
        width,
        url: geometry.href,
        shot,
        designPng: design,
        designRel: design ? path.relative(EMU_OUT_DIR, design) : null,
      });
    }
    // Restore the desktop viewport: journeys act at 1280×900; the 390×844
    // capture was for the report.
    await this.page.setViewportSize({ width: 1280, height: 900 });
    this.currentViewport = "1280x900";
  }

  /** Record a defect (and keep the last screen/shot for context). */
  private record(kind: EmuDefectKind, detail: string): void {
    // eslint-disable-next-line no-control-regex -- intentional: strip ANSI escapes
    const clean = detail.replace(/\u001b\[[0-9;]*m/g, "");
    const trimmed = clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL)}…` : clean;
    this.defects.push({
      kind,
      journey: this.journey,
      screen: this.currentScreen,
      viewport: this.viewport(),
      detail: trimmed,
      fingerprint: fingerprintOf(kind, this.journey, this.currentScreen, trimmed),
      screenshot: this.lastShot,
    });
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
      const message = raw
        .split("\n")
        .slice(0, 3)
        .join(" ")
        .trim();
      this.record("assertion", `assertion: ${message}`);
    }
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
