import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import type { PhaseSummary, RunRecorder } from "../contracts.js";
import { log } from "../log.js";
import { assertValidKey } from "./store.js";

const SUMMARIES_FILE = "summaries.jsonl";

function summariesFile(ticketKey: string): string {
  assertValidKey(ticketKey);
  return join(paths.run(ticketKey), SUMMARIES_FILE);
}

/** Résumés de phase en JSONL dans `runs/<clé>/summaries.jsonl` (une ligne par phase). */
export function createRunRecorder(): RunRecorder {
  return {
    async recordPhase(summary) {
      const file = summariesFile(summary.ticketKey);
      await mkdir(paths.run(summary.ticketKey), { recursive: true });
      await appendFile(file, `${JSON.stringify(summary)}\n`, "utf8");
    },

    async readSummaries(ticketKey) {
      const file = summariesFile(ticketKey);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
      const result: PhaseSummary[] = [];
      for (const [i, line] of raw.split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          result.push(JSON.parse(line) as PhaseSummary);
        } catch {
          log.warn({ file, line: i + 1 }, "ligne de résumé illisible ignorée");
        }
      }
      return result;
    },
  };
}

/** Chemin du transcript d'une session agent (le dossier n'est pas créé). */
export function transcriptPath(key: string, phase: string, iteration: number): string {
  assertValidKey(key);
  return join(paths.run(key), `${phase}-${iteration}.jsonl`);
}

/**
 * Supprime les dossiers de `runs/` dont la dernière activité (mtime du dossier ou de ses fichiers directs)
 * est plus vieille que `retentionDays`. Retourne le nombre de dossiers supprimés.
 */
export async function purgeOldRuns(retentionDays: number): Promise<number> {
  const root = paths.runsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw err;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const last = await lastActivity(dir);
    if (last < cutoff) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  if (removed > 0) log.info({ removed, retentionDays }, "anciens runs purgés");
  return removed;
}

async function lastActivity(dir: string): Promise<number> {
  let latest = (await stat(dir)).mtimeMs;
  for (const name of await readdir(dir)) {
    const st = await stat(join(dir, name)).catch(() => null);
    if (st && st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return latest;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
