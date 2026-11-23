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

program
  .command("init")
  .description("Configure SprintSaver : token, projets suivis, statuts, label déclencheur")
  .action(action(() => runInit()));

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
