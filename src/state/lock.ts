/**
 * Verrou global `~/.sprintsaver/sprintsaver.lock` : un seul processus SprintSaver (`watch` ou `run`) traite
 * des tickets à la fois, sinon deux processus pourraient travailler sur le même ticket et le même worktree.
 *
 * Le fichier contient `{ pid, startedAt, command }`. Il est créé de façon atomique (fichier temporaire complet
 * puis `link`). S'il existe et que son pid est vivant, l'acquisition échoue avec un message clair ; si le pid
 * est mort (crash, kill -9), le verrou est périmé et repris. Il est libéré par `release()` et, en filet, à la sortie du processus.
 */
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../log.js";

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockInfo {
  pid: number;
  startedAt: string;
  command?: string;
}

export interface GlobalLock {
  readonly path: string;
  release(): void;
}

export function globalLockPath(): string {
  return join(paths.home(), "sprintsaver.lock");
}

/** Le processus `pid` existe-t-il ? (EPERM : il existe mais appartient à un autre utilisateur). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLock(raw: string): LockInfo | null {
  try {
    const data = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof data.pid !== "number") return null;
    return { pid: data.pid, startedAt: String(data.startedAt ?? "?"), command: data.command };
  } catch {
    return null;
  }
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "";
  }
}

function readLock(path: string): LockInfo | null {
  const raw = readRaw(path);
  return raw === null ? null : parseLock(raw);
}

/** Âge du fichier (ms), ou null s'il n'existe plus. */
function ageMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Attente synchrone (l'acquisition est synchrone et brève). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Un verrou vide ou illisible plus récent que ce délai est considéré comme en cours d'écriture. */
export const LOCK_WRITE_GRACE_MS = 5_000;
const RETRY_DELAY_MS = 100;
const MAX_ATTEMPTS = 100;

export interface AcquireOptions {
  path?: string;
  command?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  /** Enregistre la libération à la sortie du processus (défaut : true). */
  releaseOnExit?: boolean;
  /** Attente entre deux essais (injectable pour les tests). */
  sleep?: (ms: number) => void;
}

/**
 * Acquisition sans course : le contenu complet est écrit dans un fichier temporaire, puis lié atomiquement au
 * chemin du verrou (`link` échoue avec EEXIST si un verrou existe), si bien qu'un verrou n'est jamais visible
 * vide ou partiel. Un verrou périmé n'est supprimé que si, relu juste avant la suppression, son contenu est
 * toujours celui jugé périmé (sinon un autre processus l'a repris entre-temps). Un verrou vide ou illisible
 * récent (< LOCK_WRITE_GRACE_MS) est supposé en cours d'écriture (ancienne version) : on attend.
 */
export function acquireGlobalLock(opts: AcquireOptions = {}): GlobalLock {
  const path = opts.path ?? globalLockPath();
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? sleepSync;
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = { pid, startedAt: now().toISOString(), command: opts.command };
  const content = `${JSON.stringify(info)}\n`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const tmp = `${path}.${pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, content, { flag: "wx" });
    let linked = false;
    try {
      linkSync(tmp, path);
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // déjà supprimé
      }
    }
    if (linked) return makeLock(path, pid, opts.releaseOnExit !== false);

    const raw = readRaw(path);
    if (raw === null) continue; // libéré entre-temps : nouvel essai
    const holder = parseLock(raw);
    if (holder && holder.pid !== pid && isAlive(holder.pid)) {
      throw new LockError(
        `SprintSaver tourne déjà (pid ${holder.pid}${holder.command ? `, « ${holder.command} »` : ""}, depuis ${holder.startedAt}). ` +
          `Arrêtez-le avant d'en lancer un autre. Si ce processus n'est pas SprintSaver, supprimez ${path}.`,
      );
    }
    if (!holder) {
      const age = ageMs(path);
      if (age === null) continue;
      if (age < LOCK_WRITE_GRACE_MS) {
        // Vide ou illisible mais récent : probablement en cours d'écriture par un autre processus.
        sleep(RETRY_DELAY_MS);
        continue;
      }
    }
    // Verrou périmé (pid mort), illisible et ancien, ou déjà à nous : repris, seulement s'il n'a pas changé.
    if (readRaw(path) !== raw) continue;
    log.warn({ path, holder }, "Verrou SprintSaver périmé : repris");
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  throw new LockError(`Impossible de prendre le verrou ${path} (concurrence avec un autre processus ?)`);
}

function makeLock(path: string, pid: number, releaseOnExit: boolean): GlobalLock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    const holder = readLock(path);
    if (holder?.pid !== pid) return; // repris par un autre entre-temps : on n'y touche pas
    try {
      unlinkSync(path);
    } catch {
      // déjà supprimé
    }
  };
  if (releaseOnExit) process.on("exit", release);
  return { path, release };
}
