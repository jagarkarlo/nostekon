const sources = import.meta.glob<string>("../../examples/runs/*.run.json", { query: "?raw", import: "default" });
const info: Record<string, { label: string; summary: string; recorded: boolean }> = {
  "k3d-postgresql": { label: "Isolated PostgreSQL restore", summary: "Recorded lab / two clusters / V3", recorded: true },
  "postgresql-backup-rehearsal": { label: "PostgreSQL backup rehearsal", summary: "Recorded lab / custom backup / V3", recorded: true },
  "k3d-ledger-zero-loss": { label: "PostgreSQL zero loss", summary: "Recorded lab / 10 writes recovered / V4", recorded: true },
  "k3d-ledger-tail-loss": { label: "PostgreSQL RPO exceeded", summary: "Recorded lab / 2 writes lost / 0s budget", recorded: true },
  "k3d-ledger-budget-loss": { label: "PostgreSQL loss within budget", summary: "Recorded lab / 2 writes lost / 60s budget", recorded: true },
  "mlflow-namespace-loss": { label: "MLflow namespace loss", summary: "Synthetic / V4 with write ledger", recorded: false },
  "crud-cluster-loss": { label: "CRUD cluster loss", summary: "Synthetic / failed row counts and RTO", recorded: false },
};

export const samples = Object.entries(sources).map(([path, load]) => {
  const id = path.split("/").pop()!.replace(".run.json", "");
  return { id, load, ...(info[id] ?? { label: id, summary: "Example evidence", recorded: false }) };
}).sort((left, right) => left.id === "k3d-postgresql" ? -1 : right.id === "k3d-postgresql" ? 1 : left.label.localeCompare(right.label));

export function isRecordedSample(id: string): boolean {
  return samples.some((sample) => sample.id === id && sample.recorded);
}