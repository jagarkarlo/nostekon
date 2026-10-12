export type Verdict = "verified" | "failed" | "incomplete";
export type LevelStatus = "passed" | "failed" | "not-checked";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
  source: "reported" | "ledger";
}

export interface LevelResult {
  id: string;
  question: string;
  evidence: string;
  status: LevelStatus;
  inScope: boolean;
  checks: CheckResult[];
}

export interface PhaseResult {
  name: string;
  startedAt: string;
  endedAt: string;
  offsetSeconds: number;
  durationSeconds: number;
}

export interface RTOResult {
  seconds: number;
  objectiveSeconds: number | null;
  met: boolean | null;
  uncoveredSeconds: number;
  slowestPhase: string;
  phases: PhaseResult[];
  completedAt: string;
}

export interface LedgerBucket {
  offsetSeconds: number;
  recovered: number;
  lost: number;
}

export interface RPOResult {
  seconds: number;
  objectiveSeconds: number | null;
  met: boolean | null;
  acknowledged: number;
  recovered: number;
  lost: number;
  holes: number;
  unexpected: number;
  consistent: boolean;
  recoveryPoint: string | null;
  firstLostAt: string | null;
  resolutionSeconds: number | null;
  timeline: LedgerBucket[];
}

export interface Finding {
  severity: "error" | "warning" | "info";
  message: string;
}

export interface Provenance {
  status: "verified" | "unverified";
  algorithm?: string;
  keyId?: string;
  evidenceSHA256?: string;
}

export interface Report {
  name: string;
  drill?: string;
  scenario?: string;
  verdict: Verdict;
  headline: string;
  requestedLevel: string;
  deepestPassed: string | null;
  firstFailed: string | null;
  failureAt: string;
  levels: LevelResult[];
  rto: RTOResult | null;
  rpo: RPOResult | null;
  provenance?: Provenance;
  findings: Finding[];
}

export function isReport(value: unknown): value is Report {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<Report>;
  return (
    typeof report.name === "string" &&
    (report.verdict === "verified" || report.verdict === "failed" || report.verdict === "incomplete") &&
    Array.isArray(report.levels) &&
    Array.isArray(report.findings)
  );
}

/** Compact human duration: 38s, 11m 43s, 1h 02m. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return rest ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${minutes}m`;
  return `${rest}s`;
}

/** Share of the objective used, capped for display; null when no objective is set. */
export function objectiveUsage(measured: number, objective: number | null): number | null {
  if (objective === null || objective <= 0) return null;
  return Math.min(measured / objective, 1.5);
}

export interface TimelineBar {
  name: string;
  left: number;
  width: number;
  durationSeconds: number;
  slowest: boolean;
}

/** Positions phases as percentages of a scale covering the recovery and its objective. */
export function timelineBars(rto: RTOResult): {
  bars: TimelineBar[];
  scaleSeconds: number;
  objectiveAt: number | null;
  failureAt: number;
  failureOffsetSeconds: number;
} {
  const failureOffsetSeconds = Math.max(0, ...rto.phases.map((phase) => -phase.offsetSeconds));
  const scaleSeconds = Math.max(failureOffsetSeconds + rto.seconds, failureOffsetSeconds + (rto.objectiveSeconds ?? 0), 1) * 1.04;
  const bars = rto.phases.map((phase) => ({
    name: phase.name,
    left: ((failureOffsetSeconds + phase.offsetSeconds) / scaleSeconds) * 100,
    width: Math.max((phase.durationSeconds / scaleSeconds) * 100, 0.6),
    durationSeconds: phase.durationSeconds,
    slowest: phase.name === rto.slowestPhase,
  }));
  const objectiveAt = rto.objectiveSeconds === null ? null : ((failureOffsetSeconds + rto.objectiveSeconds) / scaleSeconds) * 100;
  return { bars, scaleSeconds, objectiveAt, failureAt: (failureOffsetSeconds / scaleSeconds) * 100, failureOffsetSeconds };
}

const statusMark: Record<LevelStatus, string> = { passed: "PASS", failed: "FAIL", "not-checked": "—" };

/** A Markdown evidence summary suitable for a change record or audit trail. */
export function reportMarkdown(report: Report): string {
  const rehearsal = report.scenario === "postgresql-backup-rehearsal";
  const offsetLabel = (seconds: number): string => {
    const offset = Math.round(seconds);
    return offset < 0 ? `−${formatDuration(-offset)}` : `+${formatDuration(offset)}`;
  };
  const lines = [
    `# Restore drill report: ${report.name}`,
    "",
    `**Verdict:** ${report.verdict.toUpperCase()}. ${report.headline}.`,
    "",
    `- Drill: ${report.drill || "—"} (${report.scenario || "unspecified scenario"})`,
    `- ${rehearsal ? "Rehearsal started" : "Failure injected"}: ${report.failureAt}`,
    `- Requested depth: ${report.requestedLevel}; deepest passed: ${report.deepestPassed ?? "none"}; first failed: ${report.firstFailed ?? "none"}`,
    `- Evidence provenance: ${report.provenance?.status ?? "unverified"}${report.provenance?.keyId ? ` (${report.provenance.keyId})` : ""}`,
  ];
  if (report.rto) {
    const objective = report.rto.objectiveSeconds === null ? "no objective" : `objective ${formatDuration(report.rto.objectiveSeconds)}`;
    lines.push(`- ${rehearsal ? "Rehearsal duration" : "RTO"}: ${formatDuration(report.rto.seconds)} (${objective}); slowest phase ${report.rto.slowestPhase}`);
  }
  if (report.rpo) {
    const objective = report.rpo.objectiveSeconds === null ? "no objective" : `objective ${formatDuration(report.rpo.objectiveSeconds)}`;
    lines.push(
      `- RPO: ${formatDuration(report.rpo.seconds)} (${objective}); ${report.rpo.lost} of ${report.rpo.acknowledged} acknowledged writes lost, ${report.rpo.holes} holes`,
    );
  }
  lines.push("", "| Level | Question | Result | Checks |", "| --- | --- | --- | --- |");
  for (const level of report.levels) {
    const checks = level.checks.map((check) => `${check.passed ? "✓" : "✗"} ${check.name}`).join("; ") || "not checked";
    lines.push(`| ${level.id}${level.inScope ? "" : " (out of scope)"} | ${level.question} | ${statusMark[level.status]} | ${checks.replaceAll("|", "\\|")} |`);
  }
  if (rehearsal) {
    const binding = report.levels.flatMap(level => level.checks).find(check => check.name === "Restore plan binding");
    if (binding?.detail) lines.push("", "## Restore Plan Binding", "", binding.detail);
    const semanticChecks = report.levels.find(level => level.id === "V4" && level.inScope)?.checks.filter(check => check.source === "reported") ?? [];
    if (semanticChecks.length > 0) {
      const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll(/[\r\n]/g, " ");
      lines.push("", "## Reported V4 Checks", "", "| Check | Result | Detail |", "| --- | --- | --- |");
      for (const check of semanticChecks) {
        lines.push(`| ${cell(check.name)} | ${check.passed ? "PASS" : "FAIL"} | ${cell(check.detail ?? "No detail reported")} |`);
      }
    }
  }
  if (report.rto && report.rto.phases.length > 0) {
    lines.push("", "| Phase | Starts at | Duration |", "| --- | --- | --- |");
    for (const phase of report.rto.phases) {
      lines.push(`| ${phase.name} | ${offsetLabel(phase.offsetSeconds)} | ${formatDuration(phase.durationSeconds)} |`);
    }
  }
  if (report.findings.length > 0) {
    lines.push("", "## Findings", "");
    for (const finding of report.findings) lines.push(`- **${finding.severity}:** ${finding.message}`);
  }
  lines.push("", "_Generated by Nostekon Studio from the drill evidence; the report is only as trustworthy as that evidence._", "");
  return lines.join("\n");
}
