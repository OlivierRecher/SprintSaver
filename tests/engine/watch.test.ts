import { describe, expect, it } from "vitest";
import type { TicketState } from "../../src/contracts.js";
import type { ProjectConfig } from "../../src/config/schema.js";
import { nextTicket } from "../../src/engine/queue.js";
import { runWatch } from "../../src/engine/watch.js";
import { CallLog, FakeGitLab, MemoryStore, makeConfig, makeProject } from "../helpers/fakes.js";

function state(over: Partial<TicketState>): TicketState {
  return {
    version: 1,
    key: "demo-1",
    projectName: "demo",
    projectId: 7,
    iid: 1,
    title: "t",
    webUrl: "u",
    phase: "implemented",
    branch: "b",
    worktreePath: "/wt",
    startedAt: "2026-11-23T08:00:00Z",
    updatedAt: "2026-11-23T08:00:00Z",
    resumeCount: 0,
    counters: { testFix: 0, review: 0, ci: 0 },
    tests: [],
    nits: [],
    proofs: [],
    flakyJobs: [],
    ...over,
  };
}

describe("nextTicket", () => {
  it("reprend d'abord un ticket en cours d'un projet configuré", async () => {
    const config = makeConfig();
    const gitlab = new FakeGitLab(new CallLog());
    const store = new MemoryStore();
    await store.save(state({ key: "demo-1", iid: 1, phase: "blocked" }));
    await store.save(state({ key: "demo-2", iid: 2, phase: "finalized" }));
    await store.save(state({ key: "other-3", iid: 3, projectName: "other" }));
    await store.save(state({ key: "demo-4", iid: 4, phase: "reviewed" }));
    gitlab.queue = [{ project: config.projects[0]!, iid: 9, title: "q", labeledAt: "2026-11-23T07:00:00Z" }];
    const next = await nextTicket({ config, gitlab, store });
    expect(next).toMatchObject({ iid: 4, source: "resume" });
    expect(gitlab.log.count("gitlab.listQueuedIssues")).toBe(0);
  });

  it("sinon prend le premier de la file GitLab", async () => {
    const config = makeConfig();
    const gitlab = new FakeGitLab(new CallLog());
    const store = new MemoryStore();
    await store.save(state({ phase: "blocked" }));
    gitlab.queue = [
      { project: config.projects[0]!, iid: 9, title: "q", labeledAt: "1" },
      { project: config.projects[0]!, iid: 10, title: "r", labeledAt: "2" },
    ];
    expect(await nextTicket({ config, gitlab, store })).toMatchObject({ iid: 9, source: "queue" });
    gitlab.queue = [];
    expect(await nextTicket({ config, gitlab, store })).toBeNull();
  });
});

describe("runWatch", () => {
  it("purge les runs, traite les tickets, survit aux erreurs de polling et s'arrête sur signal", async () => {
    const config = makeConfig();
    const gitlab = new FakeGitLab(new CallLog());
    const store = new MemoryStore();
    const ctrl = new AbortController();
    const processed: number[] = [];
    const purged: number[] = [];
    let polls = 0;
    gitlab.listQueuedIssues = async () => {
      polls += 1;
      if (polls === 1) throw new Error("GitLab 502");
      if (polls === 2) return [{ project: config.projects[0]!, iid: 5, title: "x", labeledAt: "1" }];
      return [];
    };
    const sleeps: number[] = [];
    await runWatch(
      {
        config,
        gitlab,
        store,
        purgeOldRuns: async (d) => {
          purged.push(d);
        },
        processor: {
          async process(_p: ProjectConfig, iid: number, opts) {
            processed.push(iid);
            expect(opts?.signal).toBe(ctrl.signal);
            return state({ iid, phase: "finalized" });
          },
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3) ctrl.abort();
        },
      },
      { signal: ctrl.signal },
    );
    expect(purged).toEqual([30]);
    expect(processed).toEqual([5]);
    expect(polls).toBe(3);
    expect(sleeps).toEqual([120_000, 120_000, 120_000]);
  });

  it("met de côté un ticket qui échoue 3 fois de suite hors traitement et passe au suivant", async () => {
    const config = makeConfig();
    const gitlab = new FakeGitLab(new CallLog());
    const store = new MemoryStore();
    const ctrl = new AbortController();
    const immediate = new AbortController();
    gitlab.queue = [
      { project: config.projects[0]!, iid: 5, title: "cassé", labeledAt: "1" },
      { project: config.projects[0]!, iid: 6, title: "ok", labeledAt: "2" },
    ];
    const processed: number[] = [];
    let sleeps = 0;
    await runWatch(
      {
        config,
        gitlab,
        store,
        processor: {
          async process(_p: ProjectConfig, iid: number, opts) {
            processed.push(iid);
            expect(opts?.abortNow).toBe(immediate.signal);
            if (iid === 5) throw new Error("getIssue 500");
            gitlab.queue = gitlab.queue.filter((q) => q.iid !== 6);
            return state({ iid, phase: "finalized" });
          },
        },
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 5) ctrl.abort();
        },
      },
      { signal: ctrl.signal, immediateSignal: immediate.signal },
    );
    // 3 échecs (avec attente entre les deux premiers), mise de côté, puis le suivant sans attendre ;
    // ensuite le ticket mis de côté n'est plus repris.
    expect(processed).toEqual([5, 5, 5, 6]);
  });

  it("mise à l'écart limitée à 30 min, compteur d'échecs remis à zéro à l'expiration", async () => {
    const config = makeConfig();
    const gitlab = new FakeGitLab(new CallLog());
    const store = new MemoryStore();
    const ctrl = new AbortController();
    gitlab.queue = [{ project: config.projects[0]!, iid: 5, title: "cassé", labeledAt: "1" }];
    const processedAt: number[] = [];
    let clock = 0;
    let sleeps = 0;
    await runWatch(
      {
        config,
        gitlab,
        store,
        now: () => clock,
        processor: {
          async process() {
            processedAt.push(clock / 60_000);
            throw new Error("getIssue 500");
          },
        },
        sleep: async () => {
          sleeps += 1;
          clock += 60_000; // une minute par cycle
          if (sleeps === 34) ctrl.abort();
        },
      },
      { signal: ctrl.signal },
    );
    // 3 échecs (0, 1, 2 min) → mis de côté jusqu'à 32 min ; repris ensuite avec un compteur à zéro :
    // deux nouveaux échecs ne suffisent pas à le remettre de côté.
    expect(processedAt).toEqual([0, 1, 2, 32, 33]);
  });

  it("nextTicket ignore les tickets exclus, en reprise comme en file", async () => {
    const config = makeConfig();
    const gitlab = new FakeGitLab(new CallLog());
    const store = new MemoryStore();
    await store.save(state({ key: "demo-4", iid: 4, phase: "reviewed" }));
    gitlab.queue = [
      { project: config.projects[0]!, iid: 9, title: "q", labeledAt: "1" },
      { project: config.projects[0]!, iid: 10, title: "r", labeledAt: "2" },
    ];
    expect(await nextTicket({ config, gitlab, store }, { exclude: new Set(["demo-4", "demo-9"]) })).toMatchObject({ iid: 10, source: "queue" });
  });

  it("ne purge pas si les transcripts sont désactivés et sort tout de suite si déjà arrêté", async () => {
    const config = makeConfig({ transcripts: { enabled: false, retentionDays: 30 } }, makeProject());
    const ctrl = new AbortController();
    ctrl.abort();
    let purged = false;
    await runWatch(
      {
        config,
        gitlab: new FakeGitLab(new CallLog()),
        store: new MemoryStore(),
        purgeOldRuns: async () => {
          purged = true;
        },
        processor: {
          process: async () => {
            throw new Error("ne doit pas être appelé");
          },
        },
      },
      { signal: ctrl.signal },
    );
    expect(purged).toBe(false);
  });
});
