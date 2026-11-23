import type { QueuedIssue, TicketState } from "../contracts.js";
import { loadConfig } from "../config/load.js";
import { buildApp } from "../app.js";
import { isInProgress, queuedIssues } from "../engine/queue.js";
import { errorMessage } from "../engine/util.js";

const RECENT_DELIVERED = 10;

export interface StatusReport {
  inProgress: TicketState[];
  blocked: TicketState[];
  delivered: TicketState[];
  queue: QueuedIssue[] | { error: string };
}

export function formatStatus(r: StatusReport): string {
  const out: string[] = [];
  out.push("En cours :");
  if (r.inProgress.length === 0) out.push("  (aucun)");
  for (const s of r.inProgress) {
    out.push(`  ${s.projectName}#${s.iid} — phase ${s.phase} — ${s.title}`);
    out.push(
      `    depuis ${s.startedAt} (temps actif ${Math.round((s.activeMs ?? 0) / 60_000)} min), compteurs test/fix ${s.counters.testFix}, review ${s.counters.review}, CI ${s.counters.ci}`,
    );
  }
  out.push("", "Bloqués :");
  if (r.blocked.length === 0) out.push("  (aucun)");
  for (const s of r.blocked) {
    out.push(`  ${s.projectName}#${s.iid} — ${s.blockedReason ?? "raison inconnue"} (après ${s.phaseBeforeBlock ?? "?"}) — ${s.title}`);
    out.push(`    ${s.mrUrl ?? s.webUrl}`);
  }
  out.push("", "Livrés récemment :");
  if (r.delivered.length === 0) out.push("  (aucun)");
  for (const s of r.delivered) out.push(`  ${s.projectName}#${s.iid} — ${s.updatedAt.slice(0, 16).replace("T", " ")} — ${s.mrUrl ?? "(MR ?)"}`);
  out.push("", "File d'attente GitLab :");
  if ("error" in r.queue) out.push(`  (indisponible : ${r.queue.error})`);
  else if (r.queue.length === 0) out.push("  (vide)");
  else r.queue.forEach((q, i) => out.push(`  ${i + 1}. ${q.project.name}#${q.iid} — ${q.title} (étiqueté ${q.labeledAt})`));
  return out.join("\n");
}

export async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  const app = buildApp(config);
  const states = await app.store.list();
  const byUpdateDesc = (a: TicketState, b: TicketState) => b.updatedAt.localeCompare(a.updatedAt);
  let queue: StatusReport["queue"];
  try {
    queue = await queuedIssues(config, app.gitlab);
  } catch (err) {
    queue = { error: errorMessage(err) };
  }
  console.log(
    formatStatus({
      inProgress: states.filter(isInProgress).sort(byUpdateDesc),
      blocked: states.filter((s) => s.phase === "blocked").sort(byUpdateDesc),
      delivered: states.filter((s) => s.phase === "finalized").sort(byUpdateDesc).slice(0, RECENT_DELIVERED),
      queue,
    }),
  );
}
