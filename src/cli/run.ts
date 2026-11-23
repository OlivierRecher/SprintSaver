import { ConfigError, findProject, loadConfig } from "../config/load.js";
import { buildApp } from "../app.js";
import { installStopHandler } from "../engine/stop.js";
import { acquireGlobalLock } from "../state/lock.js";

/** Analyse `<projet>#<iid>`. */
export function parseTicketRef(ref: string): { projectName: string; iid: number } {
  const m = /^([^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!m || !m[1] || !m[2]) throw new ConfigError(`Référence de ticket invalide : « ${ref} » (attendu : <projet>#<iid>, ex. mon-projet#42)`);
  return { projectName: m[1], iid: Number(m[2]) };
}

export async function runCommand(ref: string): Promise<void> {
  const { projectName, iid } = parseTicketRef(ref);
  const config = await loadConfig();
  const project = findProject(config, projectName);
  const lock = acquireGlobalLock({ command: `run ${ref}` });
  const app = buildApp(config);
  const stop = installStopHandler();
  try {
    const state = await app.processor.process(project, iid, { manual: true, signal: stop.signal, abortNow: stop.immediateSignal });
    const out: string[] = [`${state.key} : ${state.phase}`];
    if (state.phase === "blocked") out.push(`Bloqué : ${state.blockedReason ?? "?"}`, `Worktree conservé : ${state.worktreePath}`);
    if (state.mrUrl) out.push(`MR : ${state.mrUrl}`);
    if (state.phase !== "blocked" && state.phase !== "finalized") out.push("Interrompu : relancez la même commande pour reprendre.");
    console.log(out.join("\n"));
    if (state.phase === "blocked") process.exitCode = 2;
  } finally {
    stop.dispose();
    lock.release();
  }
}
