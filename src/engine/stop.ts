/**
 * Ctrl+C en trois temps :
 * 1. arrêt demandé après la phase en cours (`signal`) ; la session agent en cours n'est pas touchée (le
 *    processus `claude` tourne dans son propre groupe de processus, cf. agent/runner.ts) ;
 * 2. arrêt immédiat (`immediateSignal`) : la session agent en cours est interrompue (AbortController du
 *    SDK), le ticket est conservé pour reprise ; le processus quitte de lui-même ou, au plus tard, après
 *    `graceMs` (une attente de CI, par exemple, n'est pas interruptible) ;
 * 3. sortie tout de suite.
 *
 * SIGHUP (terminal fermé) et SIGTERM (kill, arrêt de session) valent un arrêt immédiat suivi de la sortie :
 * les deux signaux sont levés d'un coup, puis le processus quitte de lui-même ou après `graceMs` ; un second
 * signal fait sortir tout de suite.
 *
 * Avant chaque sortie forcée, les groupes de processus détachés (sessions `claude`, commandes de tests) sont
 * tués : détachés du terminal, ils survivraient sinon à SprintSaver. L'état est sauvegardé à chaque
 * transition : le ticket reprend à la dernière phase atteinte.
 */
import { log } from "../log.js";
import { killTrackedProcessGroups } from "../process-groups.js";

export interface StopHandler {
  /** Arrêt après la phase en cours. */
  signal: AbortSignal;
  /** Arrêt immédiat : interrompt la session agent en cours. */
  immediateSignal: AbortSignal;
  dispose(): void;
}

export interface StopHandlerOptions {
  /** Délai avant sortie forcée après le 2e Ctrl+C, SIGHUP ou SIGTERM. */
  graceMs?: number;
  write?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
  /** Tue les processus détachés encore actifs avant une sortie forcée (défaut : groupes suivis). */
  killChildren?: () => void;
}

/** Codes de sortie conventionnels (128 + n° du signal). */
const EXIT_CODES = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const;

export function installStopHandler(
  proc: Pick<NodeJS.Process, "on" | "off" | "exit"> = process,
  opts: StopHandlerOptions = {},
): StopHandler {
  const graceful = new AbortController();
  const immediate = new AbortController();
  const rawWrite = opts.write ?? ((m: string) => process.stderr.write(m));
  // Terminal fermé (SIGHUP) : l'écriture peut échouer, elle ne doit pas empêcher l'arrêt.
  const write = (m: string) => {
    try {
      rawWrite(m);
    } catch {
      // terminal indisponible
    }
  };
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const killChildren = opts.killChildren ?? (() => killTrackedProcessGroups("SIGTERM"));
  const graceMs = opts.graceMs ?? 10_000;
  let exiting = false;

  const exit = (code: number) => {
    try {
      killChildren();
    } catch (err) {
      log.error({ err }, "Arrêt des processus enfants impossible");
    }
    exiting = true;
    proc.exit(code);
  };

  let count = 0;
  const onSigint = () => {
    count += 1;
    if (count === 1 && !immediate.signal.aborted) {
      const msg =
        "Arrêt demandé : SprintSaver s'arrêtera à la fin de la phase en cours (état sauvegardé). Ctrl+C à nouveau pour interrompre la session en cours.";
      log.warn(msg);
      write(`\n${msg}\n`);
      graceful.abort();
    } else if (count === 2 && !immediate.signal.aborted) {
      const msg =
        "Arrêt immédiat : la session agent en cours est interrompue. L'état du ticket est sauvegardé ; il reprendra à la dernière phase atteinte. Ctrl+C à nouveau pour quitter sans attendre.";
      log.warn(msg);
      write(`\n${msg}\n`);
      immediate.abort();
      setTimer(() => exit(EXIT_CODES.SIGINT), graceMs).unref?.();
    } else {
      write("\nSortie immédiate. L'état du ticket est sauvegardé ; il reprendra à la dernière phase atteinte.\n");
      exit(EXIT_CODES.SIGINT);
    }
  };

  const onTerminate = (sig: "SIGHUP" | "SIGTERM") => {
    if (exiting) return;
    if (immediate.signal.aborted) {
      // Second signal de terminaison (ou après un 2e Ctrl+C) : sortie tout de suite.
      exit(EXIT_CODES[sig]);
      return;
    }
    const msg = `${sig} reçu : arrêt immédiat, la session agent en cours est interrompue. L'état du ticket est sauvegardé ; il reprendra à la dernière phase atteinte.`;
    log.warn(msg);
    if (sig !== "SIGHUP") write(`\n${msg}\n`);
    graceful.abort();
    immediate.abort();
    setTimer(() => exit(EXIT_CODES[sig]), graceMs).unref?.();
  };
  const onSighup = () => onTerminate("SIGHUP");
  const onSigterm = () => onTerminate("SIGTERM");

  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);
  proc.on("SIGHUP", onSighup);
  return {
    signal: graceful.signal,
    immediateSignal: immediate.signal,
    dispose() {
      proc.off("SIGINT", onSigint);
      proc.off("SIGTERM", onSigterm);
      proc.off("SIGHUP", onSighup);
    },
  };
}
