import { ArrowRight, Download, FileArchive, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { strToU8, zipSync } from "fflate";
import { useEffect, useRef, useState } from "react";
import { filterSavedSuites, parseSuite, sortSavedSuites } from "./labSuite";
import type { SuiteCaptureFilter, SuiteHistorySort, SuiteStatusFilter } from "./labSuite";
import { deleteSuite, listSuites, SUITE_LIMIT, suiteSources } from "./runStore";
import type { SavedSuite } from "./runStore";

export function SuiteHistory({ onOpen }: { onOpen: (suite: SavedSuite) => void }) {
  const [suites, setSuites] = useState<SavedSuite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SavedSuite | null>(null);
  const [working, setWorking] = useState(false);
  const [sort, setSort] = useState<SuiteHistorySort>("newest");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SuiteStatusFilter>("all");
  const [capture, setCapture] = useState<SuiteCaptureFilter>("all");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    void listSuites().then(saved => { if (active) setSuites(saved); })
      .catch(reason => { if (active) setError(message(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (pendingDelete) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pendingDelete]);

  async function download(suite: SavedSuite) {
    setWorking(true);
    setError("");
    try {
      const sources = await suiteSources(suite);
      const archive = zipSync(Object.fromEntries([...sources].map(([name, source]) => [name, strToU8(source)])), { level: 0 });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([new Uint8Array(archive).buffer], { type: "application/zip" }));
      link.download = `nostekon-suite-${suite.id.slice(0, 12)}-originals.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (reason) { setError(message(reason)); }
    finally { setWorking(false); }
  }

  async function remove() {
    if (!pendingDelete || working) return;
    setWorking(true);
    try {
      await deleteSuite(pendingDelete.id);
      setSuites(current => current.filter(suite => suite.id !== pendingDelete.id));
      setPendingDelete(null);
      setError("");
    } catch (reason) { setError(message(reason)); }
    finally { setWorking(false); }
  }

  const matching = sortSavedSuites(filterSavedSuites(suites, { query: search, status, capture }), sort);
  const filtersActive = !!search.trim() || status !== "all" || capture !== "all";

  return <section className="saved-runs" aria-labelledby="suite-history-heading">
    <div className="section-toolbar"><h2 id="suite-history-heading">Saved suites <span>{suites.length} / {SUITE_LIMIT}</span></h2><span className="workspace-label">Local browser storage</span>
      {suites.length > 0 && <>
        <label className="run-search"><Search size={15} /><input type="search" placeholder="Search suites" aria-label="Search suites" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select aria-label="Filter suite runner status" value={status} onChange={event => setStatus(event.target.value as SuiteStatusFilter)}><option value="all">All runner statuses</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="running">Running</option><option value="interrupted">Interrupted</option></select>
        <select aria-label="Filter suite capture" value={capture} onChange={event => setCapture(event.target.value as SuiteCaptureFilter)}><option value="all">All captures</option><option value="full">Full captures</option><option value="partial">Partial captures</option></select>
        <select aria-label="Sort saved suites" value={sort} onChange={event => setSort(event.target.value as SuiteHistorySort)}><option value="newest">Newest saved</option><option value="oldest">Oldest saved</option></select>
        {filtersActive && <button className="icon-button" type="button" aria-label="Clear suite filters" title="Clear suite filters" onClick={() => { setSearch(""); setStatus("all"); setCapture("all"); }}><X size={15} /></button>}
        <output aria-label="Matching saved suites">{matching.length} / {suites.length}</output>
      </>}
    </div>
    {error && <p className="banner bad" role="alert">{error}</p>}
    {loading ? <p className="library-empty" role="status"><LoaderCircle className="spin" size={18} /> Loading saved suites...</p> : matching.length === 0 ? <div className="library-empty"><FileArchive size={25} /><h3>{error ? "Suite history unavailable" : suites.length ? "No matching suites" : "No saved suites yet"}</h3></div> : <div className="table-scroll"><table className="runs-table suite-history-table">
      <thead><tr><th>Suite</th><th>Runner status</th><th>Cases recorded</th><th>Original files</th><th>Evidence</th><th aria-label="Actions" /></tr></thead>
      <tbody>{matching.map(suite => {
        const summary = parseSuite(suite.files.find(file => file.name === "suite.json")!.source);
        const shortId = suite.id.slice(0, 12);
        return <tr key={suite.id}>
          <th scope="row"><strong>PostgreSQL policy suite</strong><small className="mono">{shortId}</small><small>{Number.isFinite(new Date(suite.savedAt).getTime()) ? <>Saved <time dateTime={new Date(suite.savedAt).toISOString()}>{new Date(suite.savedAt).toLocaleString()}</time></> : "Saved time unavailable"}</small></th>
          <td data-label="Runner status">{summary.status}</td>
          <td data-label="Cases recorded" className="mono">{summary.cases.length} / 3</td>
          <td data-label="Original files" className="mono">{suite.files.length}</td>
          <td data-label="Evidence"><span className="evidence-kind">Imported · unverified</span></td>
          <td className="suite-row-action">
            <button className="icon-button" type="button" title={`Reopen suite ${shortId}`} aria-label={`Reopen suite ${shortId}`} disabled={working} onClick={() => onOpen(suite)}><ArrowRight size={17} /></button>
            <button className="icon-button" type="button" title={`Download original suite files ${shortId}`} aria-label={`Download original suite files ${shortId}`} disabled={working} onClick={() => void download(suite)}><Download size={16} /></button>
            <button className="icon-button" type="button" title={`Delete suite ${shortId}`} aria-label={`Delete suite ${shortId}`} disabled={working} onClick={() => setPendingDelete(suite)}><Trash2 size={16} /></button>
          </td>
        </tr>;
      })}</tbody>
    </table></div>}
    <dialog ref={dialog} className="delete-dialog" onCancel={() => setPendingDelete(null)}>
      <h2>Delete saved suite?</h2><p className="mono">{pendingDelete?.id.slice(0, 12)}</p><p>This removes only this browser's suite snapshot. Case runs remain saved.</p>
      <div className="library-actions"><button className="tool" type="button" disabled={working} onClick={() => setPendingDelete(null)}>Cancel</button><button className="primary danger" type="button" disabled={working} onClick={() => void remove()}><Trash2 size={15} /> {working ? "Deleting..." : "Delete suite"}</button></div>
    </dialog>
  </section>;
}

function message(reason: unknown) { return reason instanceof Error ? reason.message : "Could not access suite storage."; }