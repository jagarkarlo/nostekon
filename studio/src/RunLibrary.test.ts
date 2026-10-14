import { describe, expect, it } from "vitest";
import { comparisonWarnings, filterRuns, previewRunRestore, selectedRuns, sortRuns } from "./runHistory";
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

describe("original-only restore preview", () => {
  it("uses exact-byte identity and distinguishes included from preserved attachments", async () => {
    const source = '{ "apiVersion": "nostekon/v1alpha1", "kind": "DrillRun", "metadata": {"name":"original"} }\n';
    const id = "a9d4cc00fbf2850d3ef94eea3f9b086eb9a9f9b8aedff26999f4db50c2e359bf";
    const existing = { ...saved(id, "Cached name", 10), source, attestation: "{}", backupPreflight: "{}" };
    expect(await previewRunRestore([{ source, backupPlan: "{}" }], [existing])).toEqual([
      { id, name: "original", existing: true, attestation: "preserved", backupPlan: "included", backupPreflight: "preserved" },
    ]);
    expect(existing.attestation).toBe("{}");
  });

  it("previews new originals without evaluating or inventing trust", async () => {
    const [preview] = await previewRunRestore([{ source: '{ "original": true }' }], []);
    expect(preview).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/), name: "Unnamed original", existing: false, attestation: "none", backupPlan: "none", backupPreflight: "none" });
    expect(preview).not.toHaveProperty("report");
    expect(preview).not.toHaveProperty("trusted");
  });
});

describe("selected-original exports", () => {
  it("keeps selection order and exact originals without changing stored runs", () => {
    const first = { ...saved("first", "First", 10), source: '{ "original": 1 }\n', backupPlan: '{ "plan": true }\n' };
    const second = { ...saved("second", "Second", 20), attestation: '{ "signature": "unchecked" }\n' };
    expect(selectedRuns([first, second], ["second", "first"])).toEqual([second, first]);
    expect(first.source).toBe('{ "original": 1 }\n');
  });

  it("fails closed for empty, duplicate or disappeared selections", () => {
    const runs = [saved("first", "First", 10)];
    expect(() => selectedRuns(runs, [])).toThrow("Select");
    expect(() => selectedRuns(runs, ["first", "first"])).toThrow("Duplicate");
    expect(() => selectedRuns(runs, ["missing"])).toThrow("no longer available");
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
  const planned = { ...saved("planned", "Orders review", 20), backupPlan: "{}", backupPreflight: "{}", report: { ...saved("planned", "Orders review", 20).report, scenario: "postgresql", drill: "restore-orders" } };
  const attested = { ...saved("attested", "Orders signed", 30), attestation: "{}", report: { ...saved("attested", "Orders signed", 30).report, verdict: "verified" as const } };
  const runs = [plain, planned, attested];

  it("matches every normalized term across name, scenario and drill", () => {
    expect(filterRuns(runs, { query: "  POSTGRESQL orders  ", verdict: "all", attachment: "all" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "restore-orders", verdict: "all", attachment: "all" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "missing", verdict: "all", attachment: "all" })).toEqual([]);
  });

  it("combines verdict and attachment presence without granting trust", () => {
    expect(filterRuns(runs, { query: "", verdict: "all", attachment: "plan" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "", verdict: "all", attachment: "preflight" }).map(run => run.id)).toEqual(["planned"]);
    expect(filterRuns(runs, { query: "", verdict: "failed", attachment: "attestation" })).toEqual([]);
    expect(filterRuns(runs, { query: "", verdict: "all", attachment: "none" }).map(run => run.id)).toEqual(["plain"]);
    expect(attested.report.provenance).toBeUndefined();
    expect(runs).toHaveLength(3);
  });
});