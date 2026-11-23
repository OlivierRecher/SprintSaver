/** Boucle `sprintsaver watch` : un ticket à la fois, polling GitLab, arrêt propre. */
import type { GitLabApi, StateStore } from "../contracts.js";
import type { Config } from "../config/schema.js";
import { ticketKey } from "../config/paths.js";
import { log } from "../log.js";
import type { TicketProcessor } from "./processor.js";
import { nextTicket } from "./queue.js";
import { errorMessage } from "./util.js";

export interface WatchDeps {
  config: Config;
  gitlab: GitLabApi;
  store: StateStore;
  processor: TicketProcessor;
  /** Purge des runs (transcripts) plus vieux que `days` jours. */
  purgeOldRuns?: (days: number) => Promise<unknown>;
  /** Attente interruptible (injectable pour les tests). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Horloge (epoch ms, injectable pour les tests). */
  now?: () => number;
}

/** Attend `ms` ou jusqu'à l'abandon du signal. */
export function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Échecs consécutifs (hors traitement : état corrompu, GitLab en erreur…) avant de mettre un ticket de côté. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Durée de mise à l'écart d'un ticket en échec répété ; à l'expiration, son compteur d'échecs repart de zéro. */
export const SKIP_DURATION_MS = 30 * 60_000;

/**
 * Tourne jusqu'à l'abandon de `signal`. L'abandon n'interrompt pas la phase en cours :
 * le processeur s'arrête à la fin de celle-ci (état sauvegardé), puis la boucle sort.
 * `immediateSignal` (2e Ctrl+C) interrompt en plus la session agent en cours.
 *
 * Un ticket dont le traitement lève une erreur (hors blocage géré par le processeur) `MAX_CONSECUTIVE_FAILURES`
 * fois de suite est mis de côté en mémoire pendant `SKIP_DURATION_MS` (30 min), pour ne pas bloquer la file ;
 * il est ensuite de nouveau éligible, avec un compteur d'échecs remis à zéro.
 */
export async function runWatch(deps: WatchDeps, opts: { signal: AbortSignal; immediateSignal?: AbortSignal }): Promise<void> {
  const { config } = deps;
  const { signal } = opts;
  const failures = new Map<string, number>();
  /** Tickets mis de côté → fin de la mise à l'écart (epoch ms). */
  const skipped = new Map<string, number>();
  const sleep = deps.sleep ?? interruptibleSleep;
  const now = deps.now ?? (() => Date.now());

  if (config.transcripts.enabled && deps.purgeOldRuns) {
    try {
      await deps.purgeOldRuns(config.transcripts.retentionDays);
    } catch (err) {
      log.warn({ err }, `Purge des anciens runs impossible : ${errorMessage(err)}`);
    }
  }

  log.info(
    { projects: config.projects.map((p) => p.name), label: config.triggerLabel },
    `SprintSaver surveille ${config.projects.length} projet(s), label « ${config.triggerLabel} », toutes les ${config.pollIntervalSec} s`,
  );

  while (!signal.aborted) {
    const t = now();
    for (const [id, until] of skipped) {
      if (until > t) continue;
      skipped.delete(id);
      failures.delete(id);
      log.info({ ticket: id }, `${id} n'est plus mis de côté : il sera de nouveau traité`);
    }
    let next = null;
    try {
      next = await nextTicket(deps, { exclude: new Set(skipped.keys()) });
    } catch (err) {
      log.error({ err }, `Interrogation de GitLab en échec : ${errorMessage(err)} (nouvel essai au prochain cycle)`);
    }

    if (next && !signal.aborted) {
      const key = `${next.project.name}#${next.iid}`;
      const id = ticketKey(next.project.name, next.iid);
      log.info({ ticket: key, source: next.source }, next.source === "resume" ? `Reprise de ${key}` : `Ticket suivant : ${key}`);
      try {
        const state = await deps.processor.process(next.project, next.iid, { signal, abortNow: opts.immediateSignal });
        failures.delete(id);
        log.info({ ticket: key, phase: state.phase }, `${key} : ${state.phase}${state.blockedReason ? ` (${state.blockedReason})` : ""}`);
      } catch (err) {
        const n = (failures.get(id) ?? 0) + 1;
        failures.set(id, n);
        log.error({ err, ticket: key, failures: n }, `Traitement de ${key} interrompu par une erreur : ${errorMessage(err)}`);
        if (n >= MAX_CONSECUTIVE_FAILURES) {
          skipped.set(id, now() + SKIP_DURATION_MS);
          log.error(
            { ticket: key },
            `${key} mis de côté pendant ${SKIP_DURATION_MS / 60_000} min après ${n} échecs consécutifs (corrigez la cause, ou utilisez « sprintsaver run ${key} »)`,
          );
          // Passe au ticket suivant sans attendre le prochain cycle.
          if (!signal.aborted) continue;
        }
      }
    }

    if (signal.aborted) break;
    await sleep(config.pollIntervalSec * 1000, signal);
  }
  log.info("SprintSaver arrêté : l'état des tickets est sauvegardé.");
}
