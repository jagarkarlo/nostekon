import { describe, expect, it } from "vitest";
import { createRunBackup, readRunBackup } from "./runBackup";

const source = '{ "apiVersion": "nostekon/v1alpha1", "kind": "DrillRun", "metadata": {"name":"original"} }\n';
const attestation = '{ "kind": "Attestation", "signature": "not-yet-verified" }\n';
const sha256 = "a9d4cc00fbf2850d3ef94eea3f9b086eb9a9f9b8aedff26999f4db50c2e359bf";
const attestationSha256 = "2969a294fa8ff367e486b12d5f424528b6990ae95035794c0b85aab67adfbc0e";
const document = { apiVersion: "nostekon/run-backup/v1alpha1", kind: "RunBackup", runs: [{ sha256, evidence: source, attestation, attestationSha256 }] };

describe("original-run backups", () => {
  it("round-trips original plans in v2 with a fixed independent hash and no review cache", async () => {
    const backupPlan = '{ "kind": "PostgreSQLRestorePlan", "original": true }\n';
    const encoded = await createRunBackup([{ source, attestation, backupPlan }]);
    const backup = JSON.parse(encoded);
    expect(backup.apiVersion).toBe("nostekon/run-backup/v2alpha1");
    expect(backup.runs[0]).toEqual({ ...document.runs[0], backupPlan, backupPlanSha256: "0f55a8eeceb1103d5e7d7b04b871be776a04022f4c2ca04bcae254c7aa1ed25d" });
    expect(await readRunBackup(encoded)).toEqual([{ source, attestation, backupPlan }]);
    for (const changed of [
      { ...backup.runs[0], backupPlan: backupPlan + "\n" },
      { ...backup.runs[0], backupPlan: undefined },
      { ...backup.runs[0], backupPlanSha256: undefined },
      { ...backup.runs[0], backupReview: { passed: true } },
    ]) await expect(readRunBackup(JSON.stringify({ ...backup, runs: [changed] }))).rejects.toThrow();
    await expect(readRunBackup(JSON.stringify({ ...backup, apiVersion: document.apiVersion }))).rejects.toThrow();
    for (const backupPlan of ["not JSON", "[]", JSON.stringify({ text: "\u00e9".repeat(9 * 1024) })]) {
      await expect(createRunBackup([{ source, backupPlan }])).rejects.toThrow();
    }
  });

  it("preserves exact originals with independent hashes and excludes reports or trust", async () => {
    const run = { source, attestation, report: { verdict: "verified" }, trusted: true, sampleId: "recorded" };
    const encoded = await createRunBackup([run]);
    expect(JSON.parse(encoded)).toEqual(document);
    expect(await readRunBackup(encoded)).toEqual([{ source, attestation }]);
  });

  it("reads an independently constructed versioned backup", async () => {
    expect(await readRunBackup(JSON.stringify(document))).toEqual([{ source, attestation }]);
  });

  it("rejects changed bytes, duplicate identities and unsupported authority fields", async () => {
    for (const invalid of [
      { ...document, runs: [{ ...document.runs[0], evidence: source + "\n" }] },
      { ...document, runs: [{ ...document.runs[0], attestation: attestation + "\n" }] },
      { ...document, runs: [document.runs[0], document.runs[0]] },
      { ...document, trustedKeys: [] },
      { ...document, runs: [{ ...document.runs[0], report: { verdict: "verified" } }] },
      { ...document, apiVersion: "unknown" },
      { ...document, runs: [] },
    ]) await expect(readRunBackup(JSON.stringify(invalid))).rejects.toThrow();
  });

  it("bounds count and UTF-8 sidecars, preserves unsigned evidence and rejects malformed originals", async () => {
    expect(await readRunBackup(await createRunBackup([{ source }]))).toEqual([{ source }]);
    await expect(createRunBackup(Array.from({ length: 51 }, () => ({ source })))).rejects.toThrow("1-50");
    await expect(createRunBackup([{ source, attestation: JSON.stringify({ text: "é".repeat(9 * 1024) }) }])).rejects.toThrow("limit");
    for (const malformed of ["null", "[]", "not JSON"]) await expect(createRunBackup([{ source: malformed }])).rejects.toThrow();
    await expect(createRunBackup([{ source }, { source }])).rejects.toThrow("Duplicate");
  });
});