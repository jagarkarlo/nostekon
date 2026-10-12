import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB, openDB } from "idb";
import { deleteRun, deleteSuite, evidenceLabel, listRuns, listSuites, RUN_LIMIT, saveRun, saveRuns, saveSuite, SUITE_LIMIT, suiteSources as reopenSuite } from "./runStore";
import type { Report } from "./report";

const report: Report = {
  name: "local-run", verdict: "verified", headline: "Verified to V3", requestedLevel: "V3",
  deepestPassed: "V3", firstFailed: null, failureAt: "2026-01-01T00:00:00Z",
  levels: [], findings: [], rto: null, rpo: null,
};

beforeEach(async () => {
  await deleteDB("checkride-runs");
  await deleteDB("nostekon-runs");
});

const suiteSummary = JSON.stringify({ apiVersion: "nostekon/lab-suite/v1alpha1", kind: "LabSuiteResult", status: "interrupted", passed: false,
  cases: [{ name: "zero-loss", drillRun: "zero-loss.drillrun.json", expectedExitCode: 0, observedExitCode: 0, passed: true }],
});
const suiteSources = new Map([["suite.json", suiteSummary + "\n"], ["zero-loss.drillrun.json", '{ "original": "suite case" }\n']]);

describe("saved suite snapshots", () => {
  it("preserves original grouping and bytes, deduplicates by all inputs and deletes without touching runs", async () => {
    const run = await saveRun("existing run", report);
    const saved = await saveSuite(suiteSources);
    await saveSuite(new Map(Array.from(suiteSources).reverse()));
    const snapshots = await listSuites();
    expect(snapshots).toHaveLength(1);
    expect(new Map(snapshots[0].files.map(file => [file.name, file.source]))).toEqual(suiteSources);
    expect(snapshots[0].id).toBe(saved.id);
    await deleteSuite(saved.id);
    expect(await listSuites()).toEqual([]);
    expect((await listRuns()).map(item => item.id)).toEqual([run.id]);
  });

  it("upgrades version-one run storage without replaying the legacy migration", async () => {
    const old = await openDB("nostekon-runs", 1, { upgrade(db) {
      db.createObjectStore("runs", { keyPath: "id" }); db.createObjectStore("migration");
    } });
    await old.put("runs", { id: "old", source: "old original", report, sampleId: "", savedAt: 1 });
    await old.put("migration", true, "legacy-imported");
    old.close();
    await saveSuite(suiteSources);
    expect((await listRuns()).map(item => item.source)).toEqual(["old original"]);
    expect(await listSuites()).toHaveLength(1);
  });

  it("includes all source bytes in the identity and verifies them on reopen", async () => {
    const original = await saveSuite(suiteSources);
    expect(await reopenSuite(original)).toEqual(suiteSources);
    const changed = new Map(suiteSources);
    changed.set("zero-loss.drillrun.json", "changed original");
    expect((await saveSuite(changed)).id).not.toBe(original.id);
    const damaged = { ...original, files: original.files.map(file => file.name === "suite.json" ? file : { ...file, source: "tampered" }) };
    await expect(reopenSuite(damaged)).rejects.toThrow("integrity");
    expect(await listSuites()).toHaveLength(2);
  });

  it("rolls back storage failure and permits a retry without changing runs", async () => {
    await saveRun("existing", report);
    const before = await listRuns();
    const originalPut = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "suites") throw new DOMException("Storage full", "QuotaExceededError");
      return originalPut.call(this, value, key);
    });
    try { await expect(saveSuite(suiteSources)).rejects.toThrow("Storage full"); }
    finally { failure.mockRestore(); }
    expect(await listSuites()).toEqual([]);
    expect(await listRuns()).toEqual(before);
    await saveSuite(suiteSources);
    expect(await listSuites()).toHaveLength(1);
  });

  it("bounds the library and serializes concurrent final-slot saves without eviction", async () => {
    for (let index = 0; index < SUITE_LIMIT - 1; index++) await saveSuite(new Map([...suiteSources, ["zero-loss.drillrun.json", `case ${index}`]]));
    const results = await Promise.allSettled([
      saveSuite(new Map([...suiteSources, ["zero-loss.drillrun.json", "first contender"]])),
      saveSuite(new Map([...suiteSources, ["zero-loss.drillrun.json", "second contender"]])),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")?.reason.message).toContain("Delete a suite");
    const before = await listSuites();
    await saveSuite(new Map(before[0].files.map(file => [file.name, file.source])));
    expect(await listSuites()).toHaveLength(SUITE_LIMIT);
    expect((await listSuites()).map(suite => suite.id).sort()).toEqual(before.map(suite => suite.id).sort());
  });

  it.each(["missing-summary", "unknown-file", "oversized", "invalid-summary"])("rejects %s before writing", async (scenario) => {
    const sources = new Map(suiteSources);
    if (scenario === "missing-summary") sources.delete("suite.json");
    if (scenario === "unknown-file") sources.set("private.ledger.db", "private");
    if (scenario === "oversized") sources.set("zero-loss.drillrun.json", "\u00e9".repeat(9 * 1024 * 1024));
    if (scenario === "invalid-summary") sources.set("suite.json", "{}");
    await expect(saveSuite(sources)).rejects.toThrow();
    expect(await listSuites()).toEqual([]);
  });

  it("surfaces unreadable snapshots without silently dropping them", async () => {
    await listSuites();
    const db = await openDB("nostekon-runs", 2);
    try { await db.put("suites", { id: "bad", files: null, savedAt: 1 }); }
    finally { db.close(); }
    await expect(listSuites()).rejects.toThrow("unreadable");
  });
});

describe("saved run library", () => {
  it("retains exact backup plans across reopen and unsigned updates, with explicit removal", async () => {
    const source = '{ "run": "backup rehearsal" }\n';
    const backupPlan = '{ "kind": "PostgreSQLRestorePlan", "original": true }\n';
    await saveRuns([{ source, report, backupPlan }]);
    await saveRuns([{ source, report: { ...report, headline: "Fresh evaluation" } }]);
    const reopened = (await listRuns())[0];
    expect(reopened.backupPlan).toBe(backupPlan);
    expect(reopened.source).toBe(source);
    expect(reopened).not.toHaveProperty("backupReview");
    await saveRuns([{ source, report, backupPlan: "" }]);
    expect((await listRuns())[0].backupPlan).toBe("");
    expect(await listRuns()).toHaveLength(1);
  });

  it("rejects malformed and oversized plans before any batch write", async () => {
    for (const backupPlan of ["not JSON", "null", "[]", JSON.stringify({ text: "\u00e9".repeat(9 * 1024) })]) {
      await expect(saveRuns([{ source: "first", report }, { source: "second", report, backupPlan }])).rejects.toThrow("Attached backup plan");
      expect(await listRuns()).toEqual([]);
    }
  });

  it("preserves attached originals across reload and unsigned updates without storing a receipt", async () => {
    const source = '{ "run": "signed original" }\n';
    const attestation = '{ "apiVersion": "nostekon/attestation/v1alpha1", "signature": "not yet checked" }\n';
    const saved = await saveRun(source, report, "", attestation);
    expect(saved.attestation).toBe(attestation);
    await saveRuns([{ source, report: { ...report, headline: "Fresh evaluation" } }]);
    const reopened = (await listRuns())[0];
    expect(reopened.source).toBe(source);
    expect(reopened.attestation).toBe(attestation);
    expect(reopened).not.toHaveProperty("signatureCheck");
    expect(reopened).not.toHaveProperty("trusted");
    await saveRun(source, report, "", "");
    expect((await listRuns())[0].attestation).toBe("");
    expect(await listRuns()).toHaveLength(1);
  });

  it("rejects malformed or oversized attachments before any batch write", async () => {
    for (const attestation of ["not JSON", "null", "[]", JSON.stringify({ text: "\u00e9".repeat(9 * 1024) })]) {
      await expect(saveRuns([{ source: "first", report }, { source: "second", report, attestation }])).rejects.toThrow();
      expect(await listRuns()).toEqual([]);
    }
  });

  it("uses only the new database on a fresh installation", async () => {
    await listRuns();
    expect((await indexedDB.databases()).map((db) => db.name)).toEqual(["nostekon-runs"]);
  });

  it.each(["attestation", "backupPlan"] as const)("retains corrupt %s originals and reports the failure without pruning", async (field) => {
    const saved = await saveRun("original", report);
    const db = await openDB("nostekon-runs", 2);
    try { await db.put("runs", { ...saved, [field]: "damaged JSON" }); }
    finally { db.close(); }
    await expect(listRuns()).rejects.toThrow(field === "attestation" ? "Attached attestation" : "Attached backup plan");
    const check = await openDB("nostekon-runs", 2);
    try { expect((await check.get("runs", saved.id))[field]).toBe("damaged JSON"); }
    finally { check.close(); }
  });

  it("rolls back replacement attachments and preserves the old originals on quota failure", async () => {
    await saveRun("existing", report, "", '{ "signature": "original" }\n', '{ "plan": "original" }\n');
    const before = await listRuns();
    const originalPut = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "runs" && value.source === "second") throw new DOMException("Storage full", "QuotaExceededError");
      return originalPut.call(this, value, key);
    });
    try {
      await expect(saveRuns([
        { source: "existing", report, attestation: '{"signature":"replacement"}', backupPlan: '{"plan":"replacement"}' },
        { source: "second", report, attestation: '{"signature":"new"}', backupPlan: '{"plan":"new"}' },
      ])).rejects.toThrow("Storage full");
    } finally { failure.mockRestore(); }
    expect(await listRuns()).toEqual(before);
  });

  it("rolls back interrupted migration and safely retries it", async () => {
    const legacy = await openDB("checkride-runs", 1, {
      upgrade(db) { db.createObjectStore("runs", { keyPath: "id" }); },
    });
    const first = { id: "first", source: "first", report, sampleId: "", savedAt: 1 };
    const second = { ...first, id: "second", source: "second", savedAt: 2 };
    await legacy.put("runs", first);
    await legacy.put("runs", second);
    legacy.close();
    const originalPut = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "runs" && value.id === "second") throw new DOMException("Storage full", "QuotaExceededError");
      return originalPut.call(this, value, key);
    });
    try { await expect(listRuns()).rejects.toThrow("Storage full"); }
    finally { failure.mockRestore(); }
    const current = await openDB("nostekon-runs", 2);
    try {
      expect(await current.count("runs")).toBe(0);
      expect(await current.get("migration", "legacy-imported")).toBeUndefined();
    } finally { current.close(); }
    expect(await listRuns()).toEqual([second, first]);
  });

  it("serializes concurrent imports and keeps an existing Nostekon record", async () => {
    const legacy = await openDB("checkride-runs", 1, {
      upgrade(db) { db.createObjectStore("runs", { keyPath: "id" }); },
    });
    const oldRun = { id: "same", source: "old", report, sampleId: "", savedAt: 1 };
    await legacy.put("runs", oldRun);
    legacy.close();
    const current = await openDB("nostekon-runs", 1, {
      upgrade(db) {
        db.createObjectStore("runs", { keyPath: "id" });
        db.createObjectStore("migration");
      },
    });
    const newRun = { ...oldRun, source: "current", savedAt: 2 };
    await current.put("runs", newRun);
    current.close();
    expect(await Promise.all([listRuns(), listRuns()])).toEqual([[newRun], [newRun]]);
  });

  it("migrates legacy runs once without changing evidence or resurrecting deleted runs", async () => {
    const legacy = await openDB("checkride-runs", 1, {
      upgrade(db) { db.createObjectStore("runs", { keyPath: "id" }); },
    });
    const saved = { id: "legacy", source: '{ "apiVersion": "checkride/v1alpha1" }\n', report, sampleId: "k3d-postgresql", savedAt: 123 };
    await legacy.put("runs", saved);
    legacy.close();
    expect(await listRuns()).toEqual([saved]);
    expect((await indexedDB.databases()).map((db) => db.name)).toContain("nostekon-runs");
    const current = await openDB("nostekon-runs", 2);
    try { expect(await current.get("runs", saved.id)).toEqual(saved); }
    finally { current.close(); }
    await deleteRun(saved.id);
    expect(await listRuns()).toEqual([]);
    const backup = await openDB("checkride-runs", 1);
    expect(await backup.get("runs", saved.id)).toEqual(saved);
    backup.close();
  });

  it("persists original evidence and provenance, deduplicates and deletes", async () => {
    const saved = await saveRun('{"run":1}', report, "k3d-postgresql");
    await saveRun('{"run":1}', report, "k3d-postgresql");
    expect(await listRuns()).toEqual([expect.objectContaining({ id: saved.id, source: '{"run":1}', sampleId: "k3d-postgresql" })]);
    await deleteRun(saved.id);
    expect(await listRuns()).toEqual([]);
  });

  it("does not silently evict evidence when the library is full", async () => {
    for (let index = 0; index < RUN_LIMIT; index++) await saveRun(String(index), report);
    await expect(saveRun("overflow", report)).rejects.toThrow("Delete a run");
    await saveRun("0", report);
    expect(await listRuns()).toHaveLength(RUN_LIMIT);
  });

  it("saves a suite atomically with exact sources and content deduplication", async () => {
    const sources = ['{ "case": "zero" }\n', '{ "case": "tail" }\n', '{ "case": "budget" }\n'];
    const saved = await saveRuns(sources.map((source) => ({ source, report })));
    expect(saved).toHaveLength(3);
    expect(new Set(saved.map((run) => run.id)).size).toBe(3);
    expect(saved.map((run) => run.source)).toEqual(sources);
    expect(saved.every((run) => run.sampleId === "")).toBe(true);
    await saveRuns(sources.map((source) => ({ source, report })));
    expect(await listRuns()).toHaveLength(3);
  });

  it("rolls back every case and an existing update when a suite cannot fit", async () => {
    for (let index = 0; index < RUN_LIMIT - 1; index++) await saveRun(String(index), report);
    const before = await listRuns();
    await expect(saveRuns([
      { source: "0", report: { ...report, headline: "Updated" } },
      { source: "first new case", report },
      { source: "second new case", report },
    ])).rejects.toThrow("Delete a run");
    expect(await listRuns()).toEqual(before);
  });

  it("rolls back a mid-suite storage failure and permits a retry", async () => {
    await saveRun("existing", report);
    const before = await listRuns();
    const inputs = ["first", "second", "third"].map((source) => ({ source, report }));
    const originalPut = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "runs" && value.source === "second") throw new DOMException("Storage full", "QuotaExceededError");
      return originalPut.call(this, value, key);
    });
    try { await expect(saveRuns(inputs)).rejects.toThrow("Storage full"); }
    finally { failure.mockRestore(); }
    expect(await listRuns()).toEqual(before);
    await saveRuns(inputs);
    expect(await listRuns()).toHaveLength(4);
  });

  it("counts distinct new content rather than duplicate batch entries", async () => {
    for (let index = 0; index < RUN_LIMIT - 1; index++) await saveRun(String(index), report);
    const saved = await saveRuns([
      { source: "0", report },
      { source: "last", report },
      { source: "last", report },
    ]);
    expect(saved[1].id).toBe(saved[2].id);
    expect(await listRuns()).toHaveLength(RUN_LIMIT);
    await saveRuns([{ source: "0", report }, { source: "last", report }]);
    expect(await listRuns()).toHaveLength(RUN_LIMIT);
  });

  it("rejects oversized evidence before persisting any case", async () => {
    await expect(saveRuns([
      { source: "small", report },
      { source: "\u00e9".repeat(9 * 1024 * 1024), report },
    ])).rejects.toThrow("16 MiB");
    expect(await listRuns()).toEqual([]);
  });

  it("serializes concurrent batches at the library limit", async () => {
    for (let index = 0; index < RUN_LIMIT - 1; index++) await saveRun(String(index), report);
    const results = await Promise.allSettled([
      saveRuns([{ source: "first contender", report }]),
      saveRuns([{ source: "second contender", report }]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.reason.message).toContain("Delete a run");
    expect(await listRuns()).toHaveLength(RUN_LIMIT);
  });

  it("checks UTF-8 bytes rather than JavaScript character count", async () => {
    await expect(saveRun("\u00e9".repeat(9 * 1024 * 1024), report)).rejects.toThrow("16 MiB");
    expect(await listRuns()).toEqual([]);
  });

  it("surfaces damaged records instead of silently losing them", async () => {
    await listRuns();
    const db = await openDB("nostekon-runs", 2);
    await db.put("runs", { id: "bad", source: "{}", report: null });
    db.close();
    await expect(listRuns()).rejects.toThrow("unreadable");
  });

  it("does not call synthetic or imported data recorded lab evidence", () => {
    expect(evidenceLabel("k3d-postgresql")).toBe("Recorded lab");
    for (const id of ["k3d-ledger-zero-loss", "k3d-ledger-tail-loss", "k3d-ledger-budget-loss"]) {
      expect(evidenceLabel(id)).toBe("Recorded lab");
    }
    expect(evidenceLabel("k3d-unknown")).not.toBe("Recorded lab");
    expect(evidenceLabel("crud-cluster-loss")).toBe("Synthetic sample");
    expect(evidenceLabel("")).toBe("Imported evidence");
  });
});