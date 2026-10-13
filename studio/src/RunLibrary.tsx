import { Archive, ArchiveRestore, ArrowRight, ArrowUpRight, Database, Download, FileCheck2, FileJson, FlaskConical, GitCompareArrows, ListChecks, Paperclip, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDuration, isReport } from "./report";
import type { Report } from "./report";
import { deleteRun, evidenceLabel, listRuns, saveRuns } from "./runStore";
import type { SavedRun } from "./runStore";
import { samples } from "./samples";
import { request } from "./api";
import { createRunBackup, MAX_RUN_BACKUP_BYTES, readRunBackup } from "./runBackup";
import type { OriginalRun } from "./runBackup";

export function RunLibrary({ onOpen }: { onOpen: (source: string, sampleId: string, attestation?: string, backupPlan?: string) => void }) {
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [exampleFilter, setExampleFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SavedRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupResult, setBackupResult] = useState("");
  const [pendingRestore, setPendingRestore] = useState<OriginalRun[]>();
  const backupInput = useRef<HTMLInputElement>(null);
  const restoreDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    void listRuns().then((saved) => { if (active) setRuns(saved); })
      .catch((reason: unknown) => { if (active) setError(message(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (pendingDelete) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pendingDelete]);

  useEffect(() => {
    if (pendingRestore) restoreDialog.current?.showModal(); else restoreDialog.current?.close();
  }, [pendingRestore]);

  async function exportBackup() {
    setBackupBusy(true); setError(""); setBackupResult("");
    try { downloadOriginal("nostekon-runs.backup.json", await createRunBackup(await listRuns())); }
    catch (reason) { setError(message(reason)); }
    finally { setBackupBusy(false); }
  }

  async function inspectBackup(file: File) {
    setBackupBusy(true); setError(""); setBackupResult(""); setPendingRestore(undefined);
    try {
      if (file.size > MAX_RUN_BACKUP_BYTES) throw new Error("Run backup exceeds the 64 MiB limit.");
      setPendingRestore(await readRunBackup(await file.text()));
    } catch (reason) { setError(message(reason)); }
    finally { setBackupBusy(false); }
  }

  async function restoreBackup() {
    if (!pendingRestore || backupBusy) return;
    setBackupBusy(true); setError(""); setBackupResult("");
    try {
      const signal = AbortSignal.timeout(60000);
      const evaluated: (OriginalRun & { report: Report })[] = [];
      for (const original of pendingRestore) {
        const response = await request("/api/v1/runs/report", original.source, signal);
        if (!response.ok) throw new Error(`Backup evidence evaluation failed (HTTP ${response.status}); no runs were restored.`);
        const report: unknown = await response.json();
        if (!isReport(report)) throw new Error("Backup evaluation returned an unreadable report; no runs were restored.");
        evaluated.push({ ...original, report });
      }
      if (signal.aborted) throw new Error("Backup evaluation timed out; no runs were restored.");
      const saved = await saveRuns(evaluated);
      setRuns(await listRuns()); setPendingRestore(undefined); setSelected([]); setCompare(false);
      setBackupResult(`${saved.length} run${saved.length === 1 ? "" : "s"} restored. Recovery reports were freshly evaluated; signatures remain unchecked.`);
    } catch (reason) { setError(message(reason)); setPendingRestore(undefined); }
    finally { setBackupBusy(false); }
  }

  async function remove() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteRun(pendingDelete.id);
      setRuns((current) => current.filter((run) => run.id !== pendingDelete.id));
      setSelected((current) => current.filter((id) => id !== pendingDelete.id));
      setPendingDelete(null);
      setError("");
    } catch (reason) { setError(message(reason)); }
    finally { setDeleting(false); }
  }

  const matching = runs.filter((run) => (filter === "all" || run.report.verdict === filter) &&
    `${run.report.name} ${run.report.scenario ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const compared = selected.map((id) => runs.find((run) => run.id === id)).filter((run): run is SavedRun => !!run);
  const exampleCounts = { all: samples.length, recorded: samples.filter(sample => sample.recorded).length, synthetic: samples.filter(sample => !sample.recorded).length };
  const visibleExamples = samples.filter(sample => exampleFilter === "all" || sample.recorded === (exampleFilter === "recorded"));

  return <main className="run-library">
    <header className="library-heading">
      <div><p className="workspace-label"><Database size={14} /> Local workspace</p><h1>Recovery runs</h1></div>
      <div className="library-actions">
        <button type="button" className="icon-button" disabled={backupBusy || !runs.length} aria-label="Back up saved runs" title="Back up saved run originals" onClick={() => void exportBackup()}><Archive size={18} /></button>
        <button type="button" className="icon-button" disabled={backupBusy} aria-label="Restore run backup" title="Restore run backup" onClick={() => backupInput.current?.click()}><ArchiveRestore size={18} /></button>
        <a className="tool" href={location.pathname.startsWith("/demo/") ? "/docs/guides/k3d-isolated-restore/" : "https://github.com/jagarkarlo/nostekon/blob/main/site/src/content/docs/guides/k3d-isolated-restore.md"}><FlaskConical size={16} /> Run a lab drill <ArrowUpRight size={13} /></a>
        <button type="button" className="primary" onClick={() => fileInput.current?.click()}><Upload size={15} /> Import evidence</button>
      </div>
    </header>
    <input ref={backupInput} type="file" accept=".json,application/json" data-testid="run-backup-input" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void inspectBackup(file); }} />
    <input ref={fileInput} type="file" accept=".json,application/json" data-testid="run-evidence-input" hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > 16 * 1024 * 1024) { setError("Evidence exceeds the 16 MiB limit."); return; }
      void file.text().then((source) => onOpen(source, "")).catch((reason: unknown) => setError(message(reason)));
    }} />
    {runs.length > 0 && <section className="library-stats" aria-label="Saved run totals">
      <div><span>Saved runs</span><strong>{runs.length}</strong></div>
      <div><span>Verified</span><strong className="ok">{runs.filter((run) => run.report.verdict === "verified").length}</strong></div>
      <div><span>Needs attention</span><strong className="attention">{runs.filter((run) => run.report.verdict !== "verified").length}</strong></div>
      <div><span>With RPO evidence</span><strong>{runs.filter((run) => run.report.rpo !== null).length}</strong></div>
    </section>}
    {!loading && runs.length === 0 && <nav className="workspace-shortcuts" aria-label="Workspace shortcuts">
      <a href="#/suite"><ListChecks size={20} /><span>Review a policy suite</span><ArrowRight size={16} /></a>
      <a href="#/profiles"><FileCheck2 size={20} /><span>Author a validation profile</span><ArrowRight size={16} /></a>
    </nav>}
    {error && <p className="banner bad" role="alert">{error}</p>}
    {backupResult && <p className="banner good" role="status" aria-label="Run backup restore result">{backupResult}</p>}
    <section className="saved-runs" aria-labelledby="saved-heading">
      <div className="section-toolbar">
        <h2 id="saved-heading">Run history <span>{runs.length}</span></h2>
        {runs.length > 0 && <>
        <label className="run-search"><Search size={15} /><input type="search" placeholder="Search runs" aria-label="Search runs" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <select aria-label="Filter verdict" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All verdicts</option><option value="verified">Verified</option><option value="failed">Failed</option><option value="incomplete">Incomplete</option>
        </select>
        <button type="button" className="tool compare-action" disabled={selected.length !== 2} onClick={() => setCompare(!compare)}><GitCompareArrows size={15} /> {compare ? "Close comparison" : `Compare (${selected.length}/2)`}</button>
        </>}
      </div>
      {loading ? <p className="library-empty" role="status">Loading saved runs...</p> : matching.length === 0 ? <div className="library-empty">
        <FileJson size={25} /><h3>{runs.length ? "No matching runs" : "No saved runs yet"}</h3>
        {!runs.length && <button type="button" className="tool" onClick={() => fileInput.current?.click()}>Import a DrillRun <ArrowRight size={15} /></button>}
      </div> : <div className="table-scroll"><table className="runs-table">
        <thead><tr><th aria-label="Comparison selection" /><th>Run</th><th>Evidence</th><th>Verdict</th><th>Depth</th><th>Recovery time</th><th>Data loss</th><th aria-label="Actions" /></tr></thead>
        <tbody>{matching.map((run) => <tr key={run.id}>
          <td><input type="checkbox" aria-label={`Compare ${run.report.name}`} checked={selected.includes(run.id)} disabled={selected.length === 2 && !selected.includes(run.id)} onChange={(event) => { setCompare(false); setSelected(event.target.checked ? [...selected, run.id] : selected.filter((id) => id !== run.id)); }} /></td>
          <td><button type="button" className="run-name" onClick={() => onOpen(run.source, run.sampleId, run.attestation, run.backupPlan)}>{run.report.name}</button><small>{run.report.scenario ?? "Unspecified scenario"}</small></td>
          <td data-label="Evidence"><span className="evidence-kind">{evidenceLabel(run.sampleId)}</span>{run.attestation && <small className="attachment-label"><Paperclip size={13} aria-hidden="true" /> Attestation attached</small>}{run.backupPlan && <small className="attachment-label"><FileJson size={13} aria-hidden="true" /> Restore plan attached</small>}</td>
          <td data-label="Verdict"><span className={`verdict-tag ${run.report.verdict}`}>{run.report.verdict}</span></td>
          <td data-label="Depth" className="mono">{run.report.deepestPassed ?? "None"}</td>
          <td data-label="Recovery time" className="mono">{formatDuration(run.report.rto?.seconds)}</td>
          <td data-label="Data loss" className="mono">{formatDuration(run.report.rpo?.seconds)}</td>
          <td><button type="button" className="icon-button" title={`Download evidence for ${run.report.name}`} aria-label={`Download evidence for ${run.report.name}`} onClick={() => downloadOriginal("nostekon.run.json", run.source)}><Download size={15} /></button>{run.attestation && <button type="button" className="icon-button" title={`Download attestation for ${run.report.name}`} aria-label={`Download attestation for ${run.report.name}`} onClick={() => downloadOriginal("nostekon.run.attestation.json", run.attestation!)}><Paperclip size={15} /></button>}{run.backupPlan && <button type="button" className="icon-button" title={`Download restore plan for ${run.report.name}`} aria-label={`Download restore plan for ${run.report.name}`} onClick={() => downloadOriginal("nostekon.restore-plan.json", run.backupPlan!)}><FileJson size={15} /></button>}<button type="button" className="icon-button" title={`Delete ${run.report.name}`} aria-label={`Delete ${run.report.name}`} onClick={() => setPendingDelete(run)}><Trash2 size={15} /></button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    {compare && compared.length === 2 && <RunComparison runs={compared} onClose={() => setCompare(false)} />}
    <section className="sample-section" aria-labelledby="examples-heading">
      <div className="section-toolbar"><h2 id="examples-heading">Example evidence</h2><div className="example-filter" role="group" aria-label="Example source">
        {([{ id: "all", label: "All examples" }, { id: "recorded", label: "Recorded lab" }, { id: "synthetic", label: "Synthetic" }] as const).map(option => <button type="button" key={option.id} aria-label={option.label} aria-pressed={exampleFilter === option.id} onClick={() => setExampleFilter(option.id)}>{option.label}<span aria-hidden="true">{exampleCounts[option.id]}</span></button>)}
      </div></div>
      <div className="sample-rows">{visibleExamples.map((sample) => <button type="button" key={sample.id} onClick={() => {
        void sample.load().then((source) => onOpen(source, sample.id)).catch((reason: unknown) => setError(message(reason)));
      }}><span className={`sample-symbol ${sample.recorded ? "recorded" : ""}`}>{sample.recorded ? <Database size={20} /> : <FlaskConical size={20} />}</span><span className="sample-copy"><strong>{sample.label}</strong><small>{sample.summary}</small></span><ArrowRight size={17} /></button>)}</div>
    </section>
    <dialog ref={restoreDialog} className="delete-dialog" aria-labelledby="restore-title" onCancel={event => { if (backupBusy) event.preventDefault(); else setPendingRestore(undefined); }}>
      <h2 id="restore-title">Restore {pendingRestore?.length ?? 0} saved runs?</h2>
      <p>Existing copies with matching evidence may be updated. Keys and trust settings are not part of this backup.</p>
      <div className="library-actions"><button type="button" className="tool" disabled={backupBusy} onClick={() => setPendingRestore(undefined)}>Cancel restore</button><button type="button" className="primary" disabled={backupBusy} onClick={() => void restoreBackup()}><ArchiveRestore size={15} /> {backupBusy ? "Evaluating..." : "Confirm restore"}</button></div>
    </dialog>
    <dialog ref={dialog} className="delete-dialog" onCancel={() => setPendingDelete(null)}>
      <h2>Delete saved run?</h2><p>{pendingDelete?.report.name}</p><p>This removes the browser copy. Export any evidence you need before deleting.</p>
      <div className="library-actions"><button className="tool" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</button><button className="primary danger" type="button" disabled={deleting} onClick={() => void remove()}><Trash2 size={15} /> {deleting ? "Deleting..." : "Delete run"}</button></div>
    </dialog>
  </main>;
}

function RunComparison({ runs, onClose }: { runs: SavedRun[]; onClose: () => void }) {
  const [baseline, candidate] = runs.map((run) => run.report);
  const sameScenario = !!baseline.scenario && baseline.scenario === candidate.scenario && baseline.requestedLevel === candidate.requestedLevel;
  const differentObjectives = (baseline.rto?.objectiveSeconds ?? null) !== (candidate.rto?.objectiveSeconds ?? null)
    || (baseline.rpo?.objectiveSeconds ?? null) !== (candidate.rpo?.objectiveSeconds ?? null);
  const rows = [
    ["Verdict", baseline.verdict, candidate.verdict],
    ["Depth reached", baseline.deepestPassed ?? "None", candidate.deepestPassed ?? "None"],
    ["RTO objective", formatDuration(baseline.rto?.objectiveSeconds), formatDuration(candidate.rto?.objectiveSeconds)],
    ["Recovery time", formatDuration(baseline.rto?.seconds), formatDuration(candidate.rto?.seconds)],
    ["RPO objective", formatDuration(baseline.rpo?.objectiveSeconds), formatDuration(candidate.rpo?.objectiveSeconds)],
    ["Data loss window", formatDuration(baseline.rpo?.seconds), formatDuration(candidate.rpo?.seconds)],
    ["Acknowledged writes lost", baseline.rpo?.lost ?? "Unmeasured", candidate.rpo?.lost ?? "Unmeasured"],
    ...["V0", "V1", "V2", "V3", "V4"].map((id) => [id, baseline.levels.find((level) => level.id === id)?.status ?? "not-checked", candidate.levels.find((level) => level.id === id)?.status ?? "not-checked"]),
  ];
  return <section className="run-comparison" aria-label="Run comparison">
    <div className="section-toolbar"><h2>Run comparison</h2><button className="icon-button" type="button" aria-label="Close comparison" title="Close comparison" onClick={onClose}><X size={17} /></button></div>
    {!sameScenario && <p className="comparison-notice">Different scenarios or requested depths. Timing is not a like-for-like comparison.</p>}
    {differentObjectives && <p className="comparison-notice">Different recovery objectives. Verdicts use different policies.</p>}
    <div className="table-scroll"><table className="runs-table comparison-table"><thead><tr><th>Measure</th>{runs.map((run) => <th key={run.id}>{run.report.name}<small>{evidenceLabel(run.sampleId)}</small></th>)}</tr></thead><tbody>{rows.map(([label, first, second]) => <tr key={label}><th>{label}</th><td>{first}</td><td className={first !== second ? "changed" : ""}>{second}</td></tr>)}</tbody></table></div>
  </section>;
}

function message(reason: unknown) { return reason instanceof Error ? reason.message : "Could not access browser storage."; }

function downloadOriginal(name: string, source: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([source], { type: "application/json" }));
  link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}