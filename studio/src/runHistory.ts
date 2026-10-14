import type { SavedRun } from "./runStore";

export type HistorySort = "newest" | "oldest" | "name";

export function sortRuns(runs: readonly SavedRun[], order: HistorySort): SavedRun[] {
  return [...runs].sort((left, right) => {
    const difference = order === "name"
      ? left.report.name.localeCompare(right.report.name, "en", { numeric: true, sensitivity: "base" })
      : order === "oldest" ? left.savedAt - right.savedAt : right.savedAt - left.savedAt;
    return difference || left.id.localeCompare(right.id);
  });
}