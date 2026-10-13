import { request } from "./api";
import { MAX_PLAN_BYTES } from "./backupReview";

export interface ProfileRule {
  name: string;
  type: "not_null" | "unique" | "foreign_key";
  table: string;
  column: string;
  reference?: { table: string; column: string };
}

export interface ProfileReview {
  apiVersion: "nostekon/profile-review/v1alpha1";
  kind: "PostgreSQLProfileReview";
  valid: true;
  profileSHA256: string;
  invariants: ProfileRule[];
  tables: string[];
  warnings: string[];
  limitations: string[];
}

export function profileSource(invariants: ProfileRule[]) {
  return JSON.stringify({ apiVersion: "nostekon/validation-profile/v1alpha1", kind: "PostgreSQLValidationProfile", invariants }, null, 2) + "\n";
}

export function editableRules(source: string): ProfileRule[] | null {
  try {
    const parsed = JSON.parse(source) as { invariants?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.invariants)) return null;
    if (!parsed.invariants.every(rule => rule && typeof rule === "object"
      && [rule.name, rule.table, rule.column].every(field => typeof field === "string")
      && ["not_null", "unique", "foreign_key"].includes(rule.type)
      && (rule.reference === undefined || rule.reference && typeof rule.reference.table === "string" && typeof rule.reference.column === "string"))) return null;
    return parsed.invariants as ProfileRule[];
  } catch { return null; }
}

export async function inspectProfile(source: string, signal?: AbortSignal): Promise<ProfileReview> {
  const bytes = new TextEncoder().encode(source);
  if (!bytes.length || bytes.length > MAX_PLAN_BYTES) throw new Error("Profile must be nonempty and within 16 KiB.");
  const response = await request("/api/v1/backups/profile", JSON.stringify({ profile: source }), signal);
  const result = await response.json() as Partial<ProfileReview> & { errors?: unknown } | null;
  if (!response.ok) {
    throw new Error(Array.isArray(result?.errors) && result.errors.every(error => typeof error === "string") ? result.errors.join("; ") : `Profile inspection HTTP ${response.status}`);
  }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (!result || result.apiVersion !== "nostekon/profile-review/v1alpha1" || result.kind !== "PostgreSQLProfileReview"
    || result.valid !== true || result.profileSHA256 !== hash || !editableRules(JSON.stringify(result))
    || ![result.tables, result.warnings, result.limitations].every(values => Array.isArray(values) && values.every(value => typeof value === "string"))) {
    throw new Error("Unsupported or mismatched profile inspection response.");
  }
  return result as ProfileReview;
}