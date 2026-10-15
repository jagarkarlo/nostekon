import { Zip, ZipPassThrough, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readEvidenceBundle } from "./evidenceBundle";
import { createSuiteReview, evaluateSuite, filterSavedSuites, parseSuite, sortSavedSuites } from "./labSuite";
import type { Report } from "./report";
import type { SavedSuite } from "./runStore";

describe("suite history ordering", () => {
  it("sorts saved timestamps with stable identity ties without changing snapshots", () => {
    const suites: SavedSuite[] = [
      { id: "c".repeat(64), savedAt: 20, files: [] },
      { id: "b".repeat(64), savedAt: 10, files: [] },
      { id: "a".repeat(64), savedAt: 20, files: [] },
    ];
    expect(sortSavedSuites(suites, "newest").map(suite => suite.id[0])).toEqual(["a", "c", "b"]);
    expect(sortSavedSuites(suites, "oldest").map(suite => suite.id[0])).toEqual(["b", "a", "c"]);
    expect(suites.map(suite => suite.id[0])).toEqual(["c", "b", "a"]);
  });
});

const summary = {
  apiVersion: "nostekon/lab-suite/v1alpha1", kind: "LabSuiteResult", status: "passed", passed: true,
  cases: ["zero-loss", "tail-loss", "budget-loss"].map((name) => ({
    name, drillRun: `${name}.drillrun.json`, expectedExitCode: name === "tail-loss" ? 1 : 0,
    observedExitCode: name === "tail-loss" ? 1 : 0, passed: true,
  })),
};

describe("suite history filters", () => {
  const full: SavedSuite = { id: "a".repeat(64), savedAt: 20, files: [
    { name: "suite.json", source: JSON.stringify(summary) },
    ...summary.cases.map(item => ({ name: item.drillRun, source: "{}" })),
  ] };
  const partial: SavedSuite = { id: "b".repeat(64), savedAt: 10, files: [
    { name: "suite.json", source: JSON.stringify({ ...summary, status: "interrupted", passed: false, cases: summary.cases.slice(0, 1) }) },
    { name: summary.cases[0].drillRun, source: "{}" },
  ] };
  const missing: SavedSuite = { ...full, id: "c".repeat(64), files: full.files.slice(0, 3) };
  it("combines case-insensitive identity and filename terms with runner status", () => {
    expect(filterSavedSuites([full, partial], { query: "AAAA TAIL-LOSS", status: "passed", capture: "all" })).toEqual([full]);
    expect(filterSavedSuites([full, partial], { query: "tail-loss", status: "interrupted", capture: "all" })).toEqual([]);
    expect(filterSavedSuites([full, partial], { query: "  ZERO-loss  ", status: "interrupted", capture: "all" })).toEqual([partial]);
  });
  it("requires three declared cases and each original file for a full capture", () => {
    expect(filterSavedSuites([full, partial, missing], { query: "", status: "all", capture: "full" })).toEqual([full]);
    expect(filterSavedSuites([full, partial, missing], { query: "", status: "all", capture: "partial" })).toEqual([partial, missing]);
  });
  it("does not confuse complete captures or runner claims with passing evidence", () => {
    const failed = { ...full, files: [{ name: "suite.json", source: JSON.stringify({ ...summary, status: "failed", passed: false }) }, ...full.files.slice(1)] };
    expect(filterSavedSuites([failed], { query: "", status: "failed", capture: "full" })).toEqual([failed]);
    expect(full.files[0].source).toBe(JSON.stringify(summary));
  });
});

describe("lab suite contract", () => {
  it("reads the runner summary without substituting it for evaluated evidence", () => {
    expect(parseSuite(JSON.stringify(summary))).toEqual(summary);
  });

  it.each(["failed", "running", "interrupted"])("accepts a partial %s suite", (status) => {
    const partial = { ...summary, status, passed: false, cases: summary.cases.slice(0, 1) };
    expect(parseSuite(JSON.stringify(partial))).toEqual(partial);
  });

  it.each([
    { ...summary, apiVersion: "unknown" },
    { ...summary, cases: [...summary.cases, summary.cases[0]] },
    { ...summary, cases: [summary.cases[1]] },
    { ...summary, status: "failed" },
    { ...summary, cases: [{ ...summary.cases[0], drillRun: "../outside.json" }] },
    { ...summary, cases: [{ ...summary.cases[0], observedExitCode: "0" }] },
    { ...summary, cases: [{ ...summary.cases[0], rpo: { lost: -1 } }] },
  ])("rejects malformed or contradictory summaries", (value) => {
    expect(() => parseSuite(JSON.stringify(value))).toThrow();
  });

  it("bounds summary size by UTF-8 bytes", () => {
    expect(() => parseSuite("\u00e9".repeat(33 * 1024))).toThrow("64 KiB");
  });
});

const measurement = { acknowledged: 10, recovered: 10, lost: 0, holes: 0, unexpected: 0, seconds: 0, objectiveSeconds: 0, met: true };
const report: Report = {
  name: "nostekon-test", verdict: "verified", headline: "Verified to V4", requestedLevel: "V4",
  deepestPassed: "V4", firstFailed: null, failureAt: "2026-10-05T12:00:00Z", levels: [], findings: [], rto: null,
  rpo: { ...measurement, consistent: true, recoveryPoint: null, firstLostAt: null, resolutionSeconds: null, timeline: [] },
};
const partialSuite = parseSuite(JSON.stringify({ ...summary, status: "failed", passed: false, cases: [{ ...summary.cases[0], rpo: measurement }] }));

describe("suite report agreement", () => {
  it("evaluates the exact source and compares each measurement", async () => {
    const source = '{ "original": true }\n';
    const result = await evaluateSuite(partialSuite, new Map([["zero-loss.drillrun.json", source]]), async (text) => {
      expect(text).toBe(source);
      return report;
    });
    expect(result.evidenceMatches).toBe(true);
    expect(result.cases[0].source).toBe(source);
    expect(result.cases[0].report).toBe(report);
    expect(result.cases[0].issues).toEqual([]);
  });

  it("does not accept a claimed success when measurements differ", async () => {
    const result = await evaluateSuite(partialSuite, new Map([["zero-loss.drillrun.json", "{}"]]), async () => ({ ...report, rpo: { ...report.rpo!, lost: 2 } }));
    expect(result.evidenceMatches).toBe(false);
    expect(result.cases[0].issues).toContain("lost differs from the suite summary.");
  });

  it("surfaces missing evidence without trusting the runner's result", async () => {
    const result = await evaluateSuite(partialSuite, new Map(), async () => { throw new Error("Must not evaluate"); });
    expect(result.evidenceMatches).toBe(false);
    expect(result.cases[0].report).toBeNull();
    expect(result.cases[0].issues).toContain("Missing evidence: zero-loss.drillrun.json");
  });

  it("keeps evaluator failures visible and never calls an empty suite a match", async () => {
    const result = await evaluateSuite(partialSuite, new Map([["zero-loss.drillrun.json", "{}"]]), async () => { throw new Error("Invalid evidence"); });
    expect(result.evidenceMatches).toBe(false);
    expect(result.cases[0].issues).toContain("Invalid evidence");
    const empty = parseSuite(JSON.stringify({ ...summary, status: "running", passed: false, cases: [] }));
    expect((await evaluateSuite(empty, new Map(), async () => report)).evidenceMatches).toBe(false);
  });
});

const policyMeasurements = [measurement,
  { ...measurement, acknowledged: 12, recovered: 10, lost: 2, seconds: 1, met: false },
  { ...measurement, acknowledged: 12, recovered: 10, lost: 2, seconds: 1, objectiveSeconds: 60 },
];
const policySummary = JSON.stringify({ ...summary, cases: summary.cases.map((item, index) => ({ ...item, rpo: policyMeasurements[index] })) });
const policySources = new Map(summary.cases.map((item, index) => [item.drillRun, `original ${index}\n`]));
const policyReports: Report[] = policyMeasurements.map((measured, index) => ({
  ...report, verdict: index === 1 ? "failed" : "verified", firstFailed: index === 1 ? "V4" : null, deepestPassed: index === 1 ? "V3" : "V4",
  rpo: { ...report.rpo!, ...measured },
}));

describe("machine-readable suite gate", () => {
  it("exports a passing review with expected policy failure and exact source digests", async () => {
    const review = await evaluateSuite(parseSuite(policySummary), policySources, async (source) => policyReports[Array.from(policySources.values()).indexOf(source)]);
    const document = await createSuiteReview(review, policySummary);
    expect(document).toMatchObject({ apiVersion: "nostekon/suite-review/v1alpha1", kind: "SuiteReview", passed: true, complete: true, evidenceMatches: true, runnerStatus: "passed", runnerPassed: true, provenance: { status: "unverified" } });
    expect(document.cases.map((item) => item.evaluatedExitCode)).toEqual([0, 1, 0]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("original 1\n"));
    expect(document.cases[1].evidenceSHA256).toBe(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
    expect(JSON.stringify(document)).not.toContain("original 1");
  });

  it("does not gate a partial capture as passing even when its evidence agrees", async () => {
    const review = await evaluateSuite(partialSuite, new Map([["zero-loss.drillrun.json", "{}"]]), async () => report);
    const document = await createSuiteReview(review, JSON.stringify(partialSuite));
    expect(document).toMatchObject({ passed: false, complete: false, evidenceMatches: true, runnerPassed: false });
  });

  it.each(["first-failure", "incomplete-levels", "rto-missed", "invariant-missed"])("rejects unrelated strict-tail %s instead of accepting any failed verdict", async (scenario) => {
    const review = await evaluateSuite(parseSuite(policySummary), policySources, async (source) => {
      const evaluated = policyReports[Array.from(policySources.values()).indexOf(source)];
      if (evaluated.verdict !== "failed") return evaluated;
      if (scenario === "incomplete-levels") return { ...evaluated, deepestPassed: "V1" };
      if (scenario === "rto-missed") return { ...evaluated, rto: { seconds: 2, objectiveSeconds: 1, met: false, uncoveredSeconds: 0, slowestPhase: "restore", phases: [], completedAt: "2026-10-07T12:00:00Z" } };
      if (scenario === "invariant-missed") {
        const changed: Report = { ...evaluated, levels: [{ id: "V4", question: "Invariant", evidence: "Reported check", status: "failed", inScope: true, checks: [{ name: "invariant", passed: false, source: "reported" }] }] };
        return changed;
      }
      return { ...evaluated, firstFailed: "V0" };
    });
    expect(review.evidenceMatches).toBe(false);
    expect(review.cases[1].issues).toContain("Evidence does not demonstrate the expected policy outcome.");
    expect((await createSuiteReview(review, policySummary)).passed).toBe(false);
  });
});

const bundleSources = new Map([
  ["suite.json", JSON.stringify({ ...summary, status: "interrupted", passed: false, cases: summary.cases.slice(0, 1) })],
  ["zero-loss.drillrun.json", '{ "original": "byte-preserved é" }\n'],
]);

async function bundleFixture(change?: (manifest: Record<string, unknown>, files: Record<string, Uint8Array>) => void) {
  const files = Object.fromEntries(Array.from(bundleSources, ([name, source]) => [name, new TextEncoder().encode(source)]));
  const manifest: Record<string, unknown> = {
    apiVersion: "nostekon/evidence-bundle/v1alpha1", kind: "LabEvidenceBundle",
    job: { id: "a".repeat(24), status: "interrupted", completedAt: "2026-10-07T10:00:00Z" },
    files: await Promise.all(Object.entries(files).map(async ([name, bytes]) => ({
      name, size: bytes.length,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join(""),
    }))),
    missingArtifacts: ["tail-loss.drillrun.json", "budget-loss.drillrun.json"],
  };
  change?.(manifest, files);
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
  return zipSync(files, { level: 0 });
}

describe("portable evidence bundles", () => {
  it("verifies checksums and preserves exact UTF-8 evidence without upgrading trust", async () => {
    expect(await readEvidenceBundle(await bundleFixture())).toEqual(bundleSources);
  });

  it("rejects changed evidence before evaluating it", async () => {
    const bytes = await bundleFixture((_, files) => { files["zero-loss.drillrun.json"] = new TextEncoder().encode("tampered evidence"); });
    await expect(readEvidenceBundle(bytes)).rejects.toThrow(/size|checksum/i);
  });

  it.each(["../outside.json", "/absolute.json", "zero-loss.drillrun.json.ledger.db", "__proto__"])("rejects unexpected archive entry %s", async (name) => {
    const bytes = await bundleFixture((_, files) => { files[name] = new Uint8Array([1]); });
    await expect(readEvidenceBundle(bytes)).rejects.toThrow(/unexpected|unsupported/i);
  });

  it("rejects an oversized summary before extracting it", async () => {
    const bytes = await bundleFixture((_, files) => { files["suite.json"] = new Uint8Array(64 * 1024 + 1); });
    await expect(readEvidenceBundle(bytes)).rejects.toThrow(/limit/i);
  });

  it.each(["missing-manifest", "wrong-version", "missing-declaration", "overlap", "duplicate-descriptor", "invalid-hash", "recovery-pending"])("rejects inconsistent manifest %s", async (scenario) => {
    const bytes = await bundleFixture((manifest) => {
      if (scenario === "missing-manifest") manifest.kind = undefined;
      if (scenario === "wrong-version") manifest.apiVersion = "unknown";
      if (scenario === "missing-declaration") manifest.missingArtifacts = [];
      if (scenario === "overlap") manifest.missingArtifacts = ["suite.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"];
      if (scenario === "duplicate-descriptor") (manifest.files as unknown[]).push((manifest.files as unknown[])[0]);
      if (scenario === "invalid-hash") (manifest.files as { sha256: string }[])[0].sha256 = "not-a-checksum";
      if (scenario === "recovery-pending") (manifest.job as Record<string, unknown>).recoveryRequired = true;
    });
    await expect(readEvidenceBundle(bytes)).rejects.toThrow();
  });

  it("rejects compressed archives rather than trusting decompression-size declarations", async () => {
    const compressed = zipSync({ "manifest.json": new TextEncoder().encode("{}".repeat(200)) }, { level: 6 });
    await expect(readEvidenceBundle(compressed)).rejects.toThrow(/uncompressed/i);
  });

  it("reports a metadata-only bundle as having no reviewable suite", async () => {
    const bytes = await bundleFixture((manifest, files) => {
      for (const name of Object.keys(files)) delete files[name];
      manifest.files = [];
      manifest.missingArtifacts = ["suite.json", "zero-loss.drillrun.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"];
    });
    await expect(readEvidenceBundle(bytes)).rejects.toThrow("No suite.json");
  });

  it("rejects duplicate archive entries before overwriting extracted files", async () => {
    const chunks: Uint8Array[] = [];
    const archive = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
    for (let index = 0; index < 2; index++) {
      const entry = new ZipPassThrough("manifest.json");
      archive.add(entry);
      entry.push(new TextEncoder().encode("{}"), true);
    }
    archive.end();
    await expect(readEvidenceBundle(Uint8Array.from(chunks.flatMap(chunk => Array.from(chunk))))).rejects.toThrow("Duplicate bundle entry");
  });

  it("rejects invalid UTF-8 even when its checksum matches", async () => {
    const bytes = await bundleFixture((manifest, files) => {
      files["zero-loss.drillrun.json"] = new Uint8Array([255]);
      (manifest.files as { name: string; size: number; sha256: string }[])[1] = {
        name: "zero-loss.drillrun.json", size: 1,
        sha256: "a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89",
      };
    });
    await expect(readEvidenceBundle(bytes)).rejects.toThrow(/encoding|encoded|valid/i);
  });
});