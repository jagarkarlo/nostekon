import { AlertTriangle, ArrowDown, ArrowUp, Download, FileJson, LoaderCircle, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import orders from "../../examples/validation-profiles/orders.json?raw";
import inventory from "../../examples/validation-profiles/inventory.json?raw";
import { MAX_PLAN_BYTES, readOriginalJSON } from "./backupReview";
import { editableRules, inspectProfile, profileSource } from "./validationProfile";
import type { ProfileReview, ProfileRule } from "./validationProfile";

const draftKey = "nostekon-profile-draft-v1";
const maxDraftBytes = 64 * 1024;
const starters: Record<string, string> = { orders, inventory, blank: profileSource([]) };

function initialDraft() {
  try {
    const saved = localStorage.getItem(draftKey);
    return saved !== null && new TextEncoder().encode(saved).length <= maxDraftBytes ? saved : orders;
  } catch { return orders; }
}

export function ProfileWorkspace({ active }: { active: boolean }) {
  const [source, setSource] = useState(initialDraft);
  const [result, setResult] = useState<{ source: string; review: ProfileReview }>();
  const [problem, setProblem] = useState("");
  const [importProblem, setImportProblem] = useState("");
  const [storageProblem, setStorageProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const rules = editableRules(source);
  const fresh = !busy && !importing && !problem && !importProblem && result?.source === source ? result.review : undefined;

  function replace(next: string) {
    revision.current += 1;
    setSource(next);
    setResult(undefined);
    setProblem("");
    setImportProblem("");
  }

  useEffect(() => {
    try {
      if (new TextEncoder().encode(source).length > maxDraftBytes) throw new Error("Draft exceeds the 64 KiB local storage limit.");
      localStorage.setItem(draftKey, source);
      setStorageProblem("");
    } catch { setStorageProblem("Local draft not saved. Download a validated profile before leaving."); }
  }, [source]);

  useEffect(() => {
    if (!active || importing) return;
    const controller = new AbortController();
    let disposed = false;
    setBusy(true);
    setResult(undefined);
    setProblem("");
    const timer = window.setTimeout(() => {
      void inspectProfile(source, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]))
        .then(review => { if (!disposed) setResult({ source, review }); })
        .catch(error => { if (!disposed) setProblem(error instanceof Error ? error.message : "Profile inspection failed."); })
        .finally(() => { if (!disposed) setBusy(false); });
    }, 250);
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer); };
  }, [source, active, retry, importing]);

  function updateRules(next: ProfileRule[]) { replace(profileSource(next)); }
  function edit(index: number, patch: Partial<ProfileRule>) {
    if (!rules) return;
    updateRules(rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule));
  }
  function move(index: number, offset: number) {
    if (!rules || index + offset < 0 || index + offset >= rules.length) return;
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    updateRules(next);
  }
  async function importFile(file: File) {
    setImporting(true);
    setImportProblem("");
    const currentRevision = revision.current;
    try {
      const original = await readOriginalJSON(file, MAX_PLAN_BYTES);
      await inspectProfile(original, AbortSignal.timeout(30000));
      if (currentRevision === revision.current) replace(original);
    } catch (error) {
      if (currentRevision === revision.current) setImportProblem(error instanceof Error ? error.message : "Profile import failed.");
    } finally { setImporting(false); }
  }
  function download() {
    if (!fresh) return;
    const url = URL.createObjectURL(new Blob([source], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "validation-profile.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <main className="profile-workspace library-workspace">
    <div className="library-heading"><h1>Validation profiles</h1><span>{rules?.length ?? 0} / 20 rules</span></div>
    <div className="profile-tools">
      <label>Profile template<select aria-label="Profile template" value="" disabled={importing} onChange={event => {
        const starter = starters[event.target.value];
        if (starter && window.confirm("Replace the current profile draft?")) replace(starter);
      }}><option value="" disabled>Choose template</option><option value="orders">Orders</option><option value="inventory">Inventory</option><option value="blank">Empty profile</option></select></label>
      <button type="button" disabled={importing} onClick={() => input.current?.click()}><Upload size={16} /> Import profile</button>
      <button type="button" disabled={!fresh} onClick={download}><Download size={16} /> Download profile</button>
      <button type="button" disabled={busy || importing} title="Revalidate profile" aria-label="Revalidate profile" onClick={() => { setImportProblem(""); setRetry(value => value + 1); }}><RefreshCw size={16} /></button>
      <input hidden ref={input} type="file" accept=".json,application/json" data-testid="profile-input" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void importFile(file);
      }} />
    </div>
    {storageProblem && <p role="alert">{storageProblem}</p>}
    {(problem || importProblem) && <p role="alert" className="profile-problem"><AlertTriangle size={16} />{importProblem || problem}</p>}
    <div className="profile-layout">
      <section className="profile-rules" aria-label="Profile rules">
        {rules?.map((rule, index) => <fieldset className="profile-rule" key={index} disabled={importing}>
          <legend>Rule {index + 1}</legend>
          <div className="profile-rule-actions">
            <button type="button" aria-label={`Move rule ${index + 1} up`} title="Move rule up" disabled={index === 0 || importing} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
            <button type="button" aria-label={`Move rule ${index + 1} down`} title="Move rule down" disabled={index === rules.length - 1 || importing} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
            <button type="button" aria-label={`Remove rule ${index + 1}`} title="Remove rule" onClick={() => updateRules(rules.filter((_, position) => position !== index))}><Trash2 size={16} /></button>
          </div>
          <label>Name<input aria-label={`Rule ${index + 1} name`} maxLength={63} value={rule.name} onChange={event => edit(index, { name: event.target.value })} /></label>
          <label>Type<select aria-label={`Rule ${index + 1} type`} value={rule.type} onChange={event => {
            const type = event.target.value as ProfileRule["type"];
            const next = { ...rule, type };
            if (type === "foreign_key") next.reference = rule.reference ?? { table: "", column: "" };
            else delete next.reference;
            updateRules(rules.map((item, position) => position === index ? next : item));
          }}><option value="not_null">Required</option><option value="unique">Unique</option><option value="foreign_key">Foreign key</option></select></label>
          <label>Table<input aria-label={`Rule ${index + 1} table`} maxLength={127} value={rule.table} placeholder="public.orders" onChange={event => edit(index, { table: event.target.value })} /></label>
          <label>Column<input aria-label={`Rule ${index + 1} column`} maxLength={63} value={rule.column} placeholder="id" onChange={event => edit(index, { column: event.target.value })} /></label>
          {rule.type === "foreign_key" && <>
            <label>Parent table<input aria-label={`Rule ${index + 1} parent table`} maxLength={127} value={rule.reference?.table ?? ""} onChange={event => edit(index, { reference: { table: event.target.value, column: rule.reference?.column ?? "" } })} /></label>
            <label>Parent column<input aria-label={`Rule ${index + 1} parent column`} maxLength={63} value={rule.reference?.column ?? ""} onChange={event => edit(index, { reference: { table: rule.reference?.table ?? "", column: event.target.value } })} /></label>
          </>}
        </fieldset>)}
        <button type="button" disabled={!rules || rules.length >= 20 || importing} onClick={() => updateRules([...(rules ?? []), { name: "", type: "not_null", table: "", column: "" }])}><Plus size={16} /> Add rule</button>
      </section>
      <aside className="profile-inspection">
        <section role="status" aria-label="Profile validation" aria-live="polite">
          <h2>{importing ? "Importing profile" : busy ? "Validating profile" : fresh ? "Valid structure" : "Not validated"}{(busy || importing) && <LoaderCircle className="spin" size={16} />}</h2>
          <ul className="profile-limits">{["Data not measured", "Snapshot counts not supplied", "Owner approval unverified"].map(text => <li key={text}>{text}</li>)}</ul>
          {fresh && <>
            <h3>Required tables</h3><ul>{fresh.tables.map(table => <li key={table}><code>{table}</code></li>)}</ul>
            <h3>Coverage</h3>{fresh.warnings.length ? <ul className="profile-warnings">{fresh.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : <p>No structural coverage warnings</p>}
            <details><summary>Original SHA-256</summary><code className="profile-hash">{fresh.profileSHA256}</code></details>
          </>}
        </section>
        <details className="profile-json"><summary><FileJson size={16} /> Profile JSON</summary><textarea spellCheck={false} aria-label="Profile JSON" value={source} disabled={importing} onChange={event => replace(event.target.value)} /></details>
      </aside>
    </div>
  </main>;
}