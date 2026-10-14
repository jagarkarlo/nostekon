import { openDB } from "idb";
import type { DBSchema } from "idb";
import { isReport } from "./report";
import type { Report } from "./report";
import { isRecordedSample } from "./samples";
import { parseSuite } from "./labSuite";

export interface SavedRun {
  id: string;
  source: string;
  attestation?: string;
  backupPlan?: string;
  backupPreflight?: string;
  report: Report;
  sampleId: string;
  savedAt: number;
}

export interface SavedSuite {
  id: string;
  files: { name: string; source: string }[];
  savedAt: number;
}

interface RunDatabase extends DBSchema {
  runs: { key: string; value: SavedRun };
  suites: { key: string; value: SavedSuite };
  migration: { key: string; value: boolean };
}

export const RUN_LIMIT = 50;
export const SUITE_LIMIT = 20;
const SOURCE_LIMIT = 16 * 1024 * 1024;
const suiteNames = ["suite.json", "zero-loss.drillrun.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"];

function validateAttachment(original: unknown, name: string): void {
  if (original === undefined || original === "") return;
  if (typeof original !== "string" || new TextEncoder().encode(original).length > 16 * 1024) throw new Error(`Attached ${name} exceeds the 16 KiB limit or is unreadable.`);
  try {
    const value: unknown = JSON.parse(original);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  } catch { throw new Error(`Attached ${name} must contain a JSON object.`); }
}

async function database() {
  const db = await openDB<RunDatabase>("nostekon-runs", 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("migration")) db.createObjectStore("migration");
      if (!db.objectStoreNames.contains("suites")) db.createObjectStore("suites", { keyPath: "id" });
    },
  });
  try {
    if (await db.get("migration", "legacy-imported")) return db;
    let missing = false;
    const legacy = await openDB<RunDatabase>("checkride-runs", 1, {
      upgrade(_db, _oldVersion, _newVersion, transaction) {
        missing = true;
        void transaction.done.catch(() => undefined);
        transaction.abort();
      },
    }).catch((error: unknown) => {
      if (missing) return null;
      throw error;
    });
    let runs: SavedRun[] = [];
    if (legacy) {
      try { runs = await legacy.getAll("runs"); }
      finally { legacy.close(); }
    }
    const transaction = db.transaction(["runs", "migration"], "readwrite");
    try {
      if (!await transaction.objectStore("migration").get("legacy-imported")) {
        for (const run of runs) {
          if (!await transaction.objectStore("runs").get(run.id)) {
            await transaction.objectStore("runs").put(run);
          }
        }
        await transaction.objectStore("migration").put(true, "legacy-imported");
      }
      await transaction.done;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await transaction.done.catch(() => undefined);
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function listRuns(): Promise<SavedRun[]> {
  const db = await database();
  try {
    const runs = await db.getAll("runs");
    if (runs.some((run) => typeof run.source !== "string" || typeof run.id !== "string" || !isReport(run.report))) {
      throw new Error("Saved run data is unreadable. Export available evidence before clearing site storage.");
    }
    for (const run of runs) {
      validateAttachment(run.attestation, "attestation");
      validateAttachment(run.backupPlan, "backup plan");
      validateAttachment(run.backupPreflight, "backup preflight");
    }
    return runs.sort((left, right) => right.savedAt - left.savedAt);
  } finally { db.close(); }
}

export async function saveRun(source: string, report: Report, sampleId = "", attestation?: string, backupPlan?: string, backupPreflight?: string): Promise<SavedRun> {
  return (await saveRuns([{ source, report, sampleId, attestation, backupPlan, backupPreflight }]))[0];
}

export async function saveRuns(inputs: readonly { source: string; report: Report; sampleId?: string; attestation?: string; backupPlan?: string; backupPreflight?: string }[]): Promise<SavedRun[]> {
  if (!inputs.length) return [];
  const runs: SavedRun[] = [];
  const savedAt = Date.now();
  for (const { source, report, sampleId = "", attestation, backupPlan, backupPreflight } of inputs) {
    validateAttachment(attestation, "attestation");
    validateAttachment(backupPlan, "backup plan");
    validateAttachment(backupPreflight, "backup preflight");
    const bytes = new TextEncoder().encode(source);
    if (bytes.length > SOURCE_LIMIT) throw new Error("Evidence exceeds the 16 MiB limit.");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    runs.push({ id, source, report, sampleId, savedAt, ...(attestation === undefined ? {} : { attestation }), ...(backupPlan === undefined ? {} : { backupPlan }), ...(backupPreflight === undefined ? {} : { backupPreflight }) });
  }
  const db = await database();
  try {
    const transaction = db.transaction("runs", "readwrite");
    try {
      let count = await transaction.store.count();
      for (const run of runs) {
        const existing = await transaction.store.get(run.id);
        if (!existing) {
          if (count >= RUN_LIMIT) throw new Error(`The library holds ${RUN_LIMIT} runs. Delete a run before saving another.`);
          count++;
        }
        for (const field of ["attestation", "backupPlan", "backupPreflight"] as const) {
          const attached = existing?.[field];
          if (run[field] === undefined && attached !== undefined) {
            validateAttachment(attached, field === "attestation" ? "attestation" : field === "backupPlan" ? "backup plan" : "backup preflight");
            run[field] = attached;
          }
        }
        await transaction.store.put(run);
      }
      await transaction.done;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await transaction.done.catch(() => undefined);
      throw error;
    }
    return runs;
  } finally { db.close(); }
}

export async function deleteRun(id: string): Promise<void> {
  const db = await database();
  try { await db.delete("runs", id); }
  finally { db.close(); }
}

function validateSuiteFiles(files: SavedSuite["files"]): void {
  if (!Array.isArray(files) || files.length < 1 || files.length > 4 || new Set(files.map(file => file?.name)).size !== files.length) throw new Error("Invalid suite files.");
  for (const file of files) {
    if (!file || !suiteNames.includes(file.name) || typeof file.source !== "string") throw new Error("Unsupported suite file.");
    if (new TextEncoder().encode(file.source).length > (file.name === "suite.json" ? 64 * 1024 : SOURCE_LIMIT)) throw new Error("Suite files exceed the 64 KiB summary or 16 MiB evidence limit.");
  }
  const summary = files.find(file => file.name === "suite.json");
  if (!summary) throw new Error("Missing suite.json.");
  parseSuite(summary.source);
}

async function suiteDigest(files: SavedSuite["files"]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(files));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function saveSuite(sources: Map<string, string>): Promise<SavedSuite> {
  const files = Array.from(sources, ([name, source]) => ({ name, source })).sort((left, right) => suiteNames.indexOf(left.name) - suiteNames.indexOf(right.name));
  validateSuiteFiles(files);
  const saved: SavedSuite = { id: await suiteDigest(files), files, savedAt: Date.now() };
  const db = await database();
  try {
    const transaction = db.transaction("suites", "readwrite");
    try {
      if (!await transaction.store.get(saved.id) && await transaction.store.count() >= SUITE_LIMIT) throw new Error(`The library holds ${SUITE_LIMIT} suites. Delete a suite before saving another.`);
      await transaction.store.put(saved);
      await transaction.done;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await transaction.done.catch(() => undefined);
      throw error;
    }
    return saved;
  } finally { db.close(); }
}

export async function listSuites(): Promise<SavedSuite[]> {
  const db = await database();
  try {
    const suites = await db.getAll("suites");
    for (const suite of suites) {
      if (!suite || typeof suite.id !== "string" || !/^[a-f0-9]{64}$/.test(suite.id) || !Number.isFinite(suite.savedAt) || suite.savedAt < 0) throw new Error("Saved suite data is unreadable.");
      try { validateSuiteFiles(suite.files); }
      catch { throw new Error("Saved suite data is unreadable. Original evidence has not been deleted."); }
    }
    return suites.sort((left, right) => right.savedAt - left.savedAt);
  } finally { db.close(); }
}

export async function deleteSuite(id: string): Promise<void> {
  const db = await database();
  try { await db.delete("suites", id); }
  finally { db.close(); }
}

export async function suiteSources(suite: SavedSuite): Promise<Map<string, string>> {
  validateSuiteFiles(suite.files);
  if (await suiteDigest(suite.files) !== suite.id) throw new Error("Saved suite integrity check failed. Original evidence has not been deleted.");
  return new Map(suite.files.map(file => [file.name, file.source]));
}

export function evidenceLabel(sampleId: string): string {
  return isRecordedSample(sampleId) ? "Recorded lab" : sampleId ? "Synthetic sample" : "Imported evidence";
}