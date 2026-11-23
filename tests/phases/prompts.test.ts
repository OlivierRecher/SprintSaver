import { describe, expect, it } from "vitest";
import type { AnalysisResult, TestEntry } from "../../src/contracts.js";
import {
  MAX_DIFF_CHARS,
  MAX_LOG_CHARS,
  buildAnalysePrompt,
  buildCiFixPrompt,
  buildImplementPrompt,
  buildMrWriteupPrompt,
  buildRebaseFixPrompt,
  buildRetroPrompt,
  buildReviewFixPrompt,
  buildReviewPrompt,
  buildTestFixPrompt,
  buildUiCapturesPrompt,
  buildVerifyCriteriaPrompt,
  buildWriteTestsPrompt,
  diffFiles,
  diffSection,
  truncateHead,
  truncateTail,
  type TicketContext,
} from "../../src/phases/prompts.js";

const ticket: TicketContext = {
  issue: {
    projectId: 1,
    iid: 12,
    title: "Total du panier",
    state: "opened",
    webUrl: "https://gl/issues/12",
    labels: ["bug"],
    description: "Le total est faux.\n- [ ] total arrondi\n- [ ] joli",
    issueType: "issue",
    authorUsername: "alice",
    createdAt: "2026-11-01",
  },
  notes: [{ id: 1, authorUsername: "bob", body: "Voir capture", createdAt: "2026-11-02" }],
  linked: [{ ...{ projectId: 1, iid: 3, title: "Ancien bug", state: "closed", webUrl: "https://gl/issues/3", labels: [], description: "x".repeat(10_000), issueType: "issue", authorUsername: "c", createdAt: "" } }],
  imagePaths: [".sprintsaver/images/shot.png"],
  repo: { branch: "sprintsaver/12-total", defaultBranch: "develop" },
};

const analysis: AnalysisResult = {
  type: "bug",
  typeSource: "labels",
  summary: "Corriger l'arrondi.",
  plan: ["écrire le test", "corriger"],
  criteria: [
    { index: 0, text: "total arrondi", checkedInitially: false, testable: true, reason: "test unitaire" },
    { index: 1, text: "joli", checkedInitially: false, testable: false, reason: "subjectif" },
  ],
  precedents: [
    { ref: "#3", relevant: true, why: "même calcul" },
    { ref: "#4", relevant: false, why: "autre module" },
  ],
  assumptions: ["arrondi au centime"],
  blockingQuestions: [],
};

const tests: TestEntry[] = [{ name: "arrondit", file: "cart.test.ts", change: "added", criteria: [0], explanation: "vérifie 2 décimales" }];

describe("troncatures", () => {
  it("garde le début ou la fin", () => {
    expect(truncateHead("abcdef", 3)).toMatch(/^abc\n\n\[… tronqué : 3/);
    expect(truncateTail("abcdef", 3)).toMatch(/def$/);
    expect(truncateTail("abc", 3)).toBe("abc");
  });
});

describe("contexte du ticket", () => {
  it("contient titre, URL, description, commentaires avec auteurs, liés, images et branches", () => {
    const { context } = buildAnalysePrompt({ ticket, criteria: [{ index: 0, text: "total arrondi", checked: false }], typeHint: null });
    for (const s of ["Total du panier", "https://gl/issues/12", "Le total est faux.", "@bob", "Voir capture", "#3 Ancien bug", ".sprintsaver/images/shot.png", "origin/develop", "sprintsaver/12-total", "[0] total arrondi"]) {
      expect(context).toContain(s);
    }
    expect(context.length).toBeLessThan(6_000); // description liée tronquée
  });

  it("l'analyse : type à décider ou imposé", () => {
    expect(buildAnalysePrompt({ ticket, criteria: [], typeHint: null }).prompt).toContain("décide-le");
    expect(buildAnalysePrompt({ ticket, criteria: [], typeHint: { type: "bug", source: "labels" } }).prompt).toContain("« bug »");
  });
});

describe("phases d'ingénierie", () => {
  it("write-tests : critères testables, repro-first pour un bug, analyse en contexte", () => {
    const b = buildWriteTestsPrompt({ ticket, analysis });
    expect(b.prompt).toContain("[0]");
    expect(b.prompt).not.toContain("[1]");
    expect(b.prompt).toContain("reproduit le défaut");
    expect(b.context).toContain("Corriger l'arrondi.");
    expect(b.context).toContain("non testable : subjectif");
    expect(b.context).toContain("#3 : même calcul");
    expect(b.context).not.toContain("#4");
  });

  it("implement : tests listés", () => {
    expect(buildImplementPrompt({ ticket, analysis, tests }).context).toContain("`arrondit`");
  });

  it("test-fix : garde la fin de la sortie", () => {
    const output = `${"début ".repeat(10_000)}ERREUR FINALE`;
    const b = buildTestFixPrompt({ ticket, analysis, tests, command: "npm test", output, exitCode: 1, timedOut: false, iteration: 2 });
    expect(b.prompt).toContain("ERREUR FINALE");
    expect(b.prompt).toContain("code de sortie 1");
    expect(b.prompt.length).toBeLessThan(MAX_LOG_CHARS + 2_000);
  });

  it("review : diff tronqué, pas de résumé d'implémenteur, mode delta", () => {
    const diff = `diff --git a/x b/x\n${"+ligne\n".repeat(20_000)}`;
    const b = buildReviewPrompt({ ticket, analysis, diff, mode: "full" });
    expect(b.prompt.length).toBeLessThan(MAX_DIFF_CHARS + 3_000);
    expect(b.prompt).toContain("tronqué");
    expect(b.context).not.toMatch(/implémenteur|testsPassingLocally/);
    expect(buildReviewPrompt({ ticket, analysis, diff: "d", mode: "delta" }).prompt).toContain("delta");
    expect(buildReviewPrompt({ ticket, analysis, diff: "d", mode: "rebase", conflictedFiles: ["a.ts"] }).prompt).toContain("a.ts");
  });

  it("verify-criteria : critères testables et tests associés seulement", () => {
    const b = buildVerifyCriteriaPrompt({ ticket, analysis, tests });
    expect(b.prompt).toContain("- [0] total arrondi");
    expect(b.prompt).toContain("`arrondit`");
    expect(b.prompt).not.toContain("- [1] joli");
  });

  it("review-fix, ci-fix, rebase-fix, mr-writeup", () => {
    expect(
      buildReviewFixPrompt({ ticket, analysis, tests, iteration: 1, findings: [{ severity: "blocking", category: "bug", file: "a.ts", line: 4, description: "NPE" }] }).prompt,
    ).toContain("[bug] (a.ts:4) NPE");
    const ci = buildCiFixPrompt({
      ticket,
      analysis,
      tests,
      pipelineUrl: "https://gl/p/1",
      iteration: 1,
      jobs: [{ name: "unit", stage: "test", webUrl: "https://gl/j/1", log: `${"x".repeat(50_000)}FIN` }],
    });
    expect(ci.prompt).toContain("FIN");
    expect(ci.prompt.length).toBeLessThan(MAX_LOG_CHARS + 2_000);
    expect(buildRebaseFixPrompt({ ticket, analysis, defaultBranch: "develop", conflictedFiles: ["a.ts"], attempt: 1 }).prompt).toContain("origin/develop");
    expect(buildMrWriteupPrompt({ ticket, analysis, tests, proofs: [{ index: 0, proven: true, tests: [], reason: "" }], nits: [], diff: "d" }).prompt).toContain("[0]");
  });
});

describe("avant / après", () => {
  it("la rédaction demande la nature du changement, les écrans et les contrats avant/après", () => {
    const { prompt } = buildMrWriteupPrompt({ ticket, analysis, tests, proofs: [], nits: [], diff: "d" });
    for (const s of ["`changeKinds`", "`uiScreens`", "`dataChanges`"]) expect(prompt).toContain(s);
  });

  it("captures : worktree avant, dossier de sortie et écrans numérotés", () => {
    const { prompt, context } = buildUiCapturesPrompt({
      ticket,
      analysis,
      screens: [
        { label: "Panier", howToReach: "/cart" },
        { label: "Paiement", howToReach: "/checkout connecté" },
      ],
      basePath: "/wt/demo-12.avant",
      capturesDir: ".sprintsaver/captures",
      diff: "diff --git a/x b/x",
    });
    expect(prompt).toContain("AVANT : /wt/demo-12.avant");
    expect(prompt).toContain("`.sprintsaver/captures/`");
    expect(prompt).toContain("1. Panier — /cart\n2. Paiement — /checkout connecté");
    expect(context).toContain("Total");
  });
});

describe("projet : commandes, mode de test, branches", () => {
  it("le contexte donne commande de test, mode, build, branche de travail et origin/<défaut>", () => {
    const t: TicketContext = { ...ticket, repo: { ...ticket.repo, testCommand: "pnpm test", buildCommand: "pnpm build", testMode: "local" } };
    const { context } = buildImplementPrompt({ ticket: t, analysis, tests });
    for (const s of ["Commande de test : `pnpm test`", "Commande de build : `pnpm build`", "Mode de test : `local`", "`sprintsaver/12-total`", "`origin/develop`"]) {
      expect(context).toContain(s);
    }
    expect(buildImplementPrompt({ ticket, analysis, tests }).context).toContain("Commande de test : non configurée");
  });

  it("ci-only : pas de preuve red locale exigée, raisonnement à la place", () => {
    const t: TicketContext = { ...ticket, repo: { ...ticket.repo, testCommand: "make test", testMode: "ci-only" } };
    const wt = buildWriteTestsPrompt({ ticket: t, analysis });
    expect(wt.context).toContain("`ci-only`");
    expect(wt.prompt).toContain("raisonnement");
    expect(wt.prompt).not.toContain("vérifie qu'ils échouent pour la bonne raison");
    expect(buildImplementPrompt({ ticket: t, analysis, tests }).prompt).not.toContain("Lance la suite de tests");
    expect(buildWriteTestsPrompt({ ticket, analysis }).prompt).toContain("vérifie qu'ils échouent pour la bonne raison");
  });
});

describe("travail existant sur la branche (reprise après blocage)", () => {
  it("write-tests et implement listent les commits et demandent de compléter, pas de réécrire", () => {
    const commits = ["abc1234 feat: total", "def5678 test: tests des critères"];
    const w = buildWriteTestsPrompt({ ticket, analysis, existingWork: commits });
    expect(w.prompt).toContain("Travail existant sur la branche");
    expect(w.prompt).toContain("- abc1234 feat: total");
    expect(w.prompt).toContain("git log --oneline origin/develop..HEAD");
    expect(w.prompt).toContain("ne le réécris pas");
    expect(w.prompt).toMatch(/Red-first seulement pour les critères qui ne sont pas encore couverts/);
    expect(buildImplementPrompt({ ticket, analysis, tests, existingWork: commits }).prompt).toContain("Travail existant sur la branche");
    expect(buildWriteTestsPrompt({ ticket, analysis, existingWork: [] }).prompt).not.toContain("Travail existant");
  });
});

describe("diff envoyé aux sessions", () => {
  const src = "diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n+total\n";
  const lock = `diff --git a/package-lock.json b/package-lock.json\n${"+\"x\": 1,\n".repeat(5_000)}`;
  const smallSnap = "diff --git a/src/__snapshots__/a.snap b/src/__snapshots__/a.snap\n+petit\n";
  const bigSnap = `diff --git a/src/__snapshots__/b.snap b/src/__snapshots__/b.snap\n${"+gros\n".repeat(5_000)}`;
  const dist = "diff --git a/dist/app.js b/dist/app.js\n+bundle\n";

  it("remplace lockfiles, fichiers générés et gros snapshots par une ligne", () => {
    const out = diffSection(src + lock + smallSnap + bigSnap + dist, "develop");
    expect(out).toContain("+total");
    expect(out).toContain("+petit");
    expect(out).toContain("fichier package-lock.json modifié (diff omis");
    expect(out).toContain("fichier src/__snapshots__/b.snap modifié (diff omis");
    expect(out).toContain("fichier dist/app.js modifié (diff omis");
    expect(out).not.toContain('"x": 1');
    expect(out).not.toContain("+gros");
    expect(out).not.toContain("Fichiers modifiés");
    expect(diffFiles(src + lock)).toEqual(["src/cart.ts", "package-lock.json"]);
  });

  it("diff encore trop long : liste des fichiers et commande pour lire le reste", () => {
    const big = `diff --git a/src/a.ts b/src/a.ts\n${"+ligne\n".repeat(20_000)}diff --git a/src/zz.ts b/src/zz.ts\n+fin\n`;
    const out = diffSection(big, "develop", 10_000);
    expect(out).toContain("tronqué");
    expect(out).toContain("- src/a.ts");
    expect(out).toContain("- src/zz.ts");
    expect(out).toContain("git diff origin/develop...HEAD -- <fichier>");
    const review = buildReviewPrompt({ ticket, analysis, diff: src + lock, mode: "full" });
    expect(review.prompt).toContain("diff omis");
    expect(buildMrWriteupPrompt({ ticket, analysis, tests, proofs: [], nits: [], diff: src + lock }).prompt).toContain("diff omis");
  });
});

describe("rétro", () => {
  it("ne contient que les résumés, le projet et son skill", () => {
    const b = buildRetroPrompt({
      projectName: "demo",
      outcome: "blocked",
      blockedReason: "plafond",
      projectSkill: "# Pièges\n- lent",
      summaries: [{ ticketKey: "demo-12", phase: "tests-local", iteration: 1, startedAt: "", durationMs: 3000, outcome: "retry", facts: ["tests en échec : arrondit"] }],
    });
    expect(b.prompt).toContain("Projet : demo");
    expect(b.prompt).toContain("tests en échec : arrondit");
    expect(b.prompt).toContain("# Pièges");
    expect(b.prompt).toContain("skills/projects/demo.md");
    expect(b.context).toBe("");
    expect(buildRetroPrompt({ projectName: "x", outcome: "finalized", summaries: [], projectSkill: null }).prompt).toContain("fichier absent");
  });
});
