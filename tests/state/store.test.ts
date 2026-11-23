import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paths } from "../../src/config/paths.js";
import { createStateStore, newTicketState } from "../../src/state/store.js";
import { createRunRecorder, purgeOldRuns, transcriptPath } from "../../src/state/runs.js";
import type { PhaseSummary } from "../../src/contracts.js";

let home: string;
const prevHome = process.env.SPRINTSAVER_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ss-state-"));
  process.env.SPRINTSAVER_HOME = home;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.SPRINTSAVER_HOME;
  else process.env.SPRINTSAVER_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

function sample(key = "proj-1") {
  return newTicketState({
    key,
    projectName: "proj",
    projectId: 42,
    iid: 1,
    title: "Titre",
    webUrl: "https://gitlab.example/proj/-/issues/1",
    branch: "sprintsaver/1-titre",
    worktreePath: "/tmp/wt",
  });
}

describe("newTicketState", () => {
  it("remplit les valeurs par défaut", () => {
    const s = sample();
    expect(s).toMatchObject({
      version: 1,
      phase: "picked",
      resumeCount: 0,
      counters: { testFix: 0, review: 0, ci: 0 },
      tests: [],
      nits: [],
      proofs: [],
      flakyJobs: [],
    });
    expect(Date.parse(s.startedAt)).not.toBeNaN();
  });

  it("garde les valeurs fournies", () => {
    const s = newTicketState({ ...sample(), phase: "analysed", counters: { testFix: 2, review: 0, ci: 0 } });
    expect(s.phase).toBe("analysed");
    expect(s.counters.testFix).toBe(2);
  });
});

describe("createStateStore", () => {
  it("save / load / remove", async () => {
    const store = createStateStore();
    expect(await store.load("proj-1")).toBeNull();
    const s = sample();
    s.updatedAt = "2000-01-01T00:00:00.000Z";
    await store.save(s);
    expect(s.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
    const loaded = await store.load("proj-1");
    expect(loaded).toEqual(s);
    expect(await readdir(paths.stateDir())).toEqual(["proj-1.json"]); // pas de .tmp résiduel
    await store.remove("proj-1");
    await store.remove("proj-1"); // idempotent
    expect(await store.load("proj-1")).toBeNull();
  });

  it("écrase atomiquement un état existant", async () => {
    const store = createStateStore();
    const s = sample();
    await store.save(s);
    s.phase = "implemented";
    await store.save(s);
    const raw = JSON.parse(await readFile(paths.stateFile("proj-1"), "utf8"));
    expect(raw.phase).toBe("implemented");
  });

  it("list trie du plus récent au plus ancien et ignore les fichiers invalides", async () => {
    const store = createStateStore();
    const a = sample("proj-1");
    await store.save(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = sample("proj-2");
    await store.save(b);
    await writeFile(join(paths.stateDir(), "broken.json"), "{not json");
    const list = await store.list();
    expect(list.map((s) => s.key)).toEqual(["proj-2", "proj-1"]);
  });

  it("list sur un dossier absent renvoie []", async () => {
    expect(await createStateStore(join(home, "nope")).list()).toEqual([]);
  });

  it("refuse une version inconnue avec une erreur claire", async () => {
    const dir = paths.stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "proj-9.json"), JSON.stringify({ ...sample("proj-9"), version: 2 }));
    await expect(createStateStore().load("proj-9")).rejects.toThrow(/version 2 non supportée/);
    await writeFile(join(dir, "proj-9.json"), "oops");
    await expect(createStateStore().load("proj-9")).rejects.toThrow(/JSON invalide/);
  });

  it("refuse une clé qui sortirait du dossier", async () => {
    await expect(createStateStore().load("../etc/passwd")).rejects.toThrow(/Clé de ticket invalide/);
  });
});

describe("runs", () => {
  const summary = (phase: PhaseSummary["phase"], iteration = 1): PhaseSummary => ({
    ticketKey: "proj-1",
    phase,
    iteration,
    startedAt: new Date().toISOString(),
    durationMs: 1234,
    outcome: "ok",
    facts: ["fait"],
  });

  it("enregistre et relit les résumés dans l'ordre", async () => {
    const rec = createRunRecorder();
    expect(await rec.readSummaries("proj-1")).toEqual([]);
    await rec.recordPhase(summary("analyse"));
    await rec.recordPhase(summary("implement", 2));
    const out = await rec.readSummaries("proj-1");
    expect(out.map((s) => `${s.phase}-${s.iteration}`)).toEqual(["analyse-1", "implement-2"]);
    const raw = await readFile(join(paths.run("proj-1"), "summaries.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("transcriptPath", () => {
    expect(transcriptPath("proj-1", "review", 3)).toBe(join(home, "runs", "proj-1", "review-3.jsonl"));
  });

  it("purgeOldRuns supprime les dossiers trop vieux", async () => {
    const rec = createRunRecorder();
    await rec.recordPhase(summary("analyse"));
    await rec.recordPhase({ ...summary("analyse"), ticketKey: "proj-2" });
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const oldDir = paths.run("proj-2");
    await utimes(join(oldDir, "summaries.jsonl"), old, old);
    await utimes(oldDir, old, old);
    expect(await purgeOldRuns(30)).toBe(1);
    expect(await readdir(paths.runsDir())).toEqual(["proj-1"]);
    expect(await purgeOldRuns(30)).toBe(0);
  });

  it("purgeOldRuns sans dossier runs renvoie 0", async () => {
    expect(await purgeOldRuns(30)).toBe(0);
  });
});
