// Shared axe-core accessibility pass for the issue #2 acceptance suites.
//
// Runs axe with the wcag2a + wcag2aa tag set, logs one line per screen
// (`A11Y <name>: <n> violations (<ids>)` — ids listed for every violation
// regardless of impact), attaches the full result JSON to the test report,
// and FAILS only on `serious` or `critical` impact. `moderate` and `minor`
// findings are logged but do not fail the journey: the issue #2 suites are
// interaction journeys, and a hard failure here would mask the journey's
// own evidence.
import { type Page, test } from "@playwright/test";
import { AxeBuilder as Axe } from "@axe-core/playwright";

/** The result type axe's `analyze()` returns (re-exported via the builder). */
type AxeResults = Awaited<ReturnType<Axe["analyze"]>>;

/**
 * Run an axe audit of the current page state and record it against the test.
 *
 * @param page  the Playwright page to audit (must be on the screen under test)
 * @param name  short screen label, used in the log line and report attachment
 */
export async function checkA11y(page: Page, name: string): Promise<void> {
  const results: AxeResults = await new Axe({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

  const violations = results.violations;
  const ids = violations.map((v) => v.id).join(", ");
  console.log(`A11Y ${name}: ${violations.length} violations${ids ? ` (${ids})` : ""}`);
  for (const v of violations) {
    console.log(
      `A11Y ${name}: [${v.impact ?? "unknown"}] ${v.id} — ${v.description} (${v.nodes.length} node(s))`,
    );
    for (const n of v.nodes.slice(0, 3)) {
      console.log(`A11Y ${name}:   node: ${n.target.join(" > ")}`);
      for (const line of (n.failureSummary ?? "").split("\n").slice(0, 6))
        console.log(`     ${line}`);
    }
  }
  test.info().attach(`a11y-${name}.json`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });

  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (blocking.length > 0) {
    throw new Error(
      `a11y: ${blocking.length} serious/critical violation(s) on "${name}": ` +
        blocking.map((v) => `${v.id} (${v.impact})`).join(", "),
    );
  }
}
