import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunError, type TicketState } from "../../src/contracts.js";
import type { Config, ProjectConfig } from "../../src/config/schema.js";
import { paths } from "../../src/config/paths.js";
import { createTicketProcessor, mrTitle } from "../../src/engine/processor.js";
import {
  CallLog,
  FakeAgent,
  FakeGit,
  FakeGitLab,
  MemoryRecorder,
  MemoryStore,
  basePipeline,
  ciFailed,
  ciNoRunner,
  ciSuccess,
  job,
  makeConfig,
  makeProject,
  red,
} from "../helpers/fakes.js";

const KEY = "demo-12";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sprintsaver-engine-"));
  process.env.SPRINTSAVER_HOME = home;
});
afterEach(() => {
  delete process.env.SPRINTSAVER_HOME;
  rmSync(home, { recursive: true, force: true });
});

interface Harness {
  log: CallLog;
  gitlab: FakeGitLab;
  git: FakeGit;
  agent: FakeAgent;
  store: MemoryStore;
  recorder: MemoryRecorder;
  config: Config;
  project: ProjectConfig;
  clock: { now: Date };
  run: (opts?: { manual?: boolean }) => Promise<TicketState>;
}

function harness(opts: { config?: Partial<Config>; project?: Partial<ProjectConfig> } = {}): Harness {
  const log = new CallLog();
  const gitlab = new FakeGitLab(log);
  const git = new FakeGit(log);
  const agent = new FakeAgent(log, gitlab);
  const store = new MemoryStore();
  const recorder = new MemoryRecorder();
  const project = makeProject(opts.project);
  const config = makeConfig(opts.config, project);
  const clock = { now: new Date("2026-11-23T10:00:00Z") };
  const skillsRepoRoot = join(home, "tool");
  const processor = createTicketProcessor({ config, gitlab, git, agent, store, recorder, now: () => clock.now, skillsRepoRoot });
  return {
    log,
    gitlab,
    git,
    agent,
    store,
    recorder,
    config,
    project,
    clock,
    run: (o) => processor.process(project, 12, o),
  };
}

function before(h: Harness, a: string, b: string): void {
  const ia = h.log.indexOf(a);
  const ib = h.log.indexOf(b);
  expect(ia, `${a} absent`).toBeGreaterThanOrEqual(0);
  expect(ib, `${b} absent`).toBeGreaterThanOrEqual(0);
  expect(ia, `${a} doit précéder ${b}`).toBeLessThan(ib);
}

/** Exécute un parcours nominal jusqu'à `phase` puis fabrique l'état tel qu'un crash l'aurait laissé. */
async function stateAt(phase: TicketState["phase"]): Promise<TicketState> {
  const h = harness({ config: { retro: { enabled: false } } });
  await h.run();
  const final = (await h.store.load(KEY))!;
  return {
    ...final,
    phase,
    mrIid: undefined,
    mrUrl: undefined,
    reviewedSha: undefined,
    proofs: [],
    nits: [],
    counters: { testFix: 0, review: 0, ci: 0 },
    deliverySteps: undefined,
  };
}

describe("glab connecté avec un jeton de projet (ADR, amendements 1 et 2)", () => {
  const human = { url: "https://gitlab.com", username: "olivier", userId: 5 };
  const withBot = (h: Harness) => {
    let calls = 0;
    // Le jeton est celui du bot : GitLab le verrait comme utilisateur courant. Le moteur ne doit jamais s'en servir.
    h.gitlab.currentUser = async () => {
      calls++;
      return { id: 900, username: "project_7_bot", name: "bot" };
    };
    return () => calls;
  };

  it("la MR est assignée à l'humain de la config, jamais au bot du jeton", async () => {
    const h = harness({ config: { gitlab: human } });
    const currentUserCalls = withBot(h);
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.gitlab.mrUpdates.at(-1)!.patch.assigneeIds).toEqual([5]);
    expect(currentUserCalls()).toBe(0);
  });

  it("les mentions des commentaires visent l'humain, pas le bot", async () => {
    const h = harness({ config: { gitlab: human } });
    withBot(h);
    h.agent.on("analyse", () => ({
      type: "feature",
      summary: "s",
      plan: [],
      criteria: [],
      precedents: [],
      assumptions: [],
      blockingQuestions: ["Quel arrondi ?"],
    }));
    await h.run();
    const comment = h.gitlab.comments.at(-1)!;
    expect(comment).toContain("@olivier");
    expect(comment).not.toContain("project_7_bot");
  });
});

describe("parcours nominal", () => {
  it("mène le ticket jusqu'à la MR Ready, dans le bon ordre", async () => {
    const h = harness();
    const state = await h.run();

    expect(state.phase).toBe("finalized");
    expect(state.branch).toBe("sprintsaver/12-afficher-le-total-du-panier");
    expect(state.worktreePath).toBe(paths.worktree(KEY));

    // Prise en charge : label retiré puis statut en cours, avant toute session agent.
    before(h, "gitlab.removeLabel:auto::ready", "gitlab.setStatus:inProgress");
    before(h, "gitlab.setStatus:inProgress", "git.createOrReuseWorktree");
    before(h, "git.prepareWorktree", "agent.analyse");

    // Sessions dans l'ordre de l'ADR.
    expect(h.agent.phases()).toEqual(["analyse", "write-tests", "implement", "review", "verify-criteria", "mr-writeup", "retro"]);

    // Commits conventionnels.
    expect(h.git.commits).toEqual(["test: tests des critères du ticket #12", "feat: Afficher le total du panier (#12)"]);
    before(h, "git.commit:feat", "git.run:npm test");
    before(h, "git.run:npm test", "agent.review");

    // MR draft, puis CI, puis ready et assignée.
    before(h, "agent.verify-criteria", "git.push");
    before(h, "git.push", "gitlab.createDraftMr");
    expect(h.log.indexOf("gitlab.createDraftMr:Afficher le total du panier (#12)")).toBeGreaterThanOrEqual(0);
    before(h, "gitlab.createDraftMr", "gitlab.waitForPipeline");
    before(h, "gitlab.waitForPipeline", "git.rebaseOnDefault");
    before(h, "agent.mr-writeup", "gitlab.updateMr:assignee=42");
    before(h, "gitlab.updateMr:assignee=42", "gitlab.markMrReady");
    const final = h.gitlab.mrUpdates.at(-1)!;
    expect(final.patch.title).toBe("Total du panier (#12)");
    expect(final.patch.assigneeIds).toEqual([42]);

    // Cases prouvées cochées (0 et 1), la non testable reste décochée.
    before(h, "gitlab.markMrReady", "gitlab.updateIssueDescription");
    expect(h.gitlab.issue.description).toContain("- [x] le bouton affiche le total");
    expect(h.gitlab.issue.description).toContain("- [x] le total est arrondi au centime");
    expect(h.gitlab.issue.description).toContain("- [ ] le design est joli");

    // Statut livré, commentaire, worktree supprimé, en dernier.
    before(h, "gitlab.updateIssueDescription", "gitlab.setStatus:inReview");
    before(h, "gitlab.setStatus:inReview", "git.removeWorktree");
    expect(existsSync(state.worktreePath)).toBe(false);
    expect(h.gitlab.comments).toHaveLength(2); // prise en charge + livraison
    expect(h.gitlab.comments[1]).toContain(state.mrUrl!);

    // État cohérent et sauvegardé à chaque phase.
    expect(state.analysis?.criteria.map((c) => c.testable)).toEqual([true, true, false]);
    expect(state.proofs.filter((p) => p.proven).map((p) => p.index)).toEqual([0, 1]);
    expect(state.tests).toHaveLength(2);
    expect(state.nits).toHaveLength(1);
    expect(state.pickupCommented).toBe(true);
    for (const phase of ["picked", "prepared", "analysed", "tests_written", "implemented", "tests_green", "reviewed", "pushed", "ci_green", "finalized"]) {
      expect(h.store.savedPhases).toContain(phase);
    }

    // Résumés de phase et rétro.
    expect(h.recorder.summaries.map((s) => s.phase)).toEqual(
      expect.arrayContaining(["analyse", "tests-local", "review", "ci", "mr-writeup", "retro"]),
    );
    const retroReq = h.agent.requests.find((r) => r.phase === "retro")!;
    expect(retroReq.worktreePath).toBe(join(home, "tool"));
    expect(retroReq.prompt).toContain("Projet : demo");
    expect(readFileSync(join(paths.run(KEY), "retro.md"), "utf8")).toContain("lancer les tests plus tôt");
    expect(readFileSync(join(paths.run(KEY), "retro.patch"), "utf8")).toContain("skills/projects/demo.md");
  });

  it("donne aux sessions le ticket, les images et la branche par défaut, mais pas le résumé de l'implémenteur à la review", async () => {
    const h = harness();
    h.agent.on("implement", () => ({ summary: "RESUME-IMPLEMENTEUR", testsAdjusted: [], testsPassingLocally: true }));
    await h.run();
    const analyse = h.agent.requests.find((r) => r.phase === "analyse")!;
    expect(analyse.context).toContain("Afficher le total du panier");
    expect(analyse.context).toContain("@bob");
    expect(analyse.context).toContain(join(".sprintsaver", "images", "shot.png"));
    expect(analyse.context).toContain("origin/main");
    const review = h.agent.requests.find((r) => r.phase === "review")!;
    expect(`${review.prompt}${review.context}`).not.toContain("RESUME-IMPLEMENTEUR");
    expect(review.prompt).toContain("diff --git");
  });

  it("utilise fix: et le type bug quand les labels le disent", async () => {
    const h = harness();
    h.gitlab.issue = { ...h.gitlab.issue, labels: ["bug"] };
    const state = await h.run();
    expect(state.analysis?.type).toBe("bug");
    expect(state.analysis?.typeSource).toBe("labels");
    expect(h.git.commits[1]).toBe("fix: Afficher le total du panier (#12)");
    expect(h.agent.requests.find((r) => r.phase === "analyse")!.ticketType).toBe("bug");
  });

  it("ticket déjà livré : commente, retire le label et ne fait rien d'autre", async () => {
    const h = harness();
    await h.run();
    h.log.entries.length = 0;
    h.gitlab.comments.length = 0;
    const again = await h.run();
    expect(again.phase).toBe("finalized");
    expect(h.gitlab.comments).toHaveLength(1);
    expect(h.gitlab.comments[0]).toContain("déjà été livré");
    expect(h.log.entries.filter((e) => !e.startsWith("gitlab.comment") && !e.startsWith("gitlab.removeLabel"))).toEqual([]);
  });
});

describe("blocages à l'analyse", () => {
  it("questions bloquantes : needs-info, mention de l'auteur et de l'utilisateur", async () => {
    const h = harness();
    h.agent.on("analyse", () => ({
      type: "feature",
      summary: "s",
      plan: [],
      criteria: [],
      precedents: [],
      assumptions: [],
      blockingQuestions: ["Quel arrondi ?"],
    }));
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.phaseBeforeBlock).toBe("prepared");
    expect(state.blockedReason).toMatch(/ambiguïtés/);
    expect(h.agent.phases()).toEqual(["analyse", "retro"]);
    const comment = h.gitlab.comments.at(-1)!;
    expect(comment).toContain("@alice");
    expect(comment).toContain("@me");
    expect(comment).toContain("Quel arrondi ?");
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(1);
    expect(h.git.pushes).toHaveLength(0); // aucun commit : rien à pousser
    expect(existsSync(state.worktreePath)).toBe(true);
  });

  it("aucune case à cocher : blocage sans session d'analyse", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.issue = { ...h.gitlab.issue, description: "Juste du texte.\n\n```\n- [ ] dans un bloc de code\n```" };
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(h.agent.phases()).toEqual([]);
    expect(h.gitlab.comments.at(-1)).toContain("aucune case à cocher");
    expect(h.gitlab.comments.at(-1)).toContain("@alice");
  });
});

describe("boucles", () => {
  it("plafond test/fix : bloqué, WIP poussé, worktree conservé", async () => {
    const h = harness({ config: { limits: { ...makeConfig().limits, testFix: 2 } } });
    h.git.testResults = [red(), red(), red(), red()];
    h.agent.on("test-fix", () => {
      h.git.dirty = true; // la dernière correction laisse des fichiers modifiés
      return { summary: "x", rootCause: "y", testsAdjusted: [], unrelatedToTicket: false };
    });
    h.git.commitAll = (() => {
      const orig = FakeGit.prototype.commitAll.bind(h.git);
      return async (wt: string, msg: string) => (msg.startsWith("fix: corrige") ? null : orig(wt, msg));
    })();
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.phaseBeforeBlock).toBe("implemented");
    expect(state.counters.testFix).toBe(3);
    expect(state.blockedReason).toMatch(/test\/fix/);
    expect(h.agent.phases().filter((p) => p === "test-fix")).toHaveLength(2);
    expect(h.git.commits.at(-1)).toBe("wip: travail en cours SprintSaver");
    expect(h.git.pushes).toHaveLength(1);
    expect(h.log.count("git.removeWorktree")).toBe(0);
    expect(existsSync(state.worktreePath)).toBe(true);
    expect(h.gitlab.comments.at(-1)).toContain("total arrondi"); // test en échec repéré dans la sortie
    const local = h.recorder.summaries.filter((s) => s.phase === "tests-local");
    expect(local.map((s) => s.outcome)).toEqual(["retry", "retry", "blocked"]);
  });

  it("review avec un bloquant puis OK", async () => {
    const h = harness();
    h.agent.on("review", [
      { findings: [{ severity: "blocking", category: "bug", file: "src/cart.ts", line: 3, description: "division par zéro" }], summary: "" },
      { findings: [], summary: "ok" },
    ]);
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.counters.review).toBe(1);
    expect(h.agent.phases()).toEqual([
      "analyse",
      "write-tests",
      "implement",
      "review",
      "verify-criteria",
      "review-fix",
      "review",
      "verify-criteria",
      "mr-writeup",
      "retro",
    ]);
    expect(h.agent.requests.find((r) => r.phase === "review-fix")!.prompt).toContain("division par zéro");
    expect(h.git.commits).toContain("fix(review): corrige les retours de review (#12)");
    before(h, "git.commit:fix(review)", "agent.mr-writeup");
    expect(h.log.count("git.run:npm test")).toBe(2); // tests relancés après le correctif
  });

  it("critère non prouvé : devient un finding bloquant puis review-fix", async () => {
    const h = harness();
    h.agent.on("verify-criteria", [
      { proofs: [{ index: 0, proven: true, tests: ["t"], reason: "ok" }, { index: 1, proven: false, tests: [], reason: "n'asserte pas l'arrondi" }] },
      { proofs: [{ index: 0, proven: true, tests: ["t"], reason: "ok" }, { index: 1, proven: true, tests: ["t2"], reason: "ok" }] },
    ]);
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    const fix = h.agent.requests.find((r) => r.phase === "review-fix")!;
    expect(fix.prompt).toContain("[criterion]");
    expect(fix.prompt).toContain("n'asserte pas l'arrondi");
    expect(state.proofs.every((p) => p.proven)).toBe(true);
  });

  it("plafond de review : bloqué", async () => {
    const h = harness({ config: { retro: { enabled: false }, limits: { ...makeConfig().limits, review: 1 } } });
    h.agent.on("review", () => ({ findings: [{ severity: "blocking", category: "security", description: "injection SQL" }], summary: "" }));
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toMatch(/review/);
    expect(h.gitlab.comments.at(-1)).toContain("injection SQL");
  });
});

describe("CI", () => {
  it("job instable : relance réussie → flakyJobs, livraison", async () => {
    const h = harness();
    h.gitlab.pipelineOutcomes = [ciFailed([job("e2e")])];
    h.gitlab.retryOutcomes = [ciSuccess()];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.flakyJobs).toEqual(["e2e"]);
    expect(h.agent.phases()).not.toContain("ci-fix");
    expect(h.log.count("gitlab.latestFinishedPipeline")).toBe(0);
  });

  it("CI de la base cassée : blocage spécial, sans ci-fix", async () => {
    const h = harness();
    h.gitlab.pipelineOutcomes = [ciFailed()];
    h.gitlab.retryOutcomes = [ciFailed()];
    h.gitlab.base = basePipeline("failed");
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.phaseBeforeBlock).toBe("pushed");
    expect(state.blockedReason).toMatch(/CI de main cassée/);
    expect(h.agent.phases()).not.toContain("ci-fix");
    expect(h.gitlab.comments.at(-1)).toContain("https://gitlab.example.com/p/99");
    expect(h.gitlab.mrUpdates.length).toBeGreaterThan(0); // description de MR mise à jour
  });

  it("ci-fix puis vert : commit, tests, re-review du delta, push", async () => {
    const h = harness();
    h.gitlab.pipelineOutcomes = [ciFailed([job("unit", 31)]), ciSuccess()];
    h.gitlab.retryOutcomes = [ciFailed([job("unit", 32)])];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.counters.ci).toBe(1);
    const ciFix = h.agent.requests.find((r) => r.phase === "ci-fix")!;
    expect(ciFix.prompt).toContain("log du job 32");
    expect(h.git.commits).toContain("fix(ci): corrige la CI (#12)");
    before(h, "git.commit:fix(ci)", "git.diffRange");
    expect(h.git.diffRanges).toEqual([["sha2", "sha3"]]);
    // review complète + review du delta, une seule vérification des critères
    expect(h.agent.phases().filter((p) => p === "review")).toHaveLength(2);
    expect(h.agent.phases().filter((p) => p === "verify-criteria")).toHaveLength(1);
    expect(h.git.pushes.map((p) => p.head)).toEqual(["sha2", "sha3"]);
    expect(h.gitlab.waitCalls.map((c) => c.sha)).toEqual(["sha2", "sha3"]);
    expect(state.reviewedSha).toBe("sha3");
  });
});

describe("reprise", () => {
  it("après un crash à implemented : reprend aux tests sans refaire l'analyse", async () => {
    const saved = await stateAt("implemented");
    const h = harness();
    await h.store.save(saved);
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.agent.phases()).toEqual(["review", "verify-criteria", "mr-writeup", "retro"]);
    expect(h.log.entries[0]).toBe("git.run:npm test"); // rien d'autre avant les tests
    expect(h.log.count("gitlab.removeLabel")).toBe(0);
    expect(h.log.count("gitlab.setStatus:inProgress")).toBe(0);
    before(h, "git.run:npm test", "agent.review");
    expect(h.gitlab.comments).toHaveLength(1); // seulement la livraison
  });

  it("ticket bloqué remis en file : compteurs remis à zéro, analyse refaite, même branche", async () => {
    const saved = await stateAt("blocked");
    const h = harness();
    await h.store.save({
      ...saved,
      phaseBeforeBlock: "tests_green",
      blockedReason: "plafond",
      counters: { testFix: 5, review: 2, ci: 0 },
      branch: "sprintsaver/12-ancien-titre",
      startedAt: "2026-11-20T08:00:00Z",
    });
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.resumeCount).toBe(1);
    expect(state.branch).toBe("sprintsaver/12-ancien-titre");
    expect(state.counters).toEqual({ testFix: 0, review: 0, ci: 0 });
    expect(state.startedAt).toBe("2026-11-23T10:00:00.000Z");
    expect(state.blockedReason).toBeUndefined();
    before(h, "gitlab.removeLabel", "gitlab.setStatus:inProgress");
    expect(h.agent.phases()[0]).toBe("analyse");
    expect(h.log.indexOf("git.createOrReuseWorktree:sprintsaver/12-ancien-titre")).toBeGreaterThanOrEqual(0);
  });

  it("durée maximale dépassée (temps actif cumulé) : bloqué avant la phase suivante", async () => {
    const saved = await stateAt("implemented");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, activeMs: 4 * 3_600_000 }); // 4 h actives > 180 min
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toMatch(/durée maximale/);
    expect(h.agent.phases()).toEqual([]);
    expect(h.log.count("git.run")).toBe(0);
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(1);
  });

  it("arrêt demandé : s'arrête après la phase en cours sans bloquer", async () => {
    const h = harness();
    const ctrl = new AbortController();
    h.agent.on("write-tests", () => {
      ctrl.abort();
      return { tests: [], redEvidence: "", notes: "" };
    });
    const processor = createTicketProcessor({ ...h, now: () => h.clock.now });
    const state = await processor.process(h.project, 12, { signal: ctrl.signal });
    expect(state.phase).toBe("tests_written");
    expect(h.agent.phases()).toEqual(["analyse", "write-tests"]);
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(0);
  });
});

describe("erreurs", () => {
  it("AgentRunError : blocage avec la raison", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("implement", () => {
      throw new AgentRunError("trop de tours", "implement", "max_turns");
    });
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toMatch(/implement.*nombre maximal de tours/);
    expect(h.recorder.summaries.find((s) => s.phase === "implement")?.outcome).toBe("error");
  });

  it("erreur technique : blocage, et les échecs du blocage ne masquent pas la cause", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.git.prepareWorktree = async () => {
      throw new Error("setup KO");
    };
    h.gitlab.setStatus = async (_p, _i, role) => {
      if (role === "blocked") throw new Error("GraphQL down");
    };
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toBe("erreur technique : setup KO");
    expect(h.gitlab.comments.at(-1)).toContain("setup KO");
  });
});

describe("finalisation", () => {
  it("rebase avec conflit résolu : tests, review, push forcé, CI, puis livraison", async () => {
    const h = harness();
    h.git.rebaseStops = [{ files: ["src/cart.ts"] }];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    before(h, "git.rebaseOnDefault", "agent.rebase-fix");
    before(h, "agent.rebase-fix", "git.rebaseContinue");
    const tail = h.log.entries.slice(h.log.indexOf("git.rebaseContinue"));
    const afterRebase = { indexOf: (p: string) => tail.findIndex((e) => e.startsWith(p)) };
    expect(afterRebase.indexOf("git.run:npm test")).toBeGreaterThan(0);
    expect(afterRebase.indexOf("agent.review")).toBeGreaterThan(afterRebase.indexOf("git.run:npm test"));
    expect(afterRebase.indexOf("git.push:force")).toBeGreaterThan(afterRebase.indexOf("agent.review"));
    expect(afterRebase.indexOf("gitlab.waitForPipeline")).toBeGreaterThan(afterRebase.indexOf("git.push:force"));
    expect(afterRebase.indexOf("gitlab.markMrReady")).toBeGreaterThan(afterRebase.indexOf("gitlab.waitForPipeline"));
    const rebaseReview = h.agent.requests.filter((r) => r.phase === "review").at(-1)!;
    expect(rebaseReview.prompt).toContain("src/cart.ts");
    expect(h.gitlab.waitCalls).toHaveLength(2);
  });

  it("conflit non résolu après 2 tentatives sur le même commit (marqueurs restants) : rebase annulé, bloqué", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.git.rebaseStops = [{ files: ["a.ts"], failedAttempts: 99 }];
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(h.agent.phases().filter((p) => p === "rebase-fix")).toHaveLength(2);
    expect(h.log.count("git.rebaseAbort")).toBe(1);
    expect(state.blockedReason).toMatch(/conflits de rebase.*2 tentatives sur le même commit/);
  });

  it("tentatives comptées par arrêt du rebase : 4 commits en conflit résolus, au-delà de 3 tentatives au total", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    // c1 résolu du 1er coup ; c2 en 2 tentatives ; c3 et c4 du 1er coup.
    h.git.rebaseStops = [
      { id: "c1", files: ["a.ts"] },
      { id: "c2", files: ["b.ts"], failedAttempts: 1 },
      { id: "c3", files: ["c.ts"] },
      { id: "c4", files: ["d.ts"] },
    ];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.agent.phases().filter((p) => p === "rebase-fix")).toHaveLength(5);
    expect(h.log.count("git.rebaseAbort")).toBe(0);
  });

  it("plafond global d'arrêts du rebase", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.git.rebaseStops = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, files: ["a.ts"] }));
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toMatch(/plus de 10 commits en conflit/);
    expect(h.agent.phases().filter((p) => p === "rebase-fix")).toHaveLength(10);
  });
});

describe("CI et reprise (push avant attente, pipeline introuvable)", () => {
  it("reprise dans la boucle CI : un correctif commité mais ni relu ni poussé est testé, relu (delta, preuves refaites) puis poussé", async () => {
    const saved = await stateAt("pushed");
    const h = harness({ config: { retro: { enabled: false } } });
    // Crash entre le commit fix(ci) et la fin de la review du delta : reviewedSha est l'ancien HEAD.
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", ciSeen: true, ciGreenSha: undefined, reviewedSha: "sha2", proofsStale: true });
    h.git.head = "fixci1";
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    before(h, "git.run:npm test", "agent.review");
    expect(h.git.diffRanges[0]).toEqual(["sha2", "fixci1"]);
    before(h, "agent.review", "git.push");
    before(h, "agent.verify-criteria", "git.push");
    expect(h.git.pushes[0]?.head).toBe("fixci1");
    before(h, "git.push", "gitlab.waitForPipeline:fixci1");
    expect(state.ciGreenSha).toBe("fixci1");
    expect(state.reviewedSha).toBe("fixci1");
    expect(state.proofsStale).toBe(false);
  });

  it("aucun pipeline alors que la CI a déjà tourné pour ce ticket : bloqué, pas de MR Ready", async () => {
    const saved = await stateAt("pushed");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", ciSeen: true });
    h.git.head = "fixci1";
    h.gitlab.pipelineOutcomes = [{ kind: "none" }];
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toMatch(/pipeline introuvable pour fixci1/);
    expect(h.log.count("gitlab.markMrReady")).toBe(0);
  });

  it("projet sans CI (aucun pipeline jamais vu) : « none » vaut vert", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [{ kind: "none" }];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.ciSeen).toBeUndefined();
  });

  it("mémorise qu'un pipeline a été vu", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    const state = await h.run();
    expect(state.ciSeen).toBe(true);
    expect(state.ciGreenSha).toBe(h.git.head);
  });

  it("pipeline en attente faute de runner : CI sautée, livraison, signalée dans la MR", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [ciNoRunner(7)];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.ciGreenSha).toBe(h.git.head);
    expect(state.ciNoRunnerPipelineUrl).toBe("https://gitlab.example.com/p/7");
    expect(h.log.count("gitlab.retryJobsAndWait")).toBe(0);
    expect(h.log.count("gitlab.latestFinishedPipeline")).toBe(0);
    expect(h.agent.phases()).not.toContain("ci-fix");
    const description = h.gitlab.mrUpdates.map((u) => u.patch.description).filter(Boolean).at(-1)!;
    expect(description).toContain("## CI non exécutée");
    expect(description).toContain("https://gitlab.example.com/p/7");
  });

  it("jobs relancés restés en attente faute de runner : CI sautée, sans ci-fix", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [ciFailed([job("e2e")])];
    h.gitlab.retryOutcomes = [ciNoRunner(8)];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.ciNoRunnerPipelineUrl).toBe("https://gitlab.example.com/p/8");
    expect(state.flakyJobs).toEqual([]);
    expect(h.agent.phases()).not.toContain("ci-fix");
  });

  it("CI verte après une CI sautée faute de runner : la mention disparaît de la MR", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({
      ...saved,
      mrIid: 5,
      mrUrl: "https://mr/5",
      ciSeen: true,
      ciGreenSha: "ancien",
      ciNoRunnerPipelineUrl: "https://gitlab.example.com/p/7",
    });
    h.git.head = "fixreview9";
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.ciNoRunnerPipelineUrl).toBeUndefined();
    const description = h.gitlab.mrUpdates.map((u) => u.patch.description).filter(Boolean).at(-1)!;
    expect(description).not.toContain("CI non exécutée");
  });

  it("état arrivé à ci_green sans sha validé (correctif non poussé) : push et CI avant la livraison", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", ciSeen: true, ciGreenSha: "ancien" });
    h.git.head = "fixreview9";
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    before(h, "git.push", "gitlab.waitForPipeline:fixreview9");
    before(h, "gitlab.waitForPipeline:fixreview9", "gitlab.markMrReady");
  });
});

describe("arrêt immédiat (2e Ctrl+C)", () => {
  it("transmet le signal aux sessions ; une session interrompue conserve l'état sans bloquer", async () => {
    const h = harness();
    const now = new AbortController();
    h.agent.on("implement", (req) => {
      expect(req.abortSignal).toBe(now.signal);
      throw new AgentRunError("interrompue", "implement", "aborted");
    });
    const processor = createTicketProcessor({ ...h, now: () => h.clock.now });
    const state = await processor.process(h.project, 12, { abortNow: now.signal });
    expect(state.phase).toBe("tests_written");
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(0);
    expect((await h.store.load(KEY))?.phase).toBe("tests_written");
  });
});

describe("arrêt demandé pendant une commande", () => {
  it("tests tués par le Ctrl+C : pas d'itération test/fix, état conservé, pas de blocage", async () => {
    const h = harness();
    const stop = new AbortController();
    const orig = h.git.run.bind(h.git);
    h.git.run = async (wt: string, command: string) => {
      if (command === "npm test") {
        stop.abort();
        return { exitCode: 130, output: "SIGINT", timedOut: false, durationMs: 1 };
      }
      return orig(wt, command);
    };
    const processor = createTicketProcessor({ ...h, now: () => h.clock.now });
    const state = await processor.process(h.project, 12, { signal: stop.signal });
    expect(state.phase).toBe("implemented");
    expect(state.counters.testFix).toBe(0);
    expect(h.agent.phases()).not.toContain("test-fix");
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(0);
  });

  it("erreur technique après une demande d'arrêt : état conservé", async () => {
    const h = harness();
    const stop = new AbortController();
    h.git.prepareWorktree = async () => {
      stop.abort();
      throw new Error("setup tué par SIGINT");
    };
    const processor = createTicketProcessor({ ...h, now: () => h.clock.now });
    const state = await processor.process(h.project, 12, { signal: stop.signal });
    expect(state.phase).toBe("picked");
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(0);
  });
});

describe("durée maximale : temps actif cumulé", () => {
  it("le temps où l'outil était arrêté ne compte pas", async () => {
    const saved = await stateAt("implemented");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, startedAt: "2026-11-20T06:00:00Z", activeMs: 10 * 60_000 }); // 3 jours écoulés, 10 min actives
    const state = await h.run();
    expect(state.phase).toBe("finalized");
  });

  it("état ancien sans activeMs : compté à 0", async () => {
    const saved = await stateAt("implemented");
    const h = harness({ config: { retro: { enabled: false } } });
    const { activeMs: _a, ...old } = saved;
    await h.store.save({ ...old, startedAt: "2026-11-20T06:00:00Z" });
    expect((await h.run()).phase).toBe("finalized");
  });

  it("cumule le temps des phases et bloque au-delà du plafond", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("implement", () => {
      h.clock.now = new Date(h.clock.now.getTime() + 200 * 60_000);
      return { summary: "long", testsAdjusted: [], testsPassingLocally: true };
    });
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toMatch(/durée maximale/);
    expect(state.activeMs).toBeGreaterThanOrEqual(200 * 60_000);
  });
});

describe("rebase propre et review de delta", () => {
  it("rebase sans conflit : reviewedSha = HEAD rebasé, pas de re-review", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.git.rebaseMovesHead = true;
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(state.reviewedSha).toMatch(/^rebased/);
    expect(h.agent.phases().filter((p) => p === "review")).toHaveLength(1);
    expect(h.log.count("git.push:force")).toBe(1);
  });

  it("correctif fix: après un rebase propre : review du delta depuis le HEAD rebasé seulement", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.git.rebaseMovesHead = true;
    h.git.testResults = [{ exitCode: 0, output: "ok", timedOut: false, durationMs: 1 }, red()];
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.git.commits.at(-1)).toBe("fix: corrige les tests (#12)");
    expect(h.git.diffRanges).toHaveLength(1);
    const [from, to] = h.git.diffRanges[0]!;
    expect(from).toMatch(/^rebased/);
    expect(to).toBe(state.reviewedSha);
    expect(h.agent.phases().filter((p) => p === "review")).toHaveLength(2);
    before(h, "agent.test-fix", "git.push:force");
  });
});

describe("preuves des critères refaites après une correction", () => {
  it("ci-fix qui ajuste un test : vérification des critères refaite, preuves les plus récentes retenues", async () => {
    const h = harness();
    h.gitlab.pipelineOutcomes = [ciFailed(), ciSuccess()];
    h.gitlab.retryOutcomes = [ciFailed()];
    h.agent.on("ci-fix", () => ({
      summary: "s",
      rootCause: "assertion fragile",
      unrelatedToTicket: false,
      testsAdjusted: [{ name: "arrondit", file: "src/cart.test.ts", change: "modified", criteria: [1], explanation: "assertion stable" }],
    }));
    h.agent.on("verify-criteria", (_req, n) => ({
      proofs: [
        { index: 0, proven: true, tests: ["t"], reason: "ok" },
        { index: 1, proven: true, tests: [n === 1 ? "avant" : "après-ci-fix"], reason: "ok" },
      ],
    }));
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.agent.phases().filter((p) => p === "verify-criteria")).toHaveLength(2);
    expect(h.log.entries.lastIndexOf("agent.verify-criteria")).toBeGreaterThan(h.log.indexOf("agent.ci-fix"));
    expect(state.proofs.find((p) => p.index === 1)?.tests).toEqual(["après-ci-fix"]);
    expect(state.proofsStale).toBe(false);
  });

  it("delta qui touche un fichier de test déclaré : vérification refaite même sans testsAdjusted", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [ciFailed(), ciSuccess()];
    h.gitlab.retryOutcomes = [ciFailed()];
    h.git.rangeDiff = "diff --git a/src/cart.test.ts b/src/cart.test.ts\n+expect(total).toBe(3)\n";
    await h.run();
    expect(h.agent.phases().filter((p) => p === "verify-criteria")).toHaveLength(2);
  });

  it("correction sans test touché : pas de nouvelle vérification", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [ciFailed(), ciSuccess()];
    h.gitlab.retryOutcomes = [ciFailed()];
    h.git.rangeDiff = "diff --git a/src/cart.ts b/src/cart.ts\n+fix\n";
    await h.run();
    expect(h.agent.phases().filter((p) => p === "verify-criteria")).toHaveLength(1);
  });

  it("cases cochées d'après les preuves les plus récentes", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [ciFailed(), ciSuccess()];
    h.gitlab.retryOutcomes = [ciFailed()];
    h.agent.on("ci-fix", () => ({
      summary: "s",
      rootCause: "r",
      unrelatedToTicket: false,
      testsAdjusted: [{ name: "affiche", file: "src/cart.test.ts", change: "modified", criteria: [0], explanation: "e" }],
    }));
    // 1re vérification : seul [0] prouvé (le [1] devient un bloquant puis est corrigé) ; dernière : tout prouvé.
    h.agent.on("verify-criteria", (_req, n) => ({
      proofs: [
        { index: 0, proven: true, tests: ["t"], reason: "ok" },
        { index: 1, proven: n !== 1, tests: ["t"], reason: n === 1 ? "absent" : "ok" },
      ],
    }));
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.gitlab.issue.description).toContain("- [x] le total est arrondi au centime");
  });
});

describe("reprise d'un ticket bloqué : worktree recréé et travail existant", () => {
  it("supprime le worktree conservé puis le recrée depuis le remote", async () => {
    const saved = await stateAt("blocked");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, phaseBeforeBlock: "reviewed", blockedReason: "plafond" });
    mkdirSync(saved.worktreePath, { recursive: true });
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    before(h, "git.removeWorktree", "git.createOrReuseWorktree");
    expect(state.recreateWorktree).toBe(false);
  });

  it("nouvel état alors qu'un worktree existe déjà : recréé aussi", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    mkdirSync(paths.worktree(KEY), { recursive: true });
    await h.run();
    before(h, "git.removeWorktree", "git.createOrReuseWorktree");
  });

  it("reprise après crash : le worktree est gardé", async () => {
    const saved = await stateAt("picked");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, recreateWorktree: false });
    mkdirSync(saved.worktreePath, { recursive: true });
    await h.run();
    const created = h.log.indexOf("git.createOrReuseWorktree");
    expect(h.log.entries.slice(0, created).some((e) => e.startsWith("git.removeWorktree"))).toBe(false);
  });

  it("branche déjà implémentée : write-tests et implement reçoivent le travail existant", async () => {
    const saved = await stateAt("blocked");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, phaseBeforeBlock: "reviewed", blockedReason: "plafond" });
    h.git.branchLog = "abc1234 feat: Afficher le total du panier (#12)\ndef5678 test: tests des critères du ticket #12\n";
    await h.run();
    const wt = h.agent.requests.find((r) => r.phase === "write-tests")!;
    expect(wt.prompt).toContain("Travail existant sur la branche");
    expect(wt.prompt).toContain("abc1234 feat: Afficher le total du panier (#12)");
    expect(wt.prompt).toContain("git log --oneline origin/main..HEAD");
    expect(h.agent.requests.find((r) => r.phase === "implement")!.prompt).toContain("Travail existant sur la branche");
  });

  it("nouvelle branche : pas de bloc « travail existant »", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    await h.run();
    expect(h.agent.requests.find((r) => r.phase === "write-tests")!.prompt).not.toContain("Travail existant");
  });
});

describe("retrait du label à la prise en charge", () => {
  it("échec du retrait : ticket non démarré, pas d'état, pas de commentaire", async () => {
    const h = harness();
    h.gitlab.removeLabelError = new Error("403 Forbidden");
    await expect(h.run()).rejects.toThrow(/retrait du label « auto::ready » impossible.*403/);
    expect(await h.store.load(KEY)).toBeNull();
    expect(h.gitlab.comments).toEqual([]);
    expect(h.log.count("gitlab.setStatus")).toBe(0);
    expect(h.agent.phases()).toEqual([]);
  });

  it("échec du retrait sur un ticket bloqué : il reste bloqué tel quel", async () => {
    const saved = await stateAt("blocked");
    const h = harness();
    await h.store.save({ ...saved, blockedReason: "plafond", counters: { testFix: 5, review: 0, ci: 0 } });
    h.gitlab.removeLabelError = new Error("GitLab 500");
    await expect(h.run()).rejects.toThrow(/retrait du label/);
    const after = (await h.store.load(KEY))!;
    expect(after.phase).toBe("blocked");
    expect(after.counters.testFix).toBe(5);
    expect(h.gitlab.comments).toEqual([]);
  });
});

describe("intégration GitLab : images en échec, jobs de pipelines enfants, cochage par texte", () => {
  it("les images non téléchargées sont mentionnées dans le contexte de l'analyse", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.failedImages = [{ url: "/uploads/def/schema.png", status: 403 }];
    const state = await h.run();
    const ctx = h.agent.requests.find((r) => r.phase === "analyse")!.context ?? "";
    expect(ctx).toContain("Images non téléchargées");
    expect(ctx).toContain("/uploads/def/schema.png (HTTP 403)");
    expect(state.imagesFailed).toEqual(["/uploads/def/schema.png (HTTP 403)"]);
  });

  it("log d'un job de pipeline enfant lu dans son propre projet", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.gitlab.pipelineOutcomes = [ciFailed([{ ...job("child-unit", 77), projectId: 999 }]), ciSuccess()];
    h.gitlab.retryOutcomes = [ciFailed([{ ...job("child-unit", 78), projectId: 999 }, job("unit", 79)])];
    await h.run();
    expect(h.gitlab.jobLogCalls).toEqual([
      { projectId: 999, jobId: 78 },
      { projectId: 7, jobId: 79 },
    ]);
  });

  it("cases cochées par texte quand la description a changé depuis l'analyse", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => {
      // Une case a été insérée en tête pendant le traitement : les index ont glissé.
      h.gitlab.issue = { ...h.gitlab.issue, description: `- [ ] nouvelle case ajoutée\n${h.gitlab.issue.description}` };
      return { title: "Total", summary: "s", changeKinds: [], uiScreens: [], dataChanges: [] };
    });
    await h.run();
    const d = h.gitlab.issue.description;
    expect(d).toContain("- [ ] nouvelle case ajoutée");
    expect(d).toContain("- [x] le bouton affiche le total");
    expect(d).toContain("- [x] le total est arrondi au centime");
    expect(d).toContain("- [ ] le design est joli");
  });
});

describe("contexte des sessions", () => {
  it("type non tranché : l'analyse charge les deux skills de type ; type par label : un seul", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    await h.run();
    expect(h.agent.requests.find((r) => r.phase === "analyse")!.typeSkills).toEqual(["bug", "feature"]);
    expect(h.agent.requests.find((r) => r.phase === "write-tests")!.typeSkills).toBeUndefined();
    const h2 = harness({ config: { retro: { enabled: false } } });
    h2.gitlab.issue = { ...h2.gitlab.issue, labels: ["bug"] };
    await h2.run();
    expect(h2.agent.requests.find((r) => r.phase === "analyse")!.typeSkills).toBeUndefined();
  });

  it("le contexte donne la commande de test, le mode de test et la commande de build", async () => {
    const h = harness({ config: { retro: { enabled: false } }, project: { buildCommand: "npm run build" } });
    await h.run();
    const ctx = h.agent.requests.find((r) => r.phase === "implement")!.context ?? "";
    expect(ctx).toContain("Commande de test : `npm test`");
    expect(ctx).toContain("Mode de test : `local`");
    expect(ctx).toContain("Commande de build : `npm run build`");
  });
});

describe("mrTitle", () => {
  it("retire Draft et ajoute le numéro une seule fois", () => {
    expect(mrTitle("Draft: Total", 3)).toBe("Total (#3)");
    expect(mrTitle("Total (#3)", 3)).toBe("Total (#3)");
  });
});

describe("reprises robustes : review due, rebase interrompu, livraison idempotente", () => {
  it("avant la rédaction de la MR : preuves périmées sur un HEAD déjà vert → review du delta et vérification refaites", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", ciSeen: true, reviewedSha: "sha2", ciGreenSha: "fixci1", proofsStale: true });
    h.git.head = "fixci1";
    h.agent.on("verify-criteria", () => ({
      proofs: [
        { index: 0, proven: true, tests: ["t"], reason: "ok" },
        { index: 1, proven: true, tests: ["preuve-fraiche"], reason: "ok" },
      ],
    }));
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.git.diffRanges[0]).toEqual(["sha2", "fixci1"]);
    before(h, "agent.review", "agent.mr-writeup");
    before(h, "agent.verify-criteria", "agent.mr-writeup");
    expect(state.proofs.find((p) => p.index === 1)?.tests).toEqual(["preuve-fraiche"]);
    expect(h.gitlab.issue.description).toContain("- [x] le total est arrondi au centime");
  });

  it("rebase propre alors qu'une review de delta était due : le delta est relu avant d'être recouvert", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", ciSeen: true, reviewedSha: "sha2", ciGreenSha: "fixci1" });
    h.git.head = "fixci1";
    h.git.rebaseMovesHead = true;
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.git.diffRanges).toContainEqual(["sha2", "fixci1"]);
    before(h, "agent.review", "git.rebaseOnDefault");
    expect(state.reviewedSha).toMatch(/^rebased/);
  });

  it("ticket illisible : le label n'est pas retiré, aucun état créé", async () => {
    const h = harness();
    h.gitlab.getIssue = async () => {
      throw new Error("GitLab 500");
    };
    await expect(h.run()).rejects.toThrow(/GitLab 500/);
    expect(h.log.count("gitlab.removeLabel")).toBe(0);
    expect(await h.store.load(KEY)).toBeNull();
  });

  it("sauvegarde de l'état impossible après le retrait du label : le label est remis", async () => {
    const h = harness();
    h.store.save = async () => {
      throw new Error("disque plein");
    };
    await expect(h.run()).rejects.toThrow(/disque plein/);
    before(h, "gitlab.removeLabel:auto::ready", "gitlab.addLabel:auto::ready");
    expect(h.log.count("gitlab.setStatus")).toBe(0);
  });

  it("reprise d'un ticket bloqué dont l'état ne peut être sauvegardé : le label est remis", async () => {
    const saved = await stateAt("blocked");
    const h = harness();
    await h.store.save({ ...saved, blockedReason: "plafond" });
    h.store.save = async () => {
      throw new Error("EACCES");
    };
    await expect(h.run()).rejects.toThrow(/EACCES/);
    before(h, "gitlab.removeLabel:auto::ready", "gitlab.addLabel:auto::ready");
  });

  it("reprise au milieu d'un rebase (crash pendant rebase-fix) : rebase annulé puis refait, livraison", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", ciSeen: true, reviewedSha: "sha2", ciGreenSha: "sha2" });
    h.git.head = "sha2";
    h.git.interruptedRebase();
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    before(h, "git.rebaseAbort", "git.rebaseOnDefault");
    expect(h.git.commits.some((c) => c.startsWith("wip"))).toBe(false);
  });

  it("blocage alors qu'un rebase est resté en cours : rebase annulé avant le WIP et le push", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", reviewedSha: "sha2", ciGreenSha: "sha2", activeMs: 4 * 3_600_000 });
    mkdirSync(saved.worktreePath, { recursive: true });
    h.git.head = "sha2";
    h.git.interruptedRebase();
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    before(h, "git.rebaseAbort", "git.push");
    expect(h.git.pushes.map((p) => p.head)).toEqual(["sha2"]);
    expect(h.git.rebaseInProgress).toBe(false);
  });

  it("arrêt immédiat pendant la résolution d'un conflit : rebase annulé, état conservé", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.git.rebaseStops = [{ files: ["src/cart.ts"] }];
    h.agent.on("rebase-fix", () => {
      throw new AgentRunError("interrompue", "rebase-fix", "aborted");
    });
    const state = await h.run();
    expect(state.phase).toBe("ci_green");
    expect(h.git.rebaseInProgress).toBe(false);
    expect(h.log.count("gitlab.setStatus:blocked")).toBe(0);
  });

  it("blocage après une reprise d'un rebase pas encore poussé : push forcé (pendingForcePush)", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({ ...saved, mrIid: 5, mrUrl: "https://mr/5", pendingForcePush: true, activeMs: 4 * 3_600_000 });
    mkdirSync(saved.worktreePath, { recursive: true });
    h.git.head = "rebased7";
    const state = await h.run();
    expect(state.phase).toBe("blocked");
    expect(h.git.pushes).toEqual([{ force: true, head: "rebased7" }]);
  });

  it("livraison reprise après la MR Ready, worktree déjà supprimé : termine sans rebase ni nouvelle rédaction", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({
      ...saved,
      mrIid: 5,
      mrUrl: "https://mr/5",
      deliverySteps: { mrReady: true, summary: "Résumé déjà rédigé", boxesChecked: true },
    });
    h.git.headSha = async () => {
      throw new Error("worktree absent");
    };
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    for (const e of ["git.rebaseOnDefault", "agent.mr-writeup", "gitlab.markMrReady", "gitlab.updateIssueDescription"]) {
      expect(h.log.count(e), e).toBe(0);
    }
    expect(h.log.count("gitlab.setStatus:inReview")).toBe(1);
    expect(h.gitlab.comments).toHaveLength(1);
    expect(h.gitlab.comments[0]).toContain("Résumé déjà rédigé");
    expect(state.deliverySteps).toMatchObject({ mrReady: true, boxesChecked: true, statusSet: true, commented: true, worktreeRemoved: true });
  });

  it("livraison reprise après le commentaire : pas de second commentaire ni de second statut", async () => {
    const saved = await stateAt("ci_green");
    const h = harness({ config: { retro: { enabled: false } } });
    await h.store.save({
      ...saved,
      mrIid: 5,
      mrUrl: "https://mr/5",
      deliverySteps: { mrReady: true, summary: "s", boxesChecked: true, statusSet: true, commented: true },
    });
    const state = await h.run();
    expect(state.phase).toBe("finalized");
    expect(h.gitlab.comments).toHaveLength(0);
    expect(h.log.count("gitlab.setStatus")).toBe(0);
    expect(h.log.count("git.removeWorktree")).toBe(1);
  });
});

describe("avant / après dans la MR (ADR, amendement 3)", () => {
  const uiWriteup = {
    title: "Total du panier",
    summary: "Affiche le total.",
    changeKinds: ["ui"],
    uiScreens: [{ label: "Panier", howToReach: "/cart avec deux articles" }],
    dataChanges: [],
  };

  /** Session de captures factice : écrit les fichiers demandés dans le dossier de captures du worktree. */
  function writesCaptures(files: Record<string, string>, output: Record<string, unknown>) {
    return (req: { worktreePath: string }) => {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(req.worktreePath, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
      }
      return output;
    };
  }

  const finalDescription = (h: Harness): string => h.gitlab.mrUpdates.find((u) => u.patch.assigneeIds)!.patch.description!;

  it("changement d'API : diff avant/après dans la description, sans session de captures", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => ({
      ...uiWriteup,
      changeKinds: ["endpoint"],
      uiScreens: [],
      dataChanges: [
        { subject: "GET /api/cart", kind: "endpoint", change: "modified", before: '{\n  "total": 12.3\n}', after: '{\n  "total": 12.30\n}', note: "" },
      ],
    }));
    const st = await h.run();
    expect(st.phase).toBe("finalized");
    expect(h.agent.phases()).not.toContain("ui-captures");
    expect(h.git.baseWorktrees).toEqual([]);
    expect(finalDescription(h)).toContain('### `GET /api/cart` (API, modifié)\n\n```diff\n {\n-  "total": 12.3\n+  "total": 12.30\n }\n```');
  });

  it("changement d'interface : worktree « avant » préparé, captures téléversées puis rendues, worktree supprimé", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    h.agent.on(
      "ui-captures",
      writesCaptures(
        { ".sprintsaver/captures/1-avant.png": "png-a", ".sprintsaver/captures/1-apres.png": "png-b" },
        {
          captures: [{ label: "Panier", before: ".sprintsaver/captures/1-avant.png", after: ".sprintsaver/captures/1-apres.png", note: "Total sous la liste." }],
          skippedReason: "",
        },
      ),
    );
    const st = await h.run();
    expect(st.phase).toBe("finalized");

    const wt = paths.worktree(KEY);
    const base = `${wt}.avant`;
    expect(h.git.baseWorktrees).toEqual([base]);
    const req = h.agent.requests.find((r) => r.phase === "ui-captures")!;
    expect(req.extraWritableRoots).toEqual([base]);
    expect(req.prompt).toContain(base);
    expect(req.prompt).toContain("/cart avec deux articles");

    before(h, "agent.mr-writeup", "git.createBaseWorktree");
    before(h, "git.createBaseWorktree", "agent.ui-captures");
    before(h, "agent.ui-captures", "gitlab.uploadFile");
    before(h, "gitlab.uploadFile", "gitlab.updateMr:assignee=42");
    before(h, "gitlab.updateMr:assignee=42", "gitlab.markMrReady");
    expect(h.log.count("git.prepareWorktree")).toBe(2);
    expect(h.git.removed).toContain(base);
    expect(existsSync(base)).toBe(false);

    expect(h.gitlab.uploads.map((u) => u.split("/").pop())).toEqual(["1-avant.png", "1-apres.png"]);
    expect(finalDescription(h)).toContain(
      "### Panier\n\n| Avant | Après |\n|---|---|\n| ![1-avant.png](/uploads/secret1/1-avant.png) | ![1-apres.png](/uploads/secret2/1-apres.png) |\n\nTotal sous la liste.",
    );
  });

  it("session de captures en échec : la MR est livrée et la description dit pourquoi", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    h.agent.on("ui-captures", () => {
      throw new AgentRunError("trop de tours", "ui-captures", "max_turns");
    });
    const st = await h.run();
    expect(st.phase).toBe("finalized");
    expect(h.gitlab.uploads).toEqual([]);
    expect(finalDescription(h)).toContain("> Captures non réalisées : échec de la session de captures (nombre maximal de tours atteint)");
    expect(finalDescription(h)).not.toContain("trop de tours");
    expect(h.git.removed).toContain(`${paths.worktree(KEY)}.avant`);
  });

  it("préparation du worktree « avant » en échec : raison courte dans la MR, sans le détail local", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    h.git.createBaseWorktree = async () => {
      throw new Error("fatal: /Users/dev/.sprintsaver/repos/demo: invalid reference");
    };
    const st = await h.run();
    expect(st.phase).toBe("finalized");
    expect(h.agent.phases()).not.toContain("ui-captures");
    const d = finalDescription(h);
    expect(d).toContain("> Captures non réalisées : échec de la préparation de la version « avant »");
    expect(d).not.toContain("/Users/dev");
  });

  it("chemins hors du dossier de captures refusés, raison de la session reprise", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    h.agent.on(
      "ui-captures",
      writesCaptures(
        { "src/secret.png": "x", ".sprintsaver/captures/1-apres.png": "png" },
        {
          captures: [{ label: "Panier", before: "src/secret.png", after: ".sprintsaver/captures/1-apres.png", note: "" }],
          skippedReason: "écran Paiement : authentification requise",
        },
      ),
    );
    await h.run();
    expect(h.gitlab.uploads.map((u) => u.split("/").pop())).toEqual(["1-apres.png"]);
    const d = finalDescription(h);
    expect(d).toContain("| _écran inexistant avant ce changement_ | ![1-apres.png](/uploads/secret1/1-apres.png) |");
    expect(d).toContain("> Captures incomplètes : écran Paiement : authentification requise ; Panier (avant) : fichier invalide ou absent");
  });

  it("arbre de travail modifié par la session : modifications annulées avant la suite", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    h.agent.on("ui-captures", () => {
      h.git.dirty = true;
      return { captures: [], skippedReason: "rien" };
    });
    await h.run();
    before(h, "agent.ui-captures", "git.discardChanges");
    before(h, "git.discardChanges", "gitlab.markMrReady");
  });

  it("captures désactivées dans la config : aucune session de captures", async () => {
    const h = harness({ config: { retro: { enabled: false }, screenshots: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    const st = await h.run();
    expect(st.phase).toBe("finalized");
    expect(h.agent.phases()).not.toContain("ui-captures");
    expect(finalDescription(h)).not.toContain("Captures");
  });

  it("interface sans écran désigné : pas de session, raison dans la MR", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => ({ ...uiWriteup, uiScreens: [] }));
    await h.run();
    expect(h.agent.phases()).not.toContain("ui-captures");
    expect(finalDescription(h)).toContain("> Captures non réalisées : aucun écran à capturer n'a été désigné");
  });

  it("arrêt immédiat pendant les captures : rien n'est livré, le ticket reprendra", async () => {
    const h = harness({ config: { retro: { enabled: false } } });
    h.agent.on("mr-writeup", () => uiWriteup);
    h.agent.on("ui-captures", () => {
      throw new AgentRunError("interrompue", "ui-captures", "aborted");
    });
    const st = await h.run();
    expect(st.phase).toBe("ci_green");
    expect(h.log.count("gitlab.markMrReady")).toBe(0);
    expect(h.git.removed).toContain(`${paths.worktree(KEY)}.avant`);
  });
});
