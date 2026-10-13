import { Activity, FileCheck2, FlaskConical, LayoutList, Moon, PencilRuler, RefreshCw, Play, Sun } from "lucide-react";
import nostekonMark from "../../site/src/content/docs/assets/nostekon-mark.svg";
import { useCallback, useEffect, useState } from "react";
import { request } from "./api";
import { ReportView } from "./ReportView";
import { AboutDialog } from "./AboutDialog";
import { Studio } from "./Studio";
import { RunLibrary } from "./RunLibrary";
import { SuiteView } from "./SuiteView";
import { LabView } from "./LabView";
import { ProfileWorkspace } from "./ProfileWorkspace";

type View = "runs" | "design" | "report" | "suite" | "lab" | "profiles";
type APIState = "checking" | "online" | "offline";

const viewFromHash = (): View => {
  const hash = window.location.hash.toLowerCase().replace("%2f", "/");
  return hash === "#/profiles" ? "profiles" : hash === "#/report" ? "report" : hash === "#/design" ? "design" : hash === "#/suite" ? "suite" : hash === "#/lab" ? "lab" : "runs";
};
const browserDemo = window.location.pathname.startsWith("/demo/");

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [apiState, setAPIState] = useState<APIState>("checking");
  const [selection, setSelection] = useState<{ source: string; sampleId: string; attestation?: string; backupPlan?: string }>();
  const [suiteSelection, setSuiteSelection] = useState<Map<string, string>>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("nostekon-theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); }
    catch { return "dark"; }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("nostekon-theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);

  const checkAPI = useCallback(async (signal?: AbortSignal) => {
    setAPIState("checking");
    try {
      const response = await request("/healthz", "", signal ?? AbortSignal.timeout(10000));
      setAPIState(response.status === 204 ? "online" : "offline");
    } catch {
      setAPIState("offline");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    void checkAPI(controller.signal).finally(() => window.clearTimeout(timeout));
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      window.removeEventListener("hashchange", onHash);
    };
  }, [checkAPI]);

  const onReachability = useCallback((online: boolean) => setAPIState(online ? "online" : "offline"), []);
  const apiLabel = apiState === "checking" ? "Connecting" : apiState === "online" ? (browserDemo ? "Go engine · browser" : "API connected") : "Engine unavailable";

  return (
    <div className="studio">
      <header className="topbar">
        <a className="brand" href="#/runs" title="Nostekon name and logo are claimed trademarks">
          <img className="brand-mark" src={nostekonMark} width="28" height="28" alt="" />
          <span className="brand-name">Nostekon<sup aria-hidden="true">&trade;</sup></span>
          <span className="brand-product">Studio</span>
        </a>
        <nav className="views" aria-label="Studio views">
          <a href="#/runs" aria-current={view === "runs" ? "page" : undefined}><LayoutList size={15} /> Runs</a>
          <a href="#/lab" aria-current={view === "lab" ? "page" : undefined}><Play size={15} /> Lab</a>
          <a href="#/suite" aria-current={view === "suite" ? "page" : undefined}><FlaskConical size={15} /> Suite</a>
          <a href="#/profiles" aria-current={view === "profiles" ? "page" : undefined}><FileCheck2 size={15} /> Profiles</a>
          <a href="#/design" aria-current={view === "design" ? "page" : undefined}>
            <PencilRuler size={15} /> Design
          </a>
          <a href="#/report" aria-current={view === "report" ? "page" : undefined}>
            <FileCheck2 size={15} /> Report
          </a>
        </nav>
        <a className="workbench-link" href={browserDemo ? "/" : "https://github.com/jagarkarlo/nostekon"} title={browserDemo ? "Open the product site" : "Open the project"}>
          <Activity size={14} /> <span>{browserDemo ? "Product site" : "Project"}</span>
        </a>
        <button className="studio-theme" data-theme-toggle type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun size={18} data-theme-icon="sun" aria-hidden="true" /> : <Moon size={18} data-theme-icon="moon" aria-hidden="true" />}
        </button>
        <button className="studio-theme" type="button" aria-label="About Nostekon" title="About Nostekon" onClick={() => setAboutOpen(true)}><Activity size={18} aria-hidden="true" /></button>
        <button className={`api-status ${apiState}`} type="button" onClick={() => void checkAPI()} title="Recheck the local API">
          <span className="status-dot" />
          {apiLabel}
          {apiState === "offline" && <RefreshCw size={13} />}
        </button>
      </header>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {view === "runs" && <RunLibrary onOpen={(source, sampleId, attestation, backupPlan) => {
        setSelection({ source, sampleId, attestation, backupPlan });
        window.location.hash = "/report";
        setView("report");
      }} />}
      <div className="view" hidden={view !== "lab"}>
        <LabView active={view === "lab"} onReview={files => { setSuiteSelection(files); window.location.hash = "/suite"; setView("suite"); }} />
      </div>
      <div className="view" hidden={view !== "suite"}>
        <SuiteView active={view === "suite"} selection={suiteSelection} onReachability={onReachability} onOpen={(source) => {
          setSelection({ source, sampleId: "" });
          window.location.hash = "/report";
          setView("report");
        }} />
      </div>
      <div className="view" hidden={view !== "design"}>
        <Studio onReachability={onReachability} />
      </div>
      <div className="view" hidden={view !== "profiles"}>
        <ProfileWorkspace active={view === "profiles"} />
      </div>
      <div className="view" hidden={view !== "report"}>
        <ReportView onReachability={onReachability} selection={selection} />
      </div>
    </div>
  );
}
