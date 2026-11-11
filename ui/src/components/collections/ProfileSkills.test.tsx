/**
 * The staged-skill grouping of the SKILLS panel (ADR-0084 + deployed finding
 * 2026-11-11: 61 staged names as one flat list). Pure grouping plus the rendered
 * groups — every source collapsed by default, every name owned by exactly one
 * source, and no invented attribution.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  groupSkillsBySource,
  SkillSourceGroups,
  UNATTRIBUTED_SOURCE,
  skillSourceLabel,
  skillSourceNames,
  type SkillSourceGroup,
} from "./ProfileSkills";

const MATT_REF = "mattpocock/skills#v1.3.2";
const SHA = "63912a91d52c43946f974f2aaf661334a6116a82";
const PSTACK_TDD = `cursor/plugins/harness/pstack/claude-code/skills/tdd#${SHA}`;

afterEach(cleanup);

const library = [
  {
    id: "c-matt",
    name: "Matt Pocock skills",
    latest_revision: { revision: 1, entries: [{ ref: MATT_REF, skills: ["grilling", "tdd"] }] },
  },
  {
    id: "c-pstack",
    name: "pstack (Claude Code)",
    latest_revision: { revision: 2, entries: [{ ref: PSTACK_TDD }] },
  },
] as never;

describe("staged skills — grouping by source", () => {
  it("maps each owned name to the collection that ships it", () => {
    const names = skillSourceNames(library);
    const groups = groupSkillsBySource(
      ["tdd", "grilling", "ship-it"],
      [
        { skill: "tdd", from_ref: PSTACK_TDD },
        { skill: "grilling", from_ref: MATT_REF },
        { skill: "ship-it", from_ref: MATT_REF },
      ],
      names,
      null,
    );
    expect(groups.map((g) => [g.name, g.skills])).toEqual([
      ["Matt Pocock skills", ["grilling", "ship-it"]],
      ["pstack (Claude Code)", ["tdd"]],
    ]);
    // Later claimant wins: the lock's tdd belongs to pstack, not to Matt.
    expect(names.get(PSTACK_TDD)).toBe("pstack (Claude Code)");
  });

  it("attributes an unclaimed name to the extra package, and to no source when there is none", () => {
    const names = skillSourceNames(library);
    const withPackage = groupSkillsBySource(
      ["ask-matt"],
      undefined,
      names,
      "mattpocock/skills#v1.3.1",
    );
    expect(withPackage.map((g) => [g.name, g.skills])).toEqual([["extra package", ["ask-matt"]]]);

    const withoutPackage = groupSkillsBySource(["ask-matt"], [], names, null);
    expect(withoutPackage[0].name).toBe(UNATTRIBUTED_SOURCE);
    expect(skillSourceLabel("", names, null)).toBe(UNATTRIBUTED_SOURCE);
  });

  it("names a ref no library entry carries by the ref itself — never a guess", () => {
    expect(skillSourceLabel("other/repo#v1.0.0", skillSourceNames(library), null)).toBe(
      "other/repo#v1.0.0",
    );
  });

  it("keeps every skill in exactly one group and sorts the names inside it", () => {
    const names = skillSourceNames(library);
    const skills = ["zeta", "alpha", "tdd", "grilling"];
    const groups = groupSkillsBySource(
      skills,
      [
        { skill: "tdd", from_ref: PSTACK_TDD },
        { skill: "grilling", from_ref: MATT_REF },
      ],
      names,
      "mattpocock/skills#v1.3.1",
    );
    expect(groups.flatMap((g) => g.skills).sort()).toEqual([...skills].sort());
    for (const group of groups) expect(group.skills).toEqual([...group.skills].sort());
    // With an extra package pinned, the unclaimed names are its — and the
    // unattributed group only exists when there is no package to blame.
    // Sources sort by the name they show under, `extra package` like any other.
    expect(groups.map((g) => g.name)).toEqual([
      "extra package",
      "Matt Pocock skills",
      "pstack (Claude Code)",
    ]);
    const noPackage = groupSkillsBySource(
      skills,
      [{ skill: "tdd", from_ref: PSTACK_TDD }],
      skillSourceNames(library),
      null,
    );
    expect(noPackage[noPackage.length - 1].name).toBe(UNATTRIBUTED_SOURCE);
    expect(noPackage[noPackage.length - 1].skills).toEqual(["alpha", "grilling", "zeta"]);
  });
});

describe("staged skills — the rendered groups", () => {
  const groups: SkillSourceGroup[] = [
    { ref: MATT_REF, name: "Matt Pocock skills", skills: ["grilling", "tdd"] },
    { ref: PSTACK_TDD, name: "pstack (Claude Code)", skills: ["review"] },
  ];

  function mount(list: SkillSourceGroup[]) {
    render(<SkillSourceGroups groups={list} testidPrefix="agent-apm-skills-group" />);
  }

  it("renders one collapsible group per source, collapsed by default", () => {
    mount(groups);
    const list = screen.getByTestId("agent-apm-skills-group-list");
    const rows = list.querySelectorAll(":scope > li");
    expect(rows).toHaveLength(2);
    const details = list.querySelectorAll(":scope > li > details");
    expect(details).toHaveLength(2);
    // Collapsed by default: nothing is open until the person asks.
    for (const panel of Array.from(details)) expect((panel as HTMLDetailsElement).open).toBe(false);
    // The heading names the source and its count.
    expect(screen.getByTestId("agent-apm-skills-group-" + MATT_REF).textContent).toContain(
      "Matt Pocock skills · 2 skills",
    );
    expect(screen.getByTestId("agent-apm-skills-group-" + PSTACK_TDD).textContent).toContain(
      "pstack (Claude Code) · 1 skill",
    );
  });

  it("a group opens on click and shows its skills", () => {
    mount(groups);
    const row = screen.getByTestId("agent-apm-skills-group-" + MATT_REF);
    const panel = row.querySelector("details") as HTMLDetailsElement;
    fireEvent.click(row.querySelector("summary") as HTMLElement);
    expect(panel.open).toBe(true);
    expect(panel.textContent).toContain("grilling");
    expect(panel.textContent).toContain("tdd");
    // The other group stays closed.
    const other = screen
      .getByTestId("agent-apm-skills-group-" + PSTACK_TDD)
      .querySelector("details") as HTMLDetailsElement;
    expect(other.open).toBe(false);
  });
});
