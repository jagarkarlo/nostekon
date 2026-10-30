import { ArrowRight, Check, Download, FileArchive, FlaskConical, LoaderCircle, Play, RefreshCw, Square, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { browserDemo } from "./api";
import { maxBundleBytes } from "./evidenceBundle";
import { parseSuite } from "./labSuite";
import type { LabSuite } from "./labSuite";

interface Job {
  id: string;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  options: { writes: number; rpoSeconds: number };
  log: string;
  logTruncated: boolean;
  summary?: LabSuite;
  checkpointError?: string;
  recoveryRequired?: boolean;
  storageError?: string;
  artifacts: string[];
}

const artifactNames = ["suite.json", "zero-loss.drillrun.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"];

async function call(path: string, signal?: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetch(`/api/v1/lab${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Nostekon-Lab": "true", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(typeof payload === "object" && payload !== null && "error" in payload ? String(payload.error) : `Lab request failed (HTTP ${response.status}).`);
  return payload;
}

function readJob(payload: unknown): Job {
  if (typeof payload !== "object" || payload === null) throw new Error("Invalid lab job response.");
  const value = payload as Partial<Job>;
  if (typeof value.id !== "string" || !/^[a-f0-9]{24}$/.test(value.id) || !["running", "cancelling", "completed", "failed", "cancelled", "timed_out", "interrupted"].includes(value.status ?? "") || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.log !== "string" || typeof value.logTruncated !== "boolean" || !value.options || !Number.isInteger(value.options.writes) || value.options.writes < 1 || value.options.writes > 98 || !Number.isInteger(value.options.rpoSeconds) || value.options.rpoSeconds < 1 || value.options.rpoSeconds > 86400 || !Array.isArray(value.artifacts) || value.artifacts.some(name => !artifactNames.includes(name))) throw new Error("Invalid lab job response.");
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)))) throw new Error("Invalid job completion timestamp.");
  if ((value.recoveryRequired !== undefined && typeof value.recoveryRequired !== "boolean") || (value.storageError !== undefined && typeof value.storageError !== "string")) throw new Error("Invalid job recovery metadata.");
  let summary: LabSuite | undefined;
  let checkpointError: string | undefined;
  if (value.summary) {
    try { summary = parseSuite(JSON.stringify(value.summary)); }
    catch (reason) { checkpointError = `Could not read checkpoint: ${reason instanceof Error ? reason.message : "Invalid summary."}`; }
  }
  return { ...value, summary, checkpointError } as Job;
}

export function LabView({ active, onReview }: { active: boolean; onReview: (files: Map<string, string>) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [writes, setWrites] = useState(10);
  const [budget, setBudget] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const running = ["running", "cancelling"].includes(job?.status ?? "") || jobs.some(item => ["running", "cancelling"].includes(item.status));
  const recoveryRequired = Boolean(job?.recoveryRequired) || jobs.some(item => item.recoveryRequired);

  useEffect(() => { setCleanupConfirmed(false); }, [job?.id, job?.recoveryRequired]);

  useEffect(() => {
    if (!active) return;
    if (browserDemo) { setChecking(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const capability = await call("", controller.signal) as { enabled?: boolean };
        if (controller.signal.aborted) return;
        setEnabled(capability.enabled === true);
        setChecking(false);
        if (!capability.enabled) return;
        const payload = await call("/jobs", controller.signal);
        if (!Array.isArray(payload) || payload.length > 50) throw new Error("Invalid lab job list.");
        const list = payload.map(readJob);
        const identifier = selected || list[0]?.id;
        const current = identifier ? readJob(await call(`/jobs/${identifier}`, controller.signal)) : null;
        if (controller.signal.aborted) return;
        setJobs(list); setJob(current); setConnectionError("");
      } catch (reason) {
        if (!controller.signal.aborted) { setChecking(false); setConnectionError(reason instanceof Error ? reason.message : "Could not load lab jobs."); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, selected, refresh]);

  async function start() {
    setBusy(true); setError("");
    try {
      const created = readJob(await call("/jobs", undefined, { writes, rpoSeconds: budget }));
      setSelected(created.id); setJob(created); setRefresh(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start the suite."); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!job) return;
    setBusy(true); setError("");
    try { await call(`/jobs/${job.id}/cancel`, undefined, {}); setRefresh(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not cancel the job."); }
    finally { setBusy(false); }
  }

  async function acknowledgeRecovery() {
    if (!job || !cleanupConfirmed) return;
    setBusy(true); setError("");
    try {
      const updated = readJob(await call(`/jobs/${job.id}/acknowledge-recovery`, undefined, { cleanupConfirmed: true }));
      setJob(updated); setJobs(items => items.map(item => item.id === updated.id ? updated : item));
      setCleanupConfirmed(false); setRefresh(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not acknowledge recovery."); }
    finally { setBusy(false); }
  }

  async function readArtifact(name: string) {
    if (!job || !artifactNames.includes(name)) throw new Error("Artifact unavailable.");
    const response = await fetch(`/api/v1/lab/jobs/${job.id}/artifacts/${name}`, { headers: { "X-Nostekon-Lab": "true" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Artifact unavailable (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (blob.size > (name === "suite.json" ? 64 * 1024 : 16 * 1024 * 1024)) throw new Error("Artifact exceeds the evidence limit.");
    return blob;
  }

  async function download(name: string) {
    try {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await readArtifact(name)); link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Download failed."); }
  }

  async function exportBundle() {
    if (!job) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/lab/jobs/${job.id}/export`, { headers: { "X-Nostekon-Lab": "true" }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        const payload: unknown = await response.json();
        throw new Error(typeof payload === "object" && payload !== null && "error" in payload ? String(payload.error) : `Bundle export failed (HTTP ${response.status}).`);
      }
      if (response.headers.get("Content-Type")?.split(";")[0] !== "application/zip") throw new Error("Invalid evidence bundle response.");
      const blob = await response.blob();
      if (blob.size > maxBundleBytes) throw new Error("Evidence bundle exceeds the 49 MiB limit.");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = `nostekon-lab-${job.id}.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not export evidence."); }
    finally { setBusy(false); }
  }

  async function review() {
    if (!job) return;
    setBusy(true); setError("");
    try {
      const files = new Map<string, string>();
      for (const name of job.artifacts) files.set(name, await (await readArtifact(name)).text());
      onReview(files);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load suite evidence."); }
    finally { setBusy(false); }
  }

  return <main className="run-library lab-workspace">
    <header className="library-heading">
      <div><p className="workspace-label"><FlaskConical size={14} /> Isolated PostgreSQL</p><h1>Lab jobs</h1></div>
      <button className="icon-button" type="button" title="Refresh lab jobs" aria-label="Refresh lab jobs" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button>
    </header>
    <div className={`suite-agreement ${enabled ? "ok" : "attention"}`} role="status" aria-label="Lab availability">
      {checking ? <LoaderCircle className="spin" size={18} /> : <FlaskConical size={18} />}<strong>{checking ? "Checking execution" : enabled ? "Local execution enabled" : "Execution disabled"}</strong>
    </div>
    {(error || connectionError) && <p className="banner bad" role="alert"><XCircle size={16} />{error || connectionError}</p>}
    <form className="lab-controls" onSubmit={event => { event.preventDefault(); void start(); }}>
      <label>Writes per case<input type="number" min="1" max="98" required value={writes} disabled={!enabled || busy || running} onChange={event => setWrites(event.target.valueAsNumber)} /></label>
      <label>Tail-loss budget (seconds)<input type="number" min="1" max="86400" required value={budget} disabled={!enabled || busy || running} onChange={event => setBudget(event.target.valueAsNumber)} /></label>
      <button className="primary" type="submit" disabled={!enabled || checking || busy || running || recoveryRequired}><Play size={15} />Run suite</button>
    </form>
    {recoveryRequired && <p className="banner bad" role="alert"><XCircle size={16} />Interrupted jobs require cleanup confirmation.</p>}
    {jobs.length > 0 && <section aria-label="Lab job history"><div className="table-scroll" role="region" aria-label="Lab jobs table" tabIndex={0}><table className="runs-table lab-jobs-table">
      <thead><tr><th>Job</th><th>Status</th><th>Writes</th><th>RPO budget</th><th>Started</th></tr></thead>
      <tbody>{jobs.map(item => <tr key={item.id}><th scope="row"><button className="run-open" type="button" onClick={() => setSelected(item.id)} aria-pressed={job?.id === item.id}>{item.id.slice(0, 8)}</button></th><td data-label="Status">{item.status}</td><td data-label="Writes">{item.options.writes}</td><td data-label="RPO budget">{item.options.rpoSeconds}s</td><td data-label="Started">{new Date(item.startedAt).toLocaleString()}</td></tr>)}</tbody>
    </table></div></section>}
    {job && <section className="lab-detail" aria-label="Selected lab job">
      <div className="section-toolbar"><h2>Job {job.id.slice(0, 8)}</h2><div className="library-actions">
        <button className="tool" type="button" disabled={busy || job.status !== "running"} onClick={() => void cancel()}><Square size={15} />Cancel job</button>
        <button className="tool" type="button" disabled={busy || !job.completedAt || !job.artifacts.includes("suite.json")} onClick={() => void review()}><ArrowRight size={15} />Review suite</button>
        <button className="tool" type="button" disabled={busy || running || !job.completedAt || !!job.recoveryRequired} onClick={() => void exportBundle()}><FileArchive size={15} />Export bundle</button>
      </div></div>
      <p role="status" aria-label="Lab job status"><strong>{job.status}</strong>{job.exitCode !== undefined && ` · exit ${job.exitCode}`}</p>
      {job.checkpointError && <p className="banner bad" role="alert"><XCircle size={16} />{job.checkpointError}</p>}
      {job.storageError && <p className="banner bad" role="alert"><XCircle size={16} />History storage: {job.storageError}</p>}
      {job.recoveryRequired && <div className="lab-recovery">
        <label><input type="checkbox" checked={cleanupConfirmed} onChange={event => setCleanupConfirmed(event.target.checked)} disabled={busy} />Old runner processes stopped and lab namespaces checked</label>
        <button className="tool" type="button" disabled={busy || !cleanupConfirmed} onClick={() => void acknowledgeRecovery()}><Check size={15} />Confirm cleanup</button>
      </div>}
      {job.summary && <><progress max={3} value={job.summary.cases.filter(item => item.passed).length} aria-label="Completed policy cases" /><ol className="lab-cases">{job.summary.cases.map(item => <li key={item.name}><strong>{item.name}</strong><span>{item.passed ? "passed" : item.observedExitCode === null ? "in progress" : "needs attention"}</span></li>)}</ol></>}
      <div className="lab-artifacts">{job.artifacts.map(name => <button key={name} className="tool" type="button" onClick={() => void download(name)}><Download size={15} />{name}</button>)}</div>
      <h3>Process output{job.logTruncated ? " (latest 64 KiB)" : ""}</h3><pre className="lab-log" tabIndex={0}>{job.log || "No process output yet."}</pre>
    </section>}
  </main>;
}