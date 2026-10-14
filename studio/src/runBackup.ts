import { RUN_LIMIT } from "./runStore";

export const MAX_RUN_BACKUP_BYTES = 64 * 1024 * 1024;
export interface OriginalRun { source: string; attestation?: string; backupPlan?: string; backupPreflight?: string }
const encoder = new TextEncoder();
const version = "nostekon/run-backup/v1alpha1";
const planVersion = "nostekon/run-backup/v2alpha1";
const preflightVersion = "nostekon/run-backup/v3alpha1";

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported backup fields or object.");
  return value as Record<string, unknown>;
}

function original(value: unknown, limit: number): string {
  if (typeof value !== "string" || encoder.encode(value).length > limit) throw new Error("Backup original is missing or exceeds its byte limit.");
  const decoded: unknown = JSON.parse(value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Backup originals must contain JSON objects.");
  return value;
}

async function digest(source: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(source));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createRunBackup(inputs: readonly OriginalRun[]): Promise<string> {
  if (!inputs.length || inputs.length > RUN_LIMIT) throw new Error("Backup must contain 1-50 runs.");
  const runs: Record<string, string>[] = [];
  let total = 128;
  for (const input of inputs) {
    const source = original(input.source, 16 * 1024 * 1024);
    const entry: Record<string, string> = { sha256: await digest(source), evidence: source };
    if (input.attestation) {
      entry.attestation = original(input.attestation, 16 * 1024);
      entry.attestationSha256 = await digest(entry.attestation);
    }
    if (input.backupPlan !== undefined && input.backupPlan !== "") {
      entry.backupPlan = original(input.backupPlan, 16 * 1024);
      entry.backupPlanSha256 = await digest(entry.backupPlan);
    }
    if (input.backupPreflight !== undefined && input.backupPreflight !== "") {
      entry.backupPreflight = original(input.backupPreflight, 16 * 1024);
      entry.backupPreflightSha256 = await digest(entry.backupPreflight);
    }
    total += encoder.encode(JSON.stringify(entry)).length + 1;
    if (total > MAX_RUN_BACKUP_BYTES) throw new Error("Run backup exceeds the 64 MiB limit. Export originals individually.");
    runs.push(entry);
  }
  const apiVersion = runs.some(run => run.backupPreflight !== undefined) ? preflightVersion
    : runs.some(run => run.backupPlan !== undefined) ? planVersion : version;
  const encoded = JSON.stringify({ apiVersion, kind: "RunBackup", runs });
  await readRunBackup(encoded);
  return encoded;
}

export async function readRunBackup(source: string): Promise<OriginalRun[]> {
  if (encoder.encode(source).length > MAX_RUN_BACKUP_BYTES) throw new Error("Run backup exceeds the 64 MiB limit.");
  const backup = object(JSON.parse(source), ["apiVersion", "kind", "runs"]);
  if (![version, planVersion, preflightVersion].includes(String(backup.apiVersion)) || backup.kind !== "RunBackup" || !Array.isArray(backup.runs) || !backup.runs.length || backup.runs.length > RUN_LIMIT) throw new Error("Unsupported run backup version, kind or run count.");
  const identities = new Set<string>();
  const runs: OriginalRun[] = [];
  for (const value of backup.runs) {
    const allowed = [
      "sha256",
      "evidence",
      "attestation",
      "attestationSha256",
      ...(backup.apiVersion === planVersion || backup.apiVersion === preflightVersion ? ["backupPlan", "backupPlanSha256"] : []),
      ...(backup.apiVersion === preflightVersion ? ["backupPreflight", "backupPreflightSha256"] : []),
    ];
    const entry = object(value, allowed);
    const evidence = original(entry.evidence, 16 * 1024 * 1024);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || await digest(evidence) !== entry.sha256) throw new Error("Evidence integrity check failed.");
    if (identities.has(entry.sha256)) throw new Error("Duplicate backup run identity.");
    identities.add(entry.sha256);
    const run: OriginalRun = { source: evidence };
    if (entry.attestation !== undefined) {
      const attestation = original(entry.attestation, 16 * 1024);
      if (await digest(attestation) !== entry.attestationSha256) throw new Error("Attestation integrity check failed.");
      run.attestation = attestation;
    } else {
      if (entry.attestationSha256 !== undefined) throw new Error("Missing attestation original.");
    }
    if (entry.backupPlan !== undefined) {
      run.backupPlan = original(entry.backupPlan, 16 * 1024);
      if (await digest(run.backupPlan) !== entry.backupPlanSha256) throw new Error("Backup plan integrity check failed.");
    } else if (entry.backupPlanSha256 !== undefined) throw new Error("Missing backup plan original.");
    if (entry.backupPreflight !== undefined) {
      run.backupPreflight = original(entry.backupPreflight, 16 * 1024);
      if (await digest(run.backupPreflight) !== entry.backupPreflightSha256) throw new Error("Backup preflight integrity check failed.");
    } else if (entry.backupPreflightSha256 !== undefined) throw new Error("Missing backup preflight original.");
    runs.push(run);
  }
  return runs;
}