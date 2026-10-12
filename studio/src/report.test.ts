import { describe, expect, it } from "vitest";
import { Zip, ZipPassThrough, zipSync } from "fflate";
import { readSignedArchive } from "./signedArchive";
import { formatDuration, isReport, objectiveUsage, reportMarkdown, timelineBars } from "./report";
import type { Report } from "./report";

const report: Report = {
  name: "shop-run",
  drill: "shop-namespace-loss",
  scenario: "namespace-loss",
  verdict: "failed",
  headline: "Failed at V3: row counts",
  requestedLevel: "V4",
  deepestPassed: "V2",
  firstFailed: "V3",
  failureAt: "2026-10-01T10:00:00Z",
  levels: [
    { id: "V2", question: "Is the workload healthy?", evidence: "", status: "passed", inScope: true, checks: [{ name: "pods", passed: true, source: "reported" }] },
    { id: "V3", question: "Is the data structurally intact?", evidence: "", status: "failed", inScope: true, checks: [{ name: "a|b", passed: false, source: "reported" }] },
  ],
  rto: {
    seconds: 600,
    objectiveSeconds: 900,
    met: true,
    uncoveredSeconds: 0,
    slowestPhase: "restore",
    completedAt: "2026-10-01T10:10:00Z",
    phases: [
      { name: "provision", startedAt: "", endedAt: "", offsetSeconds: 0, durationSeconds: 200 },
      { name: "restore", startedAt: "", endedAt: "", offsetSeconds: 200, durationSeconds: 400 },
    ],
  },
  rpo: null,
  findings: [{ severity: "error", message: "V3 failed: row counts" }],
};

describe("signed-original archive import", () => {
  it("labels backup rehearsal timing without inventing a failure or incident RTO", () => {
    const markdown = reportMarkdown({ ...report, scenario: "postgresql-backup-rehearsal" });
    expect(markdown).toContain("Rehearsal started:");
    expect(markdown).toContain("Rehearsal duration:");
    expect(markdown).not.toContain("Failure injected:");
    expect(markdown).not.toContain("- RTO:");
  });
  const encode = (text: string) => new TextEncoder().encode(text);
  function archiveEntries(entries: [string, Uint8Array][]) {
    const chunks: Uint8Array[] = [];
    const archive = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
    for (const [name, bytes] of entries) {
      const entry = new ZipPassThrough(name); archive.add(entry); entry.push(bytes, true);
    }
    archive.end();
    const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return data;
  }
  const originals = {
    "nostekon.run.json": encode(' { "original": true }\n'),
    "nostekon.run.attestation.json": encode('{ "signature": "unverified" }\n'),
    "public-key.pem": encode("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"),
    "signature-check.json": encode('{"signatureValid":true,"trusted":true}'),
  };
  it("preserves originals exactly and never returns the bundled receipt as proof", () => {
    expect(readSignedArchive(zipSync(originals, { level: 0 }))).toEqual({
      evidence: ' { "original": true }\n', attestation: '{ "signature": "unverified" }\n',
      publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
    });
  });
  it.each(["../outside", "nested/public-key.pem", "PRIVATE.pem", "__proto__"])("rejects unexpected entry %s", name => {
    const archive = archiveEntries([...Object.entries(originals), [name, encode("extra")]]);
    expect(() => readSignedArchive(archive)).toThrow("Unexpected");
  });
  it("requires all four canonical entries and bounded Store ZIPs", () => {
    const { "public-key.pem": omitted, ...partial } = originals;
    expect(omitted).toBeDefined();
    expect(() => readSignedArchive(zipSync(partial, { level: 0 }))).toThrow("Missing");
    expect(() => readSignedArchive(zipSync(originals, { level: 6 }))).toThrow("uncompressed");
    expect(() => readSignedArchive(new Uint8Array(17 * 1024 * 1024 + 1))).toThrow("17 MiB");
    expect(() => readSignedArchive(zipSync({ ...originals, "signature-check.json": new Uint8Array(16 * 1024 + 1) }, { level: 0 }))).toThrow("limit");
    expect(() => readSignedArchive(zipSync({ ...originals, "nostekon.run.json": new Uint8Array(16 * 1024 * 1024 + 1) }, { level: 0 }))).toThrow("limit");
  });
  it("rejects private keys, malformed JSON and invalid UTF-8 before any engine request", () => {
    for (const replacement of [
      { "public-key.pem": encode("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----") },
      { "nostekon.run.json": encode("not JSON") },
      { "nostekon.run.attestation.json": encode("not JSON") },
      { "signature-check.json": encode("not JSON") },
      { "public-key.pem": new Uint8Array([0xc0, 0x80]) },
    ]) expect(() => readSignedArchive(zipSync({ ...originals, ...replacement }, { level: 0 }))).toThrow();
  });
  it("rejects duplicate canonical names even when their content is identical", () => {
    const archive = archiveEntries([...Object.entries(originals), ["public-key.pem", originals["public-key.pem"]]]);
    expect(() => readSignedArchive(archive)).toThrow("Duplicate");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours compactly", () => {
    expect(formatDuration(38)).toBe("38s");
    expect(formatDuration(703)).toBe("11m 43s");
    expect(formatDuration(900)).toBe("15m");
    expect(formatDuration(3720)).toBe("1h 02m");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("objectiveUsage", () => {
  it("is null without an objective and capped above it", () => {
    expect(objectiveUsage(10, null)).toBeNull();
    expect(objectiveUsage(450, 900)).toBe(0.5);
    expect(objectiveUsage(5000, 900)).toBe(1.5);
  });
});

describe("timelineBars", () => {
  it("scales phases to cover both the recovery and its objective", () => {
    const { bars, objectiveAt, failureAt } = timelineBars(report.rto!);
    expect(bars[1].slowest).toBe(true);
    expect(bars[1].left).toBeCloseTo((200 / (900 * 1.04)) * 100);
    expect(objectiveAt).toBeCloseTo(100 / 1.04);
    expect(failureAt).toBe(0);
  });

  it("keeps phases that begin before failure inside the plotted time window", () => {
    const { bars, scaleSeconds, objectiveAt, failureAt, failureOffsetSeconds } = timelineBars({
      ...report.rto!,
      phases: [{ ...report.rto!.phases[0], offsetSeconds: -120 }],
    });
    expect(failureOffsetSeconds).toBe(120);
    expect(bars[0].left).toBe(0);
    expect(failureAt).toBeCloseTo((120 / scaleSeconds) * 100);
    expect(objectiveAt).toBeCloseTo((1020 / scaleSeconds) * 100);
  });
});

describe("reportMarkdown", () => {
  it("exports full measured semantic scopes and failures without turning them into ledger proof", () => {
    const checks = [
      { name: "orders-id-required", passed: true, detail: "not_null: public.orders.id; measured violations: 0; expected 0", source: "reported" as const },
      { name: "orders-customer-exists", passed: false, detail: "foreign_key: public.orders.customer_id -> public.customers.id; measured violations: 1; expected 0", source: "reported" as const },
      { name: "computed-ledger", passed: true, detail: "ledger-only-detail", source: "ledger" as const },
    ];
    const markdown = reportMarkdown({ ...report, scenario: "postgresql-backup-rehearsal", levels: [
      ...report.levels, { id: "V4", question: "Is the data correct?", evidence: "", status: "failed", inScope: true, checks },
    ] });
    expect(markdown).toContain("## Reported V4 Checks");
    expect(markdown).toContain(`| orders-id-required | PASS | ${checks[0].detail} |`);
    expect(markdown).toContain(`| orders-customer-exists | FAIL | ${checks[1].detail} |`);
    expect(markdown).not.toContain("ledger-only-detail");
    expect(markdown).not.toContain("- RPO:");
  });

  it("summarizes verdict, levels and phases and escapes table pipes", () => {
    const markdown = reportMarkdown(report);
    expect(markdown).toContain("**Verdict:** FAILED.");
    expect(markdown).toContain("| V3 | Is the data structurally intact? | FAIL | ✗ a\\|b |");
    expect(markdown).toContain("| restore | +3m 20s | 6m 40s |");
    expect(markdown).toContain("- **error:** V3 failed: row counts");
  });

  it("preserves the negative offset of work that began before failure injection", () => {
    const beforeFailure = {
      ...report,
      rto: {
        ...report.rto!,
        phases: [{ ...report.rto!.phases[0], offsetSeconds: -120 }],
      },
    };
    expect(reportMarkdown(beforeFailure)).toContain("| provision | −2m | 3m 20s |");
  });
});

describe("isReport", () => {
  it("accepts reports and rejects problem responses", () => {
    expect(isReport(report)).toBe(true);
    expect(isReport({ errors: ["x"] })).toBe(false);
  });
});
