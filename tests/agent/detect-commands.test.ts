import { describe, expect, it } from "vitest";
import { DETECT_COMMANDS_PROMPT, DETECT_COMMANDS_TOOLS, detectCommandsAgent } from "../../src/agent/detect-commands.js";

describe("sous-agent detect-commands", () => {
  it("lecture du dépôt, CI, sondes et vérification ; ni Bash ni écriture", () => {
    const def = detectCommandsAgent("claude-opus-5-5");
    expect(def.model).toBe("claude-opus-5-5");
    expect(def.tools).toEqual(DETECT_COMMANDS_TOOLS);
    expect(def.tools).toEqual(
      expect.arrayContaining([
        "Read",
        "Glob",
        "Grep",
        "mcp__sprintsaver__analyse_ci",
        "mcp__sprintsaver__probe_toolchains",
        "mcp__sprintsaver__list_version_managers",
        "mcp__sprintsaver__list_local_ignored_files",
        "mcp__sprintsaver__verify_commands",
      ]),
    );
    for (const forbidden of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent"]) expect(def.tools).not.toContain(forbidden);
    expect(def.omitClaudeMd).toBe(true);
    // Synchrone : l'agent principal attend son rapport avant de rendre sa sortie.
    expect(def.background).toBe(false);
  });

  it("le prompt couvre toutes les sources de version, le choix d'un gestionnaire installé, les prérequis et la ligne de base", () => {
    for (const needle of [
      "analyse_ci",
      "Dockerfile",
      ".nvmrc",
      ".python-version",
      "global.json",
      "requires-python",
      "README",
      "probe_toolchains",
      "list_version_managers",
      "gestionnaire de versions déjà installé",
      "prérequis",
      "N'installe rien globalement",
      "verify_commands",
      "ligne de base",
      "baseline_red",
      "prerequisite_missing",
      // Commande idiomatique du gestionnaire de versions plutôt qu'un bricolage de chemins.
      "nvm exec 22",
      "commande idiomatique",
      // worktreeInclude : tests ET application, fichiers ignorés du checkout local, pendants d'exemples.
      "list_local_ignored_files",
      "lancer les tests ET l'application",
      ".env pour .env.example",
      // Seule la commande de test sert de garde-fou : les vérifications bloquantes y restent.
      "la SEULE que l'orchestrateur exécute",
      "typecheck, lint, tests",
    ]) {
      expect(DETECT_COMMANDS_PROMPT).toContain(needle);
    }
  });
});
