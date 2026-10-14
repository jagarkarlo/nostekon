import { CheckCircle2, Download, FileArchive, LoaderCircle, ShieldAlert, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { exportBackupBundle, importBackupBundle, MAX_PLAN_BYTES, readOriginalJSON, reviewBackup, reviewBackupPreflight } from "./backupReview";
import type { BackupReview, PreflightReview } from "./backupReview";

function download(name: string, content: BlobPart, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function BackupWorkbench({ evidence, onImport, plan, onPlanChange }: { evidence: string; onImport: (source: string) => void; plan: { text: string; name: string }; onPlanChange: (plan: { text: string; name: string }) => void }) {
  const [result, setResult] = useState<{ plan: string; evidence: string; review: BackupReview } | null>(null);
  const [preflight, setPreflight] = useState({ text: "", name: "" });
  const [preflightResult, setPreflightResult] = useState<{ plan: string; preflight: string; review: PreflightReview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [error, setError] = useState("");
  const [preflightError, setPreflightError] = useState("");
  const generation = useRef(0);
  const preflightGeneration = useRef(0);
  const planInput = useRef<HTMLInputElement>(null);
  const preflightInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  const fresh = result?.plan === plan.text && result.evidence === evidence ? result.review : null;
  const freshPreflight = preflightResult?.plan === plan.text && preflightResult.preflight === preflight.text ? preflightResult.review : null;

  useEffect(() => {
    const current = ++generation.current;
    setResult(null); setBusy(false);
    if (plan.text && evidence) {
      setBusy(true); setError("");
      void reviewBackup(plan.text, evidence).then(review => {
        if (current === generation.current) setResult({ plan: plan.text, evidence, review });
      }).catch(reason => {
        if (current === generation.current) setError(message(reason));
      }).finally(() => { if (current === generation.current) setBusy(false); });
    }
    return () => { generation.current++; };
  }, [plan, evidence]);

  useEffect(() => {
    const current = ++preflightGeneration.current;
    setPreflightResult(null); setPreflightBusy(false);
    if (!plan.text) {
      setPreflight({ text: "", name: "" });
      setPreflightError("");
      return;
    }
    if (preflight.text) {
      setPreflightBusy(true); setPreflightError("");
      void reviewBackupPreflight(plan.text, preflight.text).then(review => {
        if (current === preflightGeneration.current) setPreflightResult({ plan: plan.text, preflight: preflight.text, review });
      }).catch(reason => {
        if (current === preflightGeneration.current) setPreflightError(message(reason));
      }).finally(() => { if (current === preflightGeneration.current) setPreflightBusy(false); });
    }
    return () => { preflightGeneration.current++; };
  }, [plan.text, preflight]);

  async function attach(file: File) {
    const current = ++generation.current;
    setResult(null); setError(""); setBusy(true);
    try {
      const text = await readOriginalJSON(file, MAX_PLAN_BYTES);
      if (current === generation.current) onPlanChange({ text, name: file.name });
    } catch (reason) {
      if (current === generation.current) { onPlanChange({ text: "", name: "" }); setError(message(reason)); }
    } finally { if (current === generation.current) setBusy(false); }
  }

  async function attachPreflight(file: File) {
    const current = ++preflightGeneration.current;
    setPreflightResult(null); setPreflightError(""); setPreflightBusy(true);
    try {
      const text = await readOriginalJSON(file, MAX_PLAN_BYTES);
      if (current === preflightGeneration.current) setPreflight({ text, name: file.name });
    } catch (reason) {
      if (current === preflightGeneration.current) { setPreflight({ text: "", name: "" }); setPreflightError(message(reason)); }
    } finally { if (current === preflightGeneration.current) setPreflightBusy(false); }
  }

  async function importBundle(file: File) {
    const current = ++generation.current;
    setResult(null); setError(""); setBusy(true);
    try {
      const imported = await importBackupBundle(file);
      if (current !== generation.current) return;
      onPlanChange({ text: imported.plan, name: "plan.json" });
      onImport(imported.evidence);
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }

  async function exportBundle() {
    if (!fresh || busy) return;
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      const archive = await exportBackupBundle(plan.text, evidence);
      if (current === generation.current) download("nostekon.backup-review.zip", archive, "application/zip");
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }

  return <section className="backup-workbench" aria-label="Independent backup plan review">
    <div className="section-toolbar">
      <h2>Restore plan</h2>
      <div className="backup-actions">
        <button className="tool" type="button" disabled={busy} onClick={() => planInput.current?.click()}><Upload size={15} />{plan.text ? "Replace plan" : "Attach plan"}</button>
        <button className="tool" type="button" disabled={busy} onClick={() => bundleInput.current?.click()}><FileArchive size={15} />Import backup bundle</button>
        <button className="tool" type="button" disabled={!fresh || busy} onClick={() => void exportBundle()}><Download size={15} />Export backup bundle</button>
        <button className="icon-button" type="button" disabled={!plan.text || busy} title="Download original restore plan" aria-label="Download original restore plan" onClick={() => download("nostekon.restore-plan.json", plan.text, "application/json")}><Download size={15} /></button>
        <button className="icon-button" type="button" disabled={!fresh || busy} title="Download independent backup review" aria-label="Download independent backup review" onClick={() => fresh && download("nostekon.backup-review.json", JSON.stringify(fresh, null, 2) + "\n", "application/json")}><Download size={15} /></button>
        <button className="icon-button" type="button" disabled={!plan.text || busy} title="Remove restore plan" aria-label="Remove restore plan" onClick={() => { setError(""); onPlanChange({ text: "", name: "" }); }}><Trash2 size={15} /></button>
      </div>
    </div>
    <input hidden ref={planInput} type="file" accept=".json,application/json" data-testid="backup-plan-input" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void attach(file); }} />
    <input hidden ref={bundleInput} type="file" accept=".zip,application/zip" data-testid="backup-bundle-input" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importBundle(file); }} />
    {error && <div className="banner bad" role="alert"><XCircle size={15} /><span>{error}</span></div>}
    {busy && <p className="workspace-label" role="status"><LoaderCircle size={15} className="spin" />Reviewing originals</p>}
    {!busy && !fresh && !error && <p className="workspace-label">Not reviewed</p>}
    {fresh && <div className="backup-review-result" role="status" aria-label="Backup plan gate">
      <dl className="backup-status">
        <div><dt>Independent Gate</dt><dd className={fresh.passed ? "backup-pass" : "backup-fail"}>{fresh.passed ? "Passed" : "Failed"}</dd></div>
        <div><dt>Measurements</dt><dd>{fresh.complete ? "Complete" : "Incomplete"}</dd></div>
        <div><dt>Plan Binding</dt><dd>{fresh.evidenceMatches ? "Matches" : "Mismatch"}</dd></div>
      </dl>
      <p className="workspace-label"><ShieldAlert size={14} />Unauthenticated provenance</p>
      <dl className="backup-hashes">
        <div><dt>Canonical Plan SHA-256</dt><dd><code>{fresh.planSHA256}</code></dd></div>
        <div><dt>Original Plan SHA-256</dt><dd><code>{fresh.planFileSHA256}</code></dd></div>
        <div><dt>Original Evidence SHA-256</dt><dd><code>{fresh.evidenceSHA256}</code></dd></div>
      </dl>
      {fresh.issues.length > 0 && <ul className="findings">{fresh.issues.map((issue, index) => <li key={index} className="finding error"><XCircle size={13} /><span>{issue}</span></li>)}</ul>}
    </div>}
    {plan.text && <details className="backup-original"><summary>{plan.name}</summary><pre>{plan.text}</pre></details>}
    <div className="backup-preflight-section">
      <div className="section-toolbar">
        <h3>Host preflight</h3>
        <div className="backup-actions">
          <button className="tool" type="button" disabled={!plan.text || preflightBusy} onClick={() => preflightInput.current?.click()}><Upload size={15} />{preflight.text ? "Replace preflight" : "Attach preflight"}</button>
          <button className="icon-button" type="button" disabled={!preflight.text || preflightBusy} title="Download original backup preflight" aria-label="Download original backup preflight" onClick={() => download("nostekon.backup-preflight.json", preflight.text, "application/json")}><Download size={15} /></button>
          <button className="icon-button" type="button" disabled={!freshPreflight || preflightBusy} title="Download preflight review" aria-label="Download preflight review" onClick={() => freshPreflight && download("nostekon.preflight-review.json", JSON.stringify(freshPreflight, null, 2) + "\n", "application/json")}><Download size={15} /></button>
          <button className="icon-button" type="button" disabled={!preflight.text || preflightBusy} title="Remove backup preflight" aria-label="Remove backup preflight" onClick={() => { setPreflightError(""); setPreflight({ text: "", name: "" }); }}><Trash2 size={15} /></button>
        </div>
      </div>
      <input hidden ref={preflightInput} type="file" accept=".json,application/json" data-testid="backup-preflight-input" disabled={!plan.text || preflightBusy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void attachPreflight(file); }} />
      {preflightError && <div className="banner bad" role="alert"><XCircle size={15} /><span>{preflightError}</span></div>}
      {preflightBusy && <p className="workspace-label" role="status"><LoaderCircle size={15} className="spin" />Reviewing preflight</p>}
      {!preflightBusy && !freshPreflight && !preflightError && <p className="workspace-label">{plan.text ? "Attach preflight JSON to check host prerequisites before restoring" : "Attach a restore plan first"}</p>}
      {freshPreflight && <div className="backup-preflight-result" role="status" aria-label="Backup preflight gate">
        <dl className="backup-status">
          <div><dt>Preflight Gate</dt><dd className={freshPreflight.passed ? "backup-pass" : "backup-fail"}>{freshPreflight.passed ? "Ready" : "Blocked"}</dd></div>
          <div><dt>Plan Binding</dt><dd>{freshPreflight.planMatches ? "Matches" : "Mismatch"}</dd></div>
          <div><dt>Archive Bytes</dt><dd>{freshPreflight.backupMatches ? "Matches" : "Drift"}</dd></div>
        </dl>
        <p className="workspace-label"><ShieldAlert size={14} />Metadata-only preflight · no restore ran</p>
        <dl className="backup-hashes">
          <div><dt>Original Preflight SHA-256</dt><dd><code>{freshPreflight.preflightSHA256}</code></dd></div>
          <div><dt>Observed Archive</dt><dd><code>{freshPreflight.observedBackup.sha256}</code> ({freshPreflight.observedBackup.bytes.toLocaleString()} bytes)</dd></div>
        </dl>
        <ul className="check-list">{freshPreflight.checks.map(check => <li key={check.name} className={check.passed ? "pass" : "fail"}>{check.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span className="check-name">{check.name}</span><span className="check-detail plan-binding-detail">{check.detail}</span></li>)}</ul>
        {freshPreflight.issues.length > 0 && <ul className="findings">{freshPreflight.issues.map((issue, index) => <li key={index} className="finding error"><XCircle size={13} /><span>{issue}</span></li>)}</ul>}
      </div>}
    </div>
  </section>;
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : "Could not review backup originals."; }