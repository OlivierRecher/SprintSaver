import { homedir } from "node:os";
import { join } from "node:path";

/** Racine des données SprintSaver. Surchargeable par SPRINTSAVER_HOME (utile pour les tests). */
export function sprintsaverHome(): string {
  return process.env.SPRINTSAVER_HOME ?? join(homedir(), ".sprintsaver");
}

export const paths = {
  home: () => sprintsaverHome(),
  config: () => join(sprintsaverHome(), "config.yaml"),
  stateDir: () => join(sprintsaverHome(), "state"),
  stateFile: (ticketKey: string) => join(sprintsaverHome(), "state", `${ticketKey}.json`),
  reposDir: () => join(sprintsaverHome(), "repos"),
  repo: (projectName: string) => join(sprintsaverHome(), "repos", projectName),
  worktreesDir: () => join(sprintsaverHome(), "worktrees"),
  worktree: (ticketKey: string) => join(sprintsaverHome(), "worktrees", ticketKey),
  runsDir: () => join(sprintsaverHome(), "runs"),
  run: (ticketKey: string) => join(sprintsaverHome(), "runs", ticketKey),
  log: () => join(sprintsaverHome(), "sprintsaver.log"),
};

/** Racine du dépôt SprintSaver (pour trouver skills/). */
export function toolRoot(): string {
  // src/config/paths.ts -> racine ; dist/cli/index.js -> racine
  const here = new URL(".", import.meta.url).pathname;
  return join(here, "..", "..");
}

export function skillsDir(): string {
  return process.env.SPRINTSAVER_SKILLS_DIR ?? join(toolRoot(), "skills");
}

export function ticketKey(projectName: string, iid: number): string {
  return `${projectName}-${iid}`;
}
