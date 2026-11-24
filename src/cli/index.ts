#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { ConfigError } from "../config/load.js";
import { LockError } from "../state/lock.js";
import { runInit } from "./init.js";
import { watchCommand } from "./watch.js";
import { runCommand } from "./run.js";
import { statusCommand } from "./status.js";
import { doctorCommand } from "./doctor.js";

function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      // process.exitCode plutôt que process.exit : laisse le logger (flux asynchrone) se vider.
      console.error(err instanceof ConfigError || err instanceof LockError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 1;
    }
  };
}

const program = new Command();
program
  .exitOverride()
  .name("sprintsaver")
  .description("Prend en charge les tickets GitLab étiquetés et livre une merge request prête à relire.");

const collect = (v: string, prev: string[]) => [...prev, v];

program
  .command("init")
  .description(
    "Configure SprintSaver : connexion GitLab (glab), projets suivis et, pour chaque projet, une config proposée par l'agent de configuration (commandes vérifiées par une exécution réelle, statuts, labels), à valider avant toute écriture",
  )
  .option("--project <chemin>", "projet GitLab à configurer (groupe/projet ou URL) ; répétable", collect, [])
  .option("--yes", "aucune question : accepte les propositions, garde les valeurs existantes ou par défaut pour le reste")
  .option("--dry-run", "aucune écriture sur GitLab ni dans la config de SprintSaver : la config produite est affichée, ou écrite dans --output")
  .option("--output <fichier>", "écrit la config produite dans ce fichier au lieu de la config de SprintSaver")
  .option("--url <adresse>", "instance GitLab (défaut : config existante, sinon https://gitlab.com)")
  .option("--username <nom>", "jeton de projet : ton username GitLab, à qui assigner les MR (utile avec --yes)")
  .option("--no-agent", "sans agent de configuration : détection simple et questions champ par champ")
  .addHelpText(
    "after",
    `
Comportement :
  Sans option, init pose ses questions (instance, projets, auteur des commits) et, pour chaque projet, affiche
  la config proposée par l'agent : valider, modifier un champ, revérifier les commandes, ignorer le projet ou
  tout annuler. Les labels manquants et la config ne sont écrits qu'après validation.

  --yes        aucune question. Projets : ceux de --project, sinon ceux de la config existante (les autres projets
               déjà suivis restent inchangés). Instance : --url, sinon celle de l'URL passée à --project, sinon
               la config existante, sinon https://gitlab.com. glab doit déjà être connecté. Auteur des commits :
               config existante, sinon compte GitLab, sinon config git globale. Une config dont les commandes
               ne passent pas la vérification est acceptée avec un avertissement.
  --dry-run    rien n'est écrit sur GitLab (les labels à créer sont listés) ni dans la config de SprintSaver :
               la config est affichée sur la sortie standard, ou écrite dans --output. Le clone de référence et
               les worktrees jetables de vérification restent créés dans $SPRINTSAVER_HOME.
  La racine des données est $SPRINTSAVER_HOME (défaut ~/.sprintsaver). La recherche du checkout local parcourt
  les dossiers usuels du dossier personnel, ou ceux de $SPRINTSAVER_CHECKOUT_ROOTS (séparés par « : »).

Exemples :
  sprintsaver init
  sprintsaver init --yes --project groupe/projet
  sprintsaver init --yes --dry-run --project https://gitlab.example.com/groupe/projet --output /tmp/config.yaml`,
  )
  .action(
    action((opts: { project: string[]; yes?: boolean; dryRun?: boolean; output?: string; url?: string; username?: string; agent: boolean }) =>
      runInit({
        projects: opts.project,
        yes: opts.yes === true,
        dryRun: opts.dryRun === true,
        agent: opts.agent,
        ...(opts.output ? { output: opts.output } : {}),
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.username ? { username: opts.username } : {}),
      }),
    ),
  );

program
  .command("watch")
  .description("Surveille les projets et traite les tickets étiquetés, un à la fois (Ctrl+C : arrêt après la phase en cours)")
  .action(action(() => watchCommand()));

program
  .command("run")
  .argument("<ticket>", "ticket à traiter, sous la forme <projet>#<iid>")
  .description("Traite ce ticket tout de suite, label ou non")
  .action(action((ref: string) => runCommand(ref)));

program
  .command("status")
  .description("Ticket en cours, tickets bloqués, livraisons récentes et file d'attente")
  .action(action(() => statusCommand()));

program
  .command("doctor")
  .description("Vérifie la config, git, le token GitLab et Claude Code")
  .option("--smoke", "lance aussi une courte session agent de test")
  .action(action((opts: { smoke?: boolean }) => doctorCommand(opts)));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // --help, --version, argument manquant : commander a déjà affiché le message.
  if (err instanceof CommanderError) process.exitCode = err.exitCode;
  else throw err;
}
