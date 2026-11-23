/** Choix du prochain ticket à traiter (ADR § 3) : reprise d'abord, puis file FIFO GitLab. */
import type { GitLabApi, QueuedIssue, StateStore, TicketState } from "../contracts.js";
import type { Config, ProjectConfig } from "../config/schema.js";
import { ticketKey } from "../config/paths.js";

export interface NextTicket {
  project: ProjectConfig;
  iid: number;
  source: "resume" | "queue";
}

export function isInProgress(state: TicketState): boolean {
  return state.phase !== "blocked" && state.phase !== "finalized";
}

/** États en cours (ni bloqués ni livrés) des projets configurés, du plus ancien au plus récent. */
export async function inProgressStates(config: Config, store: StateStore): Promise<{ state: TicketState; project: ProjectConfig }[]> {
  const states = await store.list();
  return states
    .filter(isInProgress)
    .map((state) => ({ state, project: config.projects.find((p) => p.name === state.projectName) }))
    .filter((x): x is { state: TicketState; project: ProjectConfig } => x.project !== undefined)
    .sort((a, b) => a.state.updatedAt.localeCompare(b.state.updatedAt));
}

export async function queuedIssues(config: Config, gitlab: GitLabApi): Promise<QueuedIssue[]> {
  if (config.projects.length === 0) return [];
  return gitlab.listQueuedIssues(config.projects, config.triggerLabel);
}

/**
 * Prochain ticket : un état en cours (reprise après crash ou Ctrl+C) s'il y en a un,
 * sinon le premier ticket étiqueté de la file GitLab. Les tickets de `exclude` (clés `<projet>-<iid>`,
 * mis de côté après des échecs répétés) sont ignorés.
 */
export async function nextTicket(
  deps: { config: Config; gitlab: GitLabApi; store: StateStore },
  opts: { exclude?: ReadonlySet<string> } = {},
): Promise<NextTicket | null> {
  const excluded = (projectName: string, iid: number) => opts.exclude?.has(ticketKey(projectName, iid)) ?? false;
  const resume = (await inProgressStates(deps.config, deps.store)).find((r) => !excluded(r.project.name, r.state.iid));
  if (resume) return { project: resume.project, iid: resume.state.iid, source: "resume" };
  const first = (await queuedIssues(deps.config, deps.gitlab)).find((q) => !excluded(q.project.name, q.iid));
  if (first) return { project: first.project, iid: first.iid, source: "queue" };
  return null;
}
