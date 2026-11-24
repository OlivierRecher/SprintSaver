import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentVerification,
  formatProposal,
  labelsToCreate,
  proposalFromAgent,
  proposalFromDetection,
  type ProposalContext,
} from "../../src/init/proposal.js";
import type { VerificationReport } from "../../src/init/verify.js";
import { makeAgentProposal, makeProject } from "../helpers/fakes.js";

const info = { id: 7, name: "shop", pathWithNamespace: "team/shop", httpUrl: "https://gitlab.example.com/team/shop.git", webUrl: "https://gitlab.example.com/team/shop", defaultBranch: "main" };
const natives = [
  { id: "gid://s/1", name: "To do" },
  { id: "gid://s/2", name: "In progress" },
];
const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({ info, labels: ["bug", "feature", "Blocked"], natives, usedNames: new Set(["api"]), ...over });

const report = (over: Partial<VerificationReport> = {}): VerificationReport => ({
  attempt: 1,
  input: { setupCommand: "uv venv --python 3.10 .venv", testCommand: ".venv/bin/python -m unittest discover -s tests", worktreeInclude: [], cowDirs: [] },
  verdict: "passed",
  steps: [
    { step: "setup", command: "uv venv --python 3.10 .venv", status: "passed", exitCode: 0, durationMs: 800 },
    { step: "build", status: "skipped" },
    { step: "test", command: ".venv/bin/python -m unittest discover -s tests", status: "passed", exitCode: 0, durationMs: 300 },
  ],
  durationMs: 1200,
  ...over,
});

let checkout: string;
beforeAll(async () => {
  checkout = await mkdtemp(join(tmpdir(), "ss-proposal-"));
});
afterAll(async () => {
  await rm(checkout, { recursive: true, force: true });
});

describe("proposition de l'agent, normalisée", () => {
  it("reprend la proposition et résout les cibles de statut contre GitLab", () => {
    const p = proposalFromAgent(makeAgentProposal({ localCheckout: checkout, worktreeInclude: [".env", ".env", " "] }), ctx(), [report()]);
    expect(p.origin).toBe("agent");
    expect(p.config).toMatchObject({
      name: "shop",
      id: 7,
      path: "team/shop",
      httpUrl: info.httpUrl,
      defaultBranch: "main",
      setupCommand: "uv venv --python 3.10 .venv",
      buildCommand: undefined,
      testMode: "local",
      localCheckout: checkout,
      worktreeInclude: [".env"],
      status: {
        inProgress: { kind: "native", id: "gid://s/2", name: "In progress" },
        inReview: { kind: "label", name: "sprintsaver::en-review" },
        blocked: { kind: "label", name: "sprintsaver::bloque" },
      },
      toolchain: [{ tool: "python", required: "3.10", source: ".python-version, image python:3.10", pinnedBy: "uv venv --python 3.10" }],
    });
    expect(p.warnings).toEqual([]);
  });

  it("le code garde la main : nom pris, statut natif inconnu, checkout absent, mode local sans tests", () => {
    const p = proposalFromAgent(
      makeAgentProposal({
        name: "api",
        localCheckout: "/nulle/part",
        testCommand: "",
        status: {
          inProgress: { kind: "native", name: "En cours", id: "gid://inconnu" },
          inReview: { kind: "label", name: "review", id: "" },
          blocked: { kind: "native", name: "to do", id: "" },
        },
      }),
      ctx(),
      [],
    );
    expect(p.config.name).toBe("shop");
    expect(p.config.localCheckout).toBeUndefined();
    expect(p.config.testMode).toBe("ci-only");
    // « En cours » n'existe pas : repli sur le statut natif qui ressemble au rôle.
    expect(p.config.status.inProgress).toEqual({ kind: "native", id: "gid://s/2", name: "In progress" });
    // Statut natif retrouvé par son nom.
    expect(p.config.status.blocked).toEqual({ kind: "native", id: "gid://s/1", name: "To do" });
    expect(p.warnings.join("\n")).toMatch(/Nom « api » refusé.*Checkout local \/nulle\/part introuvable.*Statut natif « En cours » introuvable.*ci-only/s);
  });

  it("le projet garde son nom actuel même s'il figure dans les noms réservés", () => {
    const p = proposalFromAgent(makeAgentProposal({ name: "shop" }), ctx({ prior: makeProject({ name: "shop", id: 7 }), usedNames: new Set(["shop"]) }), []);
    expect(p.config.name).toBe("shop");
    expect(p.warnings).toEqual([]);
  });
});

describe("repli sans agent", () => {
  it("détection simple quand il n'y a pas de config actuelle", () => {
    const p = proposalFromDetection(ctx(), {
      rootFiles: ["package.json", "package-lock.json"],
      stacks: [{ stack: "node", setupCommand: "npm ci", testCommand: "npm test", cowDirs: ["node_modules"] }],
      ciSource: "branch",
      hasCi: true,
      hasWorktreeInclude: false,
    }, "Agent indisponible.");
    expect(p.origin).toBe("simple");
    expect(p.config).toMatchObject({ name: "shop", setupCommand: "npm ci", testCommand: "npm test", testMode: "local", ciSource: "branch", cowDirs: ["node_modules"] });
    expect(p.config.status.inProgress).toEqual({ kind: "native", id: "gid://s/2", name: "In progress" });
    expect(p.config.status.blocked).toEqual({ kind: "label", name: "Blocked" });
    expect(p.config.status.inReview).toEqual({ kind: "label", name: "sprintsaver::en-review" });
    expect(p.config.typeLabels).toEqual({ bug: ["bug"], feature: ["feature"] });
    expect(p.warnings).toEqual(["Agent indisponible."]);
  });

  it("config actuelle reprise telle quelle", () => {
    const prior = makeProject({ name: "boutique", id: 7, setupCommand: "make deps", testCommand: "make test", ciSource: "branch" });
    const p = proposalFromDetection(ctx({ prior }), null);
    expect(p.origin).toBe("existing");
    expect(p.config).toMatchObject({ name: "boutique", setupCommand: "make deps", testCommand: "make test", ciSource: "branch", status: prior.status, typeLabels: prior.typeLabels });
  });
});

describe("labels à créer", () => {
  it("statuts en label, labels de type et label déclencheur absents du projet, sans doublon", () => {
    const p = proposalFromAgent(makeAgentProposal({ typeLabels: { bug: ["bug"], feature: ["feature", "sprintsaver::bloque"] } }), ctx(), []);
    expect(labelsToCreate(p.config, ["bug", "feature"], "auto::ready").map((l) => [l.name, l.color])).toEqual([
      ["sprintsaver::en-review", "#108548"],
      ["sprintsaver::bloque", "#dd2b0e"],
      ["auto::ready", "#6699cc"],
    ]);
    expect(labelsToCreate(p.config, ["bug", "feature", "sprintsaver::en-review", "sprintsaver::bloque", "auto::ready"], "auto::ready")).toEqual([]);
  });
});

describe("rendu de la proposition", () => {
  it("montre tous les champs, la toolchain, la vérification réelle, l'avis de l'agent, les prérequis et les labels à créer", () => {
    const p = proposalFromAgent(
      makeAgentProposal({
        prerequisites: ["Installer Python 3.10 : uv python install 3.10"],
        verification: { status: "baseline_red", failingTests: ["tests.test_cart.TestCart.test_total"], note: "1 test rouge sur main" },
      }),
      ctx(),
      [report()],
    );
    const text = formatProposal(p, labelsToCreate(p.config, ctx().labels, "auto::ready")).join("\n");
    for (const needle of [
      "team/shop [main] — proposée par l'agent de configuration",
      "Nom court            : shop",
      "Setup                : uv venv --python 3.10 .venv",
      "Build                : —",
      "Pipeline surveillé   : pipeline de merge request",
      "Statut en cours      : statut natif « In progress »",
      "Statut en review     : label « sprintsaver::en-review » (à créer)",
      "Labels à créer       : sprintsaver::en-review, sprintsaver::bloque, auto::ready",
      "python : exigé 3.10 (.python-version, image python:3.10)",
      "version fixée par : uv venv --python 3.10",
      "Vérification réelle  : commandes vérifiées : setup, tests, build et relance des tests passent (tentative 1).",
      "Avis de l'agent      : tests rouges sur la branche par défaut (ligne de base) — 1 test rouge sur main",
      "Tests rouges sur main : tests.test_cart.TestCart.test_total",
      "Prérequis manquants :",
      "- Installer Python 3.10",
      "Explication : La CI et .python-version exigent Python 3.10.",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("une commande modifiée après vérification n'est plus présentée comme vérifiée", () => {
    const p = proposalFromAgent(makeAgentProposal(), ctx(), [report()]);
    expect(currentVerification(p)?.verdict).toBe("passed");
    p.config.testCommand = "make test";
    expect(currentVerification(p)).toBeUndefined();
    expect(formatProposal(p, []).join("\n")).toContain("les commandes ont changé depuis la dernière vérification");
    const none = proposalFromDetection(ctx(), null);
    expect(formatProposal(none, []).join("\n")).toContain("Vérification réelle  : commandes non vérifiées.");
  });
});
