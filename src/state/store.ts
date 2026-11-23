import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import type { StateStore, TicketState } from "../contracts.js";
import { log } from "../log.js";

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class StateFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`Fichier d'état ${file} : ${message}`);
    this.name = "StateFileError";
  }
}

export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`Clé de ticket invalide : « ${key} »`);
}

/**
 * Un fichier JSON par ticket dans `dir`. Écriture atomique (fichier temporaire + rename).
 * `list()` renvoie les états du plus récemment modifié au plus ancien.
 */
export function createStateStore(dir = paths.stateDir()): StateStore {
  const fileFor = (key: string) => {
    assertValidKey(key);
    return join(dir, `${key}.json`);
  };

  async function readState(file: string): Promise<TicketState | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new StateFileError(file, `JSON invalide (${(err as Error).message})`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new StateFileError(file, "contenu inattendu (objet JSON attendu)");
    }
    const obj = data as Record<string, unknown>;
    if (obj.version !== 1) {
      throw new StateFileError(file, `version ${JSON.stringify(obj.version)} non supportée (attendu 1)`);
    }
    for (const field of ["key", "phase", "branch", "updatedAt"] as const) {
      if (typeof obj[field] !== "string") throw new StateFileError(file, `champ « ${field} » manquant ou invalide`);
    }
    return obj as unknown as TicketState;
  }

  return {
    async load(key) {
      return readState(fileFor(key));
    },

    async save(state) {
      const file = fileFor(state.key);
      state.updatedAt = new Date().toISOString();
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        const fh = await open(tmp, "w");
        try {
          await fh.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
      const states: TicketState[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const s = await readState(join(dir, name));
          if (s) states.push(s);
        } catch (err) {
          log.warn({ err: (err as Error).message }, "fichier d'état ignoré");
        }
      }
      return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async remove(key) {
      try {
        await unlink(fileFor(key));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    },
  };
}

export type NewTicketStateInit = Pick<
  TicketState,
  "key" | "projectName" | "projectId" | "iid" | "title" | "webUrl" | "branch" | "worktreePath"
> &
  Partial<Omit<TicketState, "version">>;

/** État initial d'un ticket, avec les valeurs par défaut (phase "picked", compteurs à 0, listes vides). */
export function newTicketState(init: NewTicketStateInit): TicketState {
  const now = new Date().toISOString();
  return {
    phase: "picked",
    startedAt: now,
    updatedAt: now,
    resumeCount: 0,
    tests: [],
    nits: [],
    proofs: [],
    flakyJobs: [],
    ...init,
    counters: { testFix: 0, review: 0, ci: 0, ...init.counters },
    version: 1,
  };
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
