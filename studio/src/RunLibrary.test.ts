import { describe, expect, it } from "vitest";
import { comparisonWarnings, filterRuns, sortRuns } from "./runHistory";
import type { SavedRun } from "./runStore";

function saved(id: string, name: string, savedAt: number): SavedRun {
  return { id, source: "{}", sampleId: "", savedAt, report: { name, verdict: "failed", headline: "Failed", requestedLevel: "V3", deepestPassed: "V2", firstFailed: "V3", failureAt: "", levels: [], findings: [], rto: null, rpo: null } };
}

describe("saved-run history ordering", () => {
  it("orders dates in both directions without changing the input", () => {
    const runs = [saved("older", "Zulu", 10), saved("newer", "Alpha", 20)];
    expect(sortRuns(runs, "newest").map(run => run.id)).toEqual(["newer", "older"]);
    expect(sortRuns(runs, "oldest").map(run => run.id)).toEqual(["older", "newer"]);
    expect(runs.map(run => run.id)).toEqual(["older", "newer"]);
  });

  it("orders names naturally and breaks ties by original identity", () => {
    const runs = [saved("b", "Run 10", 10), saved("z", "run 2", 10), saved("a", "Run 2", 10)];
    expect(sortRuns(runs, "name").map(run => run.id)).toEqual(["a", "z", "b"]);
    expect(sortRuns(runs, "newest").map(run => run.id)).toEqual(["a", "b", "z"]);
  });
});

describe("run comparison boundaries", () => {
  it("does not treat unknown scenario or missing measurements as comparable", () => {
    const report = saved("first", "First", 10).report;
    expect(comparisonWarnings(report, report)).toEqual([
      "Different or unknown scenarios. Timing is not a like-for-like comparison.",
      "Recovery timing is missing from one or both runs.",
      "Acknowledged-write evidence is missing from one or both runs.",
    ]);
  });

  it("distinguishes requested depth from recovery policy differences", () => {
    const baseline = { ...saved("first", "First", 10).report, scenario: "restore" };
    const candidate = { ...baseline, requestedLevel: "V4", rto: { seconds: 3, objectiveSeconds: 5, met: true, uncoveredSeconds: 0, slowestPhase: "restore", phases: [], completedAt: "2026-10-14T07:00:00Z" } };
    expect(comparisonWarnings(baseline, candidate)).toContain("Different requested verification depths.");
    expect(comparisonWarnings(baseline, candidate)).toContain("Different recovery objectives. Verdicts use different policies.");
    expect(comparisonWarnings(baseline, candidate)).not.toContain("Different or unknown scenarios. Timing is not a like-for-like comparison.");
  });
});

describe("saved-run history filters", () => {
  const plain = saved("plain", "Inventory review", 10);
  const planned = { ...saved("planned", "Orders review", 20), backupPlan: "{}", report: { ...saved("planned", "Orders review", 20).report, scenario: "postgresql", drill: "restore-orders" } };
  const attested = { ...saved("attested", "Orders signed", 30), attestation: "{}", report: { ...saved("attested", "Orders signed", 30).report, verdict: "verified" as const } };
  const runs = [plain, planned, attested];

  it("matches every normalized term across name, scenario and drill", () => {
    expect(filterRuns(runs, { query: "  POSTGRESQL orders  ", verdict: "all", attachment: "all" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "restore-orders", verdict: "all", attachment: "all" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "missing", verdict: "all", attachment: "all" })).toEqual([]);
  });

  it("combines verdict and attachment presence without granting trust", () => {
    expect(filterRuns(runs, { query: "", verdict: "all", attachment: "plan" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "", verdict: "failed", attachment: "attestation" })).toEqual([]);
    expect(filterRuns(runs, { query: "", verdict: "all", attachment: "none" }).map(run => run.id)).toEqual(["plain"]);
    expect(attested.report.provenance).toBeUndefined();
    expect(runs).toHaveLength(3);
  });
});