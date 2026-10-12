import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
  Info,
  LoaderCircle,
  Play,
  Save,
  ShieldAlert,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserDemo, request } from "./api";
import { BackupWorkbench } from "./BackupWorkbench";
import { readOriginalJSON } from "./backupReview";
import { TrustWorkbench } from "./TrustWorkbench";
import { CodeEditor } from "./CodeEditor";
import type { CodeEditorHandle } from "./CodeEditor";
import { fieldPathOf, inspectJSON, locateField, scenarioLabels } from "./drill";
import { formatDuration, isReport, objectiveUsage, reportMarkdown, timelineBars } from "./report";
import type { LevelResult, Report, RPOResult, RTOResult } from "./report";
import { saveRun } from "./runStore";
import { announcePolicyChange, listKeys, saveKey } from "./keyStore";
import { MAX_SIGNED_ARCHIVE_BYTES, readSignedArchive } from "./signedArchive";
import { isRecordedSample, samples } from "./samples";

const verdictLabel = { verified: "Verified", failed: "Failed", incomplete: "Incomplete" } as const;

function download(name: string, text: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function ReportView({ onReachability, selection }: { onReachability: (online: boolean) => void; selection?: { source: string; sampleId: string; attestation?: string; backupPlan?: string } }) {
  const [source, setSource] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [builtFrom, setBuiltFrom] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [requestError, setRequestError] = useState("");
  const [isBuilding, setIsBuilding] = useState(false);
  const [tab, setTab] = useState<"report" | "evidence" | "plan">("report");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const saveRevision = useRef(0);
  const [backupPlan, setBackupPlan] = useState({ text: "", name: "" });
  const editorRef = useRef<CodeEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attestation, setAttestation] = useState("");
  const [attestationName, setAttestationName] = useState("");
  const attestationInputRef = useRef<HTMLInputElement>(null);
  const signedInputRef = useRef<HTMLInputElement>(null);
  const [importingArchive, setImportingArchive] = useState(false);
  const [archiveResult, setArchiveResult] = useState("");
  const [importedKey, setImportedKey] = useState<{ id: string }>();
  const inspection = useMemo(() => inspectJSON(source), [source]);

  const build = useCallback(
    async (text: string, current = ++generation.current, serverAttestation = "", showReport = true) => {
      saveRevision.current++;
      setIsBuilding(true);
      setRequestError("");
      setSaved(false);
      try {
        const headers = serverAttestation ? { "X-Nostekon-Attestation": btoa(String.fromCharCode(...new TextEncoder().encode(serverAttestation))) } : undefined;
        const response = await request("/api/v1/runs/report", text, undefined, headers);
        const payload: unknown = await response.json();
        if (current !== generation.current) return;
        onReachability(true);
        if (response.ok && isReport(payload)) {
          setReport(payload);
          setBuiltFrom(text);
          setProblems([]);
          if (showReport) setTab("report");
          return;
        }
        const errors = (payload as { errors?: unknown }).errors;
        setProblems(Array.isArray(errors) ? errors.filter((item): item is string => typeof item === "string") : [`HTTP ${response.status}`]);
        if (showReport) setTab("evidence");
      } catch (error) {
        if (current !== generation.current) return;
        onReachability(false);
        setRequestError(error instanceof Error ? error.message : "Could not reach the Nostekon API.");
      } finally {
        if (current === generation.current) setIsBuilding(false);
      }
    },
    [onReachability],
  );

  const loadSample = useCallback(
    async (id: string) => {
      const sample = samples.find((item) => item.id === id);
      if (!sample) return;
      const current = ++generation.current;
      try {
        const text = await sample.load();
        if (current !== generation.current) return;
        setSourceError("");
        setSource(text);
        setSampleId(id);
        setArchiveResult("");
        setImportedKey(undefined);
        setAttestation("");
        setAttestationName("");
        setBackupPlan({ text: "", name: "" });
        await build(text, current);
      } catch (error) { if (current === generation.current) setSourceError(String(error)); }
    },
    [build],
  );

  useEffect(() => {
    if (selection) {
      setBackupPlan({ text: selection.backupPlan ?? "", name: selection.backupPlan ? "Saved original restore plan" : "" });
      setAttestation(selection.attestation ?? "");
      setAttestationName(selection.attestation ? "Saved original attestation" : "");
      setSource(selection.source);
      setArchiveResult("");
      setImportedKey(undefined);
      if (selection.attestation) {
        try {
          const keyId: unknown = JSON.parse(selection.attestation).keyId;
          if (typeof keyId === "string" && /^[a-f0-9]{64}$/.test(keyId)) setImportedKey({ id: keyId });
        } catch {}
      }
      setSampleId(selection.sampleId);
      setSourceError("");
      void build(selection.source);
    } else if (samples.length > 0) void loadSample("k3d-postgresql");
    return () => { generation.current++; };
  }, [loadSample, build, selection]);

  function jumpTo(message: string) {
    const path = fieldPathOf(message);
    if (!path) return;
    setTab("evidence");
    const offset = locateField(source, path);
    if (offset >= 0) window.setTimeout(() => editorRef.current?.focusAt(offset), 0);
  }

  async function copyMarkdown() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(reportMarkdown(report));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setSourceError("Clipboard access denied. Download the Markdown report instead."); }
  }

  async function save() {
    if (!report || stale) return;
    setSaving(true);
    const current = saveRevision.current;
    try { await saveRun(builtFrom, report, sampleId, attestation, backupPlan.text); if (current === saveRevision.current) { setSaved(true); setSourceError(""); } }
    catch (error) { setSourceError(error instanceof Error ? error.message : "Browser storage is unavailable."); }
    finally { setSaving(false); }
  }

  async function importSignedArchive(file: File) {
    if (importingArchive) return;
    const current = ++generation.current;
    setImportingArchive(true); setIsBuilding(false);
    setSource(""); setReport(null); setBuiltFrom(""); setSampleId("");
    setAttestation(""); setAttestationName(""); setImportedKey(undefined);
    setBackupPlan({ text: "", name: "" }); saveRevision.current++;
    setArchiveResult(""); setSourceError(""); setRequestError(""); setProblems([]); setSaved(false);
    try {
      if (file.size > MAX_SIGNED_ARCHIVE_BYTES) throw new Error("Signed archive exceeds the 17 MiB limit.");
      const originals = readSignedArchive(new Uint8Array(await file.arrayBuffer()));
      if (current !== generation.current) return;
      const response = await request("/api/v1/attestations/key", originals.publicKey, AbortSignal.timeout(10000), { "Content-Type": "application/x-pem-file" });
      const key = await response.json();
      if (!response.ok || key.algorithm !== "Ed25519" || typeof key.keyId !== "string" || !/^[a-f0-9]{64}$/.test(key.keyId)) throw new Error(key.errors?.join("; ") || "Could not inspect the archive's public key.");
      if (current !== generation.current) return;
      const existing = (await listKeys()).find(saved => saved.id === key.keyId);
      if (current !== generation.current) return;
      await saveKey(key.keyId, originals.publicKey, existing?.label ?? `Archive key ${key.keyId.slice(0, 12)}`);
      announcePolicyChange();
      if (current !== generation.current) return;
      setSource(originals.evidence); setAttestation(originals.attestation);
      setAttestationName("nostekon.run.attestation.json"); setImportedKey({ id: key.keyId });
      await build(originals.evidence, current);
      if (current === generation.current) setArchiveResult("Signed archive imported · bundled receipt discarded.");
    } catch (reason) {
      if (current === generation.current) setSourceError(reason instanceof Error ? reason.message : "Could not import the signed archive.");
    } finally { setImportingArchive(false); }
  }

  const stale = report !== null && builtFrom !== source;
  const recordedSample = isRecordedSample(sampleId);

  return (
    <div className="layout report-layout">
      <aside className="rail" aria-label="Drill evidence">
        <h2 className="rail-title">Example drill runs</h2>
        <ul className="template-list">
          {samples.map((sample) => (
            <li key={sample.id}>
              <button
                type="button"
                className={`template ${sampleId === sample.id ? "active" : ""}`}
                aria-pressed={sampleId === sample.id}
                disabled={importingArchive}
                onClick={() => void loadSample(sample.id)}
              >
                <span className="template-label">{sample.label}</span>
                <span className="template-summary">{sample.summary}</span>
              </button>
            </li>
          ))}
        </ul>
        {sampleId && (
          <div className="sample-caveat">
            <AlertTriangle size={14} />
            <p><strong>{recordedSample ? "Recorded local lab run" : "Illustrative evidence"}</strong>{recordedSample ? "This file came from a disposable local PostgreSQL restore. It is runner-reported, not cryptographically attested or production data." : "These traces are synthetic examples. They are not recorded from a real restore or production cluster."}</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          data-testid="evidence-input"
          disabled={importingArchive}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && file.size > 16 * 1024 * 1024) {
              setSourceError("DrillRun exceeds the API's 16 MiB request limit.");
              return;
            }
            if (file) {
              const current = ++generation.current;
              setIsBuilding(false);
              void readOriginalJSON(file, 16 * 1024 * 1024).then((text) => {
                if (current !== generation.current) return;
                setSourceError("");
                setSource(text);
                setSampleId("");
                setArchiveResult(""); setImportedKey(undefined);
                setAttestation("");
                setAttestationName("");
                void build(text, current);
              }).catch(reason => { if (current === generation.current) setSourceError(reason instanceof Error ? reason.message : "Could not read the selected file."); });
            }
          }}
        />
        <input
          ref={attestationInputRef}
          type="file"
          accept=".attestation.json,application/json"
          data-testid="attestation-input"
          disabled={importingArchive}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setArchiveResult(""); setImportedKey(undefined);
            setAttestation("");
            setAttestationName("");
            if (source) void build(source);
            if (file.size > 16 * 1024) {
              setSourceError("Attestation sidecar exceeds the 16 KiB limit.");
              return;
            }
            void file.text().then((text) => {
              try {
                JSON.parse(text);
              } catch {
                setSourceError("Attestation sidecar must be valid JSON.");
                return;
              }
              setSourceError("");
              setAttestation(text);
              saveRevision.current++;
              setSaved(false);
              setAttestationName(file.name);
            }).catch(() => setSourceError("Could not read the attestation sidecar."));
          }}
        />
        <input ref={signedInputRef} type="file" accept=".zip,application/zip" hidden disabled={importingArchive} data-testid="signed-originals-input" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) void importSignedArchive(file);
        }} />
        <button className="rail-action" type="button" disabled={importingArchive} onClick={() => signedInputRef.current?.click()}>
          {importingArchive ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />} Import signed archive
        </button>
        <button className="rail-action" type="button" disabled={importingArchive} onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} /> Import DrillRun JSON
        </button>
        <a className="rail-action" href="#/runs">Saved runs</a>
      </aside>

      <section className="report-main" aria-label="Drill report">
        <div className="report-tabs" role="tablist" aria-label="Report views">
              <button type="button" role="tab" aria-selected={tab === "report"} onClick={() => setTab("report")}>
            Report
          </button>
              <button type="button" role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>
            Evidence JSON {problems.length > 0 && <span className="tab-badge">{problems.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Plan review</button>
          <div className="report-actions">
            {stale && <span className="stale-inline">Evidence edited</span>}
            <button className="tool" type="button" disabled={!report || stale || isBuilding || importingArchive || saving || saved} onClick={() => void save()} title="Save original evidence, attached plan and attestation in this browser"><Save size={15} /> {saved ? "Saved" : saving ? "Saving..." : "Save run"}</button>
            <button className="icon-button" type="button" disabled={!source} aria-label="Download original evidence" title="Download original DrillRun evidence" onClick={() => download("nostekon.run.json", source, "application/json")}><Download size={15} /></button>
            <button className="primary" type="button" disabled={isBuilding || !inspection.ok || source.length === 0} onClick={() => void build(source)}>
              {isBuilding ? <LoaderCircle className="spin" size={15} /> : <Play size={14} fill="currentColor" />}
              {isBuilding ? "Building…" : "Build report"}
            </button>
          </div>
        </div>

        {requestError && (
          <div className="banner bad">
            <XCircle size={15} /> {requestError}
          </div>
        )}
        <TrustWorkbench evidence={source} attestation={attestation} importedKey={importedKey} disabled={!source || stale || isBuilding || importingArchive} onAttach={() => attestationInputRef.current?.click()} onRemove={() => { setAttestation(""); setAttestationName(""); setArchiveResult(""); void build(source); }} onServerVerify={browserDemo ? undefined : () => void build(source, undefined, attestation)} />
        {archiveResult && <p className="workspace-label" role="status" aria-label="Signed archive import">{archiveResult}</p>}
        {attestationName && <p className="workspace-label">{attestationName}</p>}
        {sourceError && <div className="banner bad" role="alert"><XCircle size={15} /> {sourceError}</div>}

        <div hidden={tab !== "plan"}>
          <BackupWorkbench evidence={source} plan={backupPlan} onPlanChange={plan => { saveRevision.current++; setBackupPlan(plan); setSaved(false); }} onImport={text => {
            setSource(text); setSampleId(""); setSourceError(""); setAttestation(""); setAttestationName(""); setArchiveResult(""); setImportedKey(undefined);
            void build(text, undefined, "", false);
          }} />
        </div>

        {tab === "plan" ? null : tab === "evidence" ? (
          <div className="evidence-pane">
            {problems.length > 0 && (
              <ul className="findings evidence-problems">
                {problems.map((message, index) => (
                  <li key={index}>
                    <button type="button" className="finding error" onClick={() => jumpTo(message)}>
                      <XCircle size={13} /> <span>{message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="editor-pane">
              <CodeEditor
                ref={editorRef}
                value={source}
                errorLine={inspection.ok ? null : inspection.line}
                onChange={(text) => { generation.current++; setIsBuilding(false); setSource(text); setSampleId(""); setAttestation(""); setAttestationName(""); setArchiveResult(""); setImportedKey(undefined); setSaved(false); }}
                onSubmit={() => void build(source)}
              />
            </div>
          </div>
        ) : report ? (
          <ReportBody report={report} onCopy={() => void copyMarkdown()} copied={copied} />
        ) : (
          <div className="empty-report">
            <CircleDashed size={22} />
            <strong>No report yet</strong>
            <p>Choose an example run or import a DrillRun document.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ReportBody({ report, onCopy, copied }: { report: Report; onCopy: () => void; copied: boolean }) {
  const rehearsal = report.scenario === "postgresql-backup-rehearsal";
  const initial = report.firstFailed ?? report.deepestPassed ?? "V0";
  const [selected, setSelected] = useState(initial);
  useEffect(() => setSelected(initial), [initial, report]);
  const level = report.levels.find((item) => item.id === selected) ?? report.levels[0];

  return (
    <div className="report-body">
      <section className={`verdict ${report.verdict}`} aria-live="polite">
        <div className="verdict-mark">
          {report.verdict === "verified" ? <CheckCircle2 size={26} /> : report.verdict === "failed" ? <XCircle size={26} /> : <CircleDashed size={26} />}
        </div>
        <div className="verdict-copy">
          <span className="eyebrow">
            {verdictLabel[report.verdict]} · {scenarioLabels[report.scenario ?? ""] ?? report.scenario ?? "drill"}
          </span>
          <h2>{report.headline}</h2>
          <p className="mono-meta">{report.name}</p>
          <div className={`provenance-status ${report.provenance?.status ?? "unverified"}`} role="status" aria-label="Evidence provenance">
            {report.provenance?.status === "verified" ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />}
            <span>{report.provenance?.status === "verified" ? `${report.provenance.algorithm ?? "Signature"} verified · server-trusted key` : "Server signature unverified"}</span>
            {report.provenance?.keyId && <code title={report.provenance.keyId}>key {report.provenance.keyId.slice(0, 16)}</code>}
          </div>
        </div>
        <div className="verdict-actions">
          <button className="tool" type="button" title="Download the computed report as JSON" onClick={() => download(`${report.name}.report.json`, JSON.stringify(report, null, 2), "application/json")}>
            <FileJson size={14} /> <span>JSON</span>
          </button>
          <button className="tool" type="button" title="Download the evidence summary as Markdown" onClick={() => download(`${report.name}.report.md`, reportMarkdown(report), "text/markdown")}>
            <FileText size={14} /> <span>Markdown</span>
          </button>
          <button className="tool" type="button" title="Copy the evidence summary as Markdown" onClick={onCopy}>
            <ClipboardCopy size={14} /> <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </section>

      {rehearsal && <div className="banner" role="status" aria-label="Backup rehearsal scope">Backup rehearsal timing, not incident RTO. Selected checks do not prove complete application consistency or production readiness.</div>}
      <div className="metrics">
        <Metric label={rehearsal ? "Rehearsal duration" : "Recovery time"} value={formatDuration(report.rto?.seconds)} objective={report.rto?.objectiveSeconds ?? null} measured={report.rto?.seconds ?? null} met={report.rto?.met ?? null} />
        <Metric label="Data loss window" value={report.rpo ? formatDuration(report.rpo.seconds) : "—"} objective={report.rpo?.objectiveSeconds ?? null} measured={report.rpo?.seconds ?? null} met={report.rpo?.met ?? null} />
        <div className="metric">
          <span className="metric-label">Writes lost</span>
          <strong className="metric-value">{report.rpo ? report.rpo.lost.toLocaleString() : "—"}</strong>
          <span className="metric-sub">{report.rpo ? `of ${report.rpo.acknowledged.toLocaleString()} acknowledged · ${report.rpo.holes} holes` : "no write ledger"}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Depth reached</span>
          <strong className="metric-value">{report.deepestPassed ?? "none"}</strong>
          <span className="metric-sub">requested {report.requestedLevel}</span>
        </div>
      </div>

      <section className="panel">
        <header className="panel-head">
          <h3>Verification depth</h3>
        </header>
        <ol className="level-track">
          {report.levels.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`level-node ${item.status} ${item.inScope ? "" : "out-of-scope"} ${selected === item.id ? "selected" : ""}`}
                onClick={() => setSelected(item.id)}
                aria-pressed={selected === item.id}
              >
                <span className="level-id">{item.id}</span>
                <span className="level-state">{item.status === "not-checked" ? "not checked" : item.status}</span>
              </button>
            </li>
          ))}
        </ol>
        <LevelDetail level={level} />
      </section>

      {report.rto && <PhaseTimeline rto={report.rto} rehearsal={rehearsal} />}
      {report.rpo && <LedgerChart rpo={report.rpo} failureAt={report.failureAt} />}

      {report.findings.length > 0 && (
        <section className="panel">
          <header className="panel-head">
            <h3>Findings</h3>
            <span className="card-sub">{report.findings.length} total</span>
          </header>
          <ul className="findings">
            {report.findings.map((finding, index) => (
              <li key={index} className={`finding ${finding.severity}`}>
                {finding.severity === "error" ? <XCircle size={13} /> : finding.severity === "warning" ? <AlertTriangle size={13} /> : <Info size={13} />}
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, objective, measured, met }: { label: string; value: string; objective: number | null; measured: number | null; met: boolean | null }) {
  const usage = measured === null ? null : objectiveUsage(measured, objective);
  return (
    <div className={`metric ${met === false ? "missed" : met ? "met" : ""}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-sub">{objective === null ? "no objective set" : `objective ${formatDuration(objective)} · ${met ? "met" : "missed"}`}</span>
      {usage !== null && (
        <span className="gauge" aria-hidden="true">
          <span style={{ width: `${(usage / 1.5) * 100}%` }} />
          <i style={{ left: `${100 / 1.5}%` }} />
        </span>
      )}
    </div>
  );
}

function LevelDetail({ level }: { level: LevelResult }) {
  return (
    <div className="level-detail">
      <p>
        <strong>{level.id}</strong> {level.question} <span className="card-sub">{level.evidence}</span>
        {!level.inScope && <span className="scope-note">beyond the requested depth</span>}
      </p>
      {level.checks.length === 0 ? (
        <p className="muted-line">No evidence was recorded for this level.</p>
      ) : (
        <ul className="check-list">
          {level.checks.map((check, index) => (
            <li key={index} className={check.passed ? "pass" : "fail"}>
              {check.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <span className="check-name">{check.name}</span>
              {check.detail && <span className={`check-detail${check.name === "Restore plan binding" ? " plan-binding-detail" : ""}${level.id === "V4" && check.source === "reported" ? " semantic-check-detail" : ""}`}>{check.detail}</span>}
              {check.source === "ledger" && <span className="chip">computed</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PhaseTimeline({ rto, rehearsal = false }: { rto: RTOResult; rehearsal?: boolean }) {
  const { bars, scaleSeconds, objectiveAt, failureAt, failureOffsetSeconds } = timelineBars(rto);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => {
    const offset = share * scaleSeconds - failureOffsetSeconds;
    return { share, label: offset < 0 ? `−${formatDuration(-offset)}` : offset === 0 ? rehearsal ? "start" : "failure" : `+${formatDuration(offset)}` };
  });
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>{rehearsal ? "Rehearsal timeline" : "Recovery timeline"}</h3>
        <span className="card-sub">{formatDuration(rto.seconds)} {rehearsal ? "from rehearsal start" : "after failure"}{rto.uncoveredSeconds >= 1 ? ` · ${formatDuration(rto.uncoveredSeconds)} unaccounted` : ""}</span>
      </header>
      <div className="timeline">
        {failureOffsetSeconds > 0 && (
          <div className="failure-line" title={rehearsal ? "Rehearsal started" : "Failure injected"} style={{ left: `calc(var(--label-w) + (100% - var(--label-w)) * ${failureAt / 100})` }} />
        )}
        {objectiveAt !== null && (
          <div
            className={`objective-line ${rto.met ? "" : "missed"}`}
            title={`RTO objective ${formatDuration(rto.objectiveSeconds)}`}
            style={{ left: `calc(var(--label-w) + (100% - var(--label-w)) * ${objectiveAt / 100})` }}
          />
        )}
        {bars.map((bar, index) => (
          <div className="timeline-row" key={`${bar.name}-${index}`}>
            <span className="timeline-label">{bar.name}</span>
            <span className="timeline-track">
              <span
                className={`timeline-bar ${bar.slowest ? "slowest" : ""}`}
                style={{ left: `${bar.left}%`, width: `${bar.width}%`, animationDelay: `${index * 70}ms` }}
                title={`${bar.name}: ${formatDuration(bar.durationSeconds)}`}
              >
                <em>{formatDuration(bar.durationSeconds)}</em>
              </span>
            </span>
          </div>
        ))}
        <div className="timeline-axis">
          {ticks.map((tick) => (
            <span key={tick.share} style={{ left: `calc(var(--label-w) + (100% - var(--label-w)) * ${tick.share})` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="timeline-legend">
        {rto.objectiveSeconds !== null && (
          <span><i className={`legend-line objective ${rto.met ? "" : "missed"}`} /> RTO objective {formatDuration(rto.objectiveSeconds)}</span>
        )}
        {failureOffsetSeconds > 0 && <span><i className="legend-line failure" /> failure injected</span>}
        <span><i className="legend-swatch slowest" /> slowest phase</span>
      </div>
    </section>
  );
}

function LedgerChart({ rpo, failureAt }: { rpo: RPOResult; failureAt: string }) {
  const buckets = rpo.timeline;
  if (buckets.length === 0) return null;
  const start = buckets[0].offsetSeconds;
  const peak = Math.max(...buckets.map((bucket) => bucket.recovered + bucket.lost), 1);
  const width = 100 / buckets.length;
  const failure = Date.parse(failureAt);
  const markerAt = rpo.recoveryPoint ? ((Date.parse(rpo.recoveryPoint) - failure) / 1000 - start) / -start : null;
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Acknowledged-write ledger</h3>
        <span className="card-sub">
          {rpo.consistent ? "consistent point in time" : `${rpo.holes} holes · inconsistent`}
          {rpo.unexpected > 0 ? ` · ${rpo.unexpected} unexpected` : ""}
        </span>
      </header>
      <div className="ledger">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${rpo.recovered} writes recovered and ${rpo.lost} lost before the failure`}>
          {buckets.map((bucket, index) => {
            const recoveredHeight = (bucket.recovered / peak) * 36;
            const lostHeight = (bucket.lost / peak) * 36;
            return (
              <g key={index}>
                <rect className="bar-recovered" x={index * width + width * 0.12} width={width * 0.76} y={40 - recoveredHeight} height={recoveredHeight} />
                <rect className="bar-lost" x={index * width + width * 0.12} width={width * 0.76} y={40 - recoveredHeight - lostHeight} height={lostHeight} />
              </g>
            );
          })}
        </svg>
        {markerAt !== null && markerAt >= 0 && markerAt <= 1 && (
          <span className="ledger-marker" title="Recovery point: last write of the fully recovered prefix" style={{ left: `${markerAt * 100}%` }} />
        )}
      </div>
      <div className="ledger-axis">
        <span>−{formatDuration(-start)}</span>
        <span className="legend">
          <i className="swatch recovered" /> recovered <i className="swatch lost" /> lost
          {markerAt !== null && <><i className="legend-line recovery" /> recovery point</>}
        </span>
        <span>failure</span>
      </div>
    </section>
  );
}
