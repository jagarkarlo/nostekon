import { beforeEach, expect, it, vi } from "vitest";
import { request } from "./api";
import { exportBackupBundle, importBackupBundle, isBackupReview, readOriginalJSON, reviewBackup } from "./backupReview";

vi.mock("./api", () => ({ request: vi.fn() }));
const review = {
  apiVersion: "nostekon/backup-review/v1alpha1", kind: "PostgreSQLBackupReview",
  passed: false, complete: true, evidenceMatches: true,
  planSHA256: "a".repeat(64), planFileSHA256: "b".repeat(64), evidenceSHA256: "c".repeat(64),
  provenance: { status: "unverified" }, issues: [],
  report: { name: "measured-failure", verdict: "failed", levels: [], findings: [] },
};
beforeEach(() => vi.clearAllMocks());

it("sends exact original documents and retains a complete measured failure", async () => {
  vi.mocked(request).mockResolvedValue(new Response(JSON.stringify(review)));
  const plan = ' {"kind":"PostgreSQLRestorePlan"}\n';
  const evidence = '{ "kind": "DrillRun" }\n';
  expect(await reviewBackup(plan, evidence)).toEqual(review);
  expect(request).toHaveBeenCalledWith("/api/v1/backups/review", JSON.stringify({ plan, evidence }));
});

it("does not reinterpret verified provenance or malformed review results", () => {
  expect(isBackupReview(review)).toBe(true);
  for (const changed of [{ ...review, passed: "true" }, { ...review, planSHA256: "short" }, { ...review, provenance: { status: "verified" } }, { ...review, issues: [1] }, { ...review, report: null }]) expect(isBackupReview(changed)).toBe(false);
});

it("bounds inputs and rejects admission errors without approving cached results", async () => {
  await expect(reviewBackup(" ".repeat(16385), "{}")).rejects.toThrow(/16 KiB/);
  expect(request).not.toHaveBeenCalled();
  vi.mocked(request).mockResolvedValue(new Response(JSON.stringify({ errors: ["unsafe bundle"] }), { status: 422 }));
  await expect(importBackupBundle(new File(["bad"], "bad.zip"))).rejects.toThrow("unsafe bundle");
  await expect(importBackupBundle(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.zip"))).rejects.toThrow(/20 MiB/);
});

it("uses standard base64 at the transport boundary without altering ZIP bytes", async () => {
  const archive = new Uint8Array([80, 75, 3, 4, 0, 255]);
  vi.mocked(request).mockResolvedValueOnce(new Response(JSON.stringify({ bundle: "UEsDBAD/" })));
  expect(await exportBackupBundle("{}", "{}" )).toEqual(archive);
  vi.mocked(request).mockResolvedValueOnce(new Response(JSON.stringify({ plan: "{}\n", evidence: " {}\n", review })));
  expect(await importBackupBundle(new File([archive], "capture.zip"))).toEqual({ plan: "{}\n", evidence: " {}\n", review });
  expect(request).toHaveBeenLastCalledWith("/api/v1/backups/import", JSON.stringify({ bundle: "UEsDBAD/" }));
});

it("reads exact valid UTF-8 originals and rejects lossy file decoding", async () => {
  expect(await readOriginalJSON(new File(['{ "value": "č" }\r\n'], "run.json"), 100)).toBe('{ "value": "č" }\r\n');
  await expect(readOriginalJSON(new File([new Uint8Array([123, 255, 125])], "bad.json"), 100)).rejects.toThrow(/UTF-8/);
  expect(await readOriginalJSON(new File([new Uint8Array([239, 187, 191, 123, 125])], "bom.json"), 100)).toBe("\uFEFF{}");
});