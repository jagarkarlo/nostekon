import { describe, expect, it } from "vitest";
import { sortRuns } from "./runHistory";
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