import { loadConfig } from "../config/load.js";
import { buildApp } from "../app.js";
import { runWatch } from "../engine/watch.js";
import { installStopHandler } from "../engine/stop.js";
import { acquireGlobalLock } from "../state/lock.js";

export async function watchCommand(): Promise<void> {
  const config = await loadConfig();
  // Un seul processus SprintSaver à la fois (watch ou run) : sinon deux traitements du même ticket.
  const lock = acquireGlobalLock({ command: "watch" });
  try {
    const app = buildApp(config);
    const stop = installStopHandler();
    try {
      await runWatch(
        { config, gitlab: app.gitlab, store: app.store, processor: app.processor, purgeOldRuns: app.purgeOldRuns },
        { signal: stop.signal, immediateSignal: stop.immediateSignal },
      );
    } finally {
      stop.dispose();
    }
  } finally {
    lock.release();
  }
}
