import type { SavedRun } from "./runStore";
import type { Report } from "./report";
import type { OriginalRun } from "./runBackup";

export type HistorySort = "newest" | "oldest" | "name";
export type AttachmentFilter = "all" | "plan" | "attestation" | "none";
type AttachmentState = "included" | "preserved" | "none";
export interface RestorePreview { id: string; name: string; existing: boolean; attestation: AttachmentState; backupPlan: AttachmentState }

export async function previewRunRestore(originals: readonly OriginalRun[], saved: readonly SavedRun[]): Promise<RestorePreview[]> {
  const available = new Map(saved.map(run => [run.id, run]));
  const previews: RestorePreview[] = [];
  for (const original of originals) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original.source));
    const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const existing = available.get(id);
    const value = JSON.parse(original.source) as { metadata?: { name?: unknown } };
    const name = typeof value.metadata?.name === "string" && value.metadata.name.trim() ? value.metadata.name.slice(0, 160) : "Unnamed original";
    const state = (field: "attestation" | "backupPlan"): AttachmentState => original[field] ? "included" : existing?.[field] ? "preserved" : "none";
    previews.push({ id, name, existing: !!existing, attestation: state("attestation"), backupPlan: state("backupPlan") });
  }
  return previews;
}

export function selectedRuns(runs: readonly SavedRun[], identities: readonly string[]): SavedRun[] {
  if (!identities.length) throw new Error("Select at least one saved run.");
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate run selection.");
  const available = new Map(runs.map(run => [run.id, run]));
  return identities.map(identity => {
    const run = available.get(identity);
    if (!run) throw new Error("A selected run is no longer available. Refresh the library before exporting.");
    return run;
  });
}

export function comparisonWarnings(baseline: Report, candidate: Report): string[] {
  const warnings: string[] = [];
  if (!baseline.scenario || baseline.scenario !== candidate.scenario) warnings.push("Different or unknown scenarios. Timing is not a like-for-like comparison.");
  if (!baseline.requestedLevel || !candidate.requestedLevel || baseline.requestedLevel !== candidate.requestedLevel) warnings.push("Different requested verification depths.");
  if ((baseline.rto?.objectiveSeconds ?? null) !== (candidate.rto?.objectiveSeconds ?? null)
    || (baseline.rpo?.objectiveSeconds ?? null) !== (candidate.rpo?.objectiveSeconds ?? null)) warnings.push("Different recovery objectives. Verdicts use different policies.");
  if (!baseline.rto || !candidate.rto) warnings.push("Recovery timing is missing from one or both runs.");
  if (!baseline.rpo || !candidate.rpo) warnings.push("Acknowledged-write evidence is missing from one or both runs.");
  return warnings;
}

export function filterRuns(runs: readonly SavedRun[], filters: { query: string; verdict: string; attachment: AttachmentFilter }): SavedRun[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter(run => {
    const text = `${run.report.name} ${run.report.scenario ?? ""} ${run.report.drill ?? ""}`.toLowerCase();
    const attached = filters.attachment === "all" || (filters.attachment === "plan" ? !!run.backupPlan
      : filters.attachment === "attestation" ? !!run.attestation : !run.backupPlan && !run.attestation);
    return attached && (filters.verdict === "all" || run.report.verdict === filters.verdict) && terms.every(term => text.includes(term));
  });
}

export function sortRuns(runs: readonly SavedRun[], order: HistorySort): SavedRun[] {
  return [...runs].sort((left, right) => {
    const difference = order === "name"
      ? left.report.name.localeCompare(right.report.name, "en", { numeric: true, sensitivity: "base" })
      : order === "oldest" ? left.savedAt - right.savedAt : right.savedAt - left.savedAt;
    return difference || left.id.localeCompare(right.id);
  });
}