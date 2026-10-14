import { request } from "./api";
import { isReport } from "./report";
import type { Report } from "./report";

export const MAX_PLAN_BYTES = 16 * 1024;
export const MAX_BACKUP_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

export interface BackupReview {
  apiVersion: "nostekon/backup-review/v1alpha1";
  kind: "PostgreSQLBackupReview";
  passed: boolean;
  complete: boolean;
  evidenceMatches: boolean;
  planSHA256: string;
  planFileSHA256: string;
  evidenceSHA256: string;
  provenance: { status: "unverified" };
  report: Report;
  issues: string[];
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreflightReview {
  apiVersion: "nostekon/preflight-review/v1alpha1";
  kind: "PostgreSQLPreflightReview";
  passed: boolean;
  planMatches: boolean;
  backupMatches: boolean;
  planSHA256: string;
  planFileSHA256: string;
  preflightSHA256: string;
  observedPlanSHA256: string;
  observedBackup: { sha256: string; bytes: number };
  observedImageId: string;
  requestedLevel: "V2" | "V3" | "V4";
  checks: PreflightCheck[];
  limitations: string[];
  issues: string[];
}

export function isPreflightReview(value: unknown): value is PreflightReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<PreflightReview>;
  return review.apiVersion === "nostekon/preflight-review/v1alpha1" && review.kind === "PostgreSQLPreflightReview"
    && typeof review.passed === "boolean" && typeof review.planMatches === "boolean" && typeof review.backupMatches === "boolean"
    && [review.planSHA256, review.planFileSHA256, review.preflightSHA256, review.observedPlanSHA256, review.observedBackup?.sha256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    && typeof review.observedBackup?.bytes === "number" && Number.isInteger(review.observedBackup.bytes) && review.observedBackup.bytes >= 5
    && typeof review.observedImageId === "string" && /^sha256:[a-f0-9]{64}$/.test(review.observedImageId)
    && ["V2", "V3", "V4"].includes(review.requestedLevel ?? "")
    && Array.isArray(review.checks) && review.checks.length > 0 && review.checks.every(check => check && typeof check.name === "string" && typeof check.passed === "boolean" && typeof check.detail === "string")
    && Array.isArray(review.limitations) && review.limitations.length >= 3 && review.limitations.every(text => typeof text === "string")
    && Array.isArray(review.issues) && review.issues.every(issue => typeof issue === "string")
    && (!review.passed || review.planMatches && review.backupMatches && review.issues.length === 0 && review.checks.every(check => check.passed));
}

export function isBackupReview(value: unknown): value is BackupReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<BackupReview>;
  return review.apiVersion === "nostekon/backup-review/v1alpha1" && review.kind === "PostgreSQLBackupReview"
    && typeof review.passed === "boolean" && typeof review.complete === "boolean" && typeof review.evidenceMatches === "boolean"
    && [review.planSHA256, review.planFileSHA256, review.evidenceSHA256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    && review.provenance?.status === "unverified" && isReport(review.report)
    && Array.isArray(review.issues) && review.issues.every(issue => typeof issue === "string")
    && (!review.passed || review.complete && review.evidenceMatches && review.issues.length === 0 && review.report.verdict === "verified");
}

async function post(path: string, body: object): Promise<unknown> {
  const response = await request(path, JSON.stringify(body));
  const result: unknown = await response.json();
  if (!response.ok) {
    const errors = (result as { errors?: unknown } | null)?.errors;
    throw new Error(Array.isArray(errors) && errors.every(error => typeof error === "string") ? errors.join("; ") : `Backup review HTTP ${response.status}`);
  }
  return result;
}

function boundOriginals(plan: string, evidence: string) {
  if (!plan || new TextEncoder().encode(plan).length > MAX_PLAN_BYTES) throw new Error("Restore plan must be nonempty and within 16 KiB.");
  if (!evidence || new TextEncoder().encode(evidence).length > MAX_EVIDENCE_BYTES) throw new Error("DrillRun must be nonempty and within 16 MiB.");
}

export async function reviewBackup(plan: string, evidence: string): Promise<BackupReview> {
  boundOriginals(plan, evidence);
  const result = await post("/api/v1/backups/review", { plan, evidence });
  if (!isBackupReview(result)) throw new Error("Unsupported independent backup review response.");
  return result;
}

export async function reviewBackupPreflight(plan: string, preflight: string): Promise<PreflightReview> {
  if (!plan || new TextEncoder().encode(plan).length > MAX_PLAN_BYTES) throw new Error("Restore plan must be nonempty and within 16 KiB.");
  if (!preflight || new TextEncoder().encode(preflight).length > MAX_PLAN_BYTES) throw new Error("Backup preflight must be nonempty and within 16 KiB.");
  const result = await post("/api/v1/backups/preflight", { plan, preflight });
  if (!isPreflightReview(result)) throw new Error("Unsupported backup preflight review response.");
  return result;
}

export async function exportBackupBundle(plan: string, evidence: string, preflight?: string): Promise<Uint8Array<ArrayBuffer>> {
  boundOriginals(plan, evidence);
  if (preflight !== undefined && preflight !== "" && new TextEncoder().encode(preflight).length > MAX_PLAN_BYTES) throw new Error("Backup preflight must be within 16 KiB.");
  const result = await post("/api/v1/backups/bundle", preflight ? { plan, evidence, preflight } : { plan, evidence });
  const encoded = (result as { bundle?: unknown } | null)?.bundle;
  if (typeof encoded !== "string" || encoded.length > 4 * Math.ceil(MAX_BACKUP_BUNDLE_BYTES / 3)) throw new Error("Invalid or oversized backup bundle response.");
  let archive: Uint8Array<ArrayBuffer>;
  try { archive = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)); }
  catch { throw new Error("Invalid backup bundle encoding."); }
  if (!archive.length || archive.length > MAX_BACKUP_BUNDLE_BYTES) throw new Error("Backup bundle exceeds 20 MiB.");
  return archive;
}

export async function importBackupBundle(file: File): Promise<{ plan: string; preflight?: string; evidence: string; review: BackupReview; preflightReview?: PreflightReview }> {
  if (!file.size || file.size > MAX_BACKUP_BUNDLE_BYTES) throw new Error("Backup bundle must be nonempty and within 20 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BACKUP_BUNDLE_BYTES) throw new Error("Backup bundle exceeds 20 MiB.");
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  const result = await post("/api/v1/backups/import", { bundle: btoa(chunks.join("")) });
  if (!result || typeof result !== "object") throw new Error("Invalid backup bundle import response.");
  const imported = result as { plan?: unknown; preflight?: unknown; evidence?: unknown; review?: unknown; preflightReview?: unknown };
  if (typeof imported.plan !== "string" || typeof imported.evidence !== "string" || !isBackupReview(imported.review)
    || (imported.preflight !== undefined && typeof imported.preflight !== "string")
    || (imported.preflightReview !== undefined && !isPreflightReview(imported.preflightReview))) throw new Error("Invalid backup bundle originals or fresh review.");
  boundOriginals(imported.plan, imported.evidence);
  if (imported.preflight && new TextEncoder().encode(imported.preflight).length > MAX_PLAN_BYTES) throw new Error("Backup preflight exceeds 16 KiB.");
  return { plan: imported.plan, preflight: imported.preflight, evidence: imported.evidence, review: imported.review, preflightReview: imported.preflightReview };
}

export async function readOriginalJSON(file: File, limit: number): Promise<string> {
  if (!file.size || file.size > limit) throw new Error(`Original JSON must be nonempty and within ${limit} bytes.`);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > limit) throw new Error("Original JSON exceeds its byte limit.");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("Original JSON must be valid UTF-8; lossy decoding is not allowed."); }
}