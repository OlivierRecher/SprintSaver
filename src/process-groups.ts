/**
 * Groupes de processus détachés lancés par SprintSaver (sessions `claude`, commandes de tests et de setup).
 * Ils tournent dans leur propre groupe (le Ctrl+C du terminal ne les atteint pas) : sans suivi, ils
 * survivraient à la sortie de SprintSaver. Les groupes suivis sont tués à la sortie du processus.
 */

const groups = new Set<number>();
let exitHookInstalled = false;

const supported = process.platform !== "win32";

/** Envoie `signal` à tout le groupe de processus `pid` (sans lever s'il est déjà terminé). */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // groupe déjà terminé
  }
}

/** Tue tous les groupes suivis encore actifs. */
export function killTrackedProcessGroups(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of groups) killProcessGroup(pid, signal);
}

/** Groupes actuellement suivis (pour les tests et le diagnostic). */
export function trackedProcessGroups(): number[] {
  return [...groups];
}

/**
 * Suit le groupe dont `pid` est le chef (processus lancé avec `detached: true`) ; il sera tué si SprintSaver
 * quitte avant sa fin. Retourne la fonction qui arrête le suivi (à appeler quand le processus se termine).
 */
export function trackProcessGroup(pid: number | undefined): () => void {
  if (pid === undefined || !supported) return () => undefined;
  installExitHook();
  groups.add(pid);
  return () => {
    groups.delete(pid);
  };
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => killTrackedProcessGroups("SIGKILL"));
}
