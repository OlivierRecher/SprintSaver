import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireGlobalLock, globalLockPath, isProcessAlive, LockError } from "../../src/state/lock.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-lock-"));
  path = join(dir, "sprintsaver.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireGlobalLock", () => {
  it("se trouve dans le dossier SprintSaver", () => {
    process.env.SPRINTSAVER_HOME = dir;
    try {
      expect(globalLockPath()).toBe(path);
    } finally {
      delete process.env.SPRINTSAVER_HOME;
    }
  });

  it("écrit pid et date, refuse un second preneur vivant, puis se libère", () => {
    const lock = acquireGlobalLock({ path, pid: 111, command: "watch", isAlive: () => true, releaseOnExit: false });
    const info = JSON.parse(readFileSync(path, "utf8"));
    expect(info.pid).toBe(111);
    expect(typeof info.startedAt).toBe("string");
    expect(() => acquireGlobalLock({ path, pid: 222, command: "run", isAlive: () => true, releaseOnExit: false })).toThrow(LockError);
    expect(() => acquireGlobalLock({ path, pid: 222, isAlive: () => true, releaseOnExit: false })).toThrow(/pid 111.*watch/);
    lock.release();
    expect(existsSync(path)).toBe(false);
    const again = acquireGlobalLock({ path, pid: 222, isAlive: () => true, releaseOnExit: false });
    again.release();
  });

  it("reprend un verrou périmé (pid mort) ou illisible", () => {
    writeFileSync(path, JSON.stringify({ pid: 999_999, startedAt: "2026-01-01T00:00:00Z" }));
    const lock = acquireGlobalLock({ path, pid: 333, isAlive: (p) => p !== 999_999, releaseOnExit: false });
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(333);
    lock.release();
    writeFileSync(path, "pas du json");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // illisible ET ancien : pas en cours d'écriture
    acquireGlobalLock({ path, pid: 334, releaseOnExit: false, sleep: () => expect.unreachable() }).release();
  });

  it("écrit le verrou de façon atomique : aucun fichier temporaire ne reste", () => {
    const lock = acquireGlobalLock({ path, pid: 335, releaseOnExit: false });
    expect(readdirSync(dir)).toEqual(["sprintsaver.lock"]);
    expect(() => acquireGlobalLock({ path, pid: 336, isAlive: () => true, releaseOnExit: false })).toThrow(LockError);
    expect(readdirSync(dir)).toEqual(["sprintsaver.lock"]);
    lock.release();
  });

  it("verrou vide et récent : en cours d'écriture, on attend au lieu de le supprimer", () => {
    writeFileSync(path, "");
    const sleeps: number[] = [];
    const take = () =>
      acquireGlobalLock({
        path,
        pid: 337,
        isAlive: (p) => p === 888,
        releaseOnExit: false,
        sleep: (ms) => {
          sleeps.push(ms);
          // L'autre processus finit d'écrire son verrou pendant l'attente.
          writeFileSync(path, JSON.stringify({ pid: 888, startedAt: "2026-11-23T10:00:00Z", command: "watch" }));
        },
      });
    expect(take).toThrow(/pid 888/);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(888);
  });

  it("verrou périmé repris par un autre processus entre l'examen et la suppression : non supprimé", () => {
    writeFileSync(path, JSON.stringify({ pid: 999_999, startedAt: "2026-01-01T00:00:00Z" }));
    const take = () =>
      acquireGlobalLock({
        path,
        pid: 338,
        releaseOnExit: false,
        isAlive: (p) => {
          if (p === 999_999) {
            // Un autre SprintSaver supprime le verrou périmé et prend le sien juste après notre lecture.
            writeFileSync(path, JSON.stringify({ pid: 777, startedAt: "2026-11-23T10:00:00Z", command: "run demo#1" }));
            return false;
          }
          return p === 777;
        },
      });
    expect(take).toThrow(/pid 777/);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(777);
  });

  it("ne supprime pas un verrou repris par un autre processus", () => {
    const lock = acquireGlobalLock({ path, pid: 444, releaseOnExit: false });
    writeFileSync(path, JSON.stringify({ pid: 555, startedAt: "x" }));
    lock.release();
    expect(existsSync(path)).toBe(true);
  });
});

describe("isProcessAlive", () => {
  it("vrai pour le processus courant, faux pour un pid invalide", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
