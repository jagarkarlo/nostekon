import type { SavedRun } from "./runStore";

export type HistorySort = "newest" | "oldest" | "name";
export type AttachmentFilter = "all" | "plan" | "attestation" | "none";

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