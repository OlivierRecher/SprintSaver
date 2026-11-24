import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/contracts.js";
import {
  SIGNATURE,
  baseCiBrokenComment,
  blockedComment,
  deliveredComment,
  needsInfoComment,
  pickupComment,
} from "../../src/domain/comments.js";
import { codeSpan, listItem, mentionList } from "../../src/domain/markdown.js";

const analysis: AnalysisResult = {
  type: "bug",
  typeSource: "labels",
  summary: "Le total TVA est faux pour les demi-centimes.",
  plan: ["Écrire un test qui reproduit", "Corriger l'arrondi\nCas négatifs inclus"],
  criteria: [
    { index: 1, text: "Le design est validé", checkedInitially: false, testable: false, reason: "jugement visuel" },
    { index: 0, text: "La TVA est arrondie au centime", checkedInitially: false, testable: true },
  ],
  precedents: [
    { ref: "#12", relevant: true, why: "même module" },
    { ref: "!34", relevant: false, why: "hors sujet" },
  ],
  assumptions: ["Arrondi commercial"],
  blockingQuestions: [],
};

function expectSigned(body: string): void {
  expect(body.trimEnd().endsWith(`\n\n${SIGNATURE}`)).toBe(true);
  expect(SIGNATURE).toBe("<sub>SprintSaver</sub>");
}

describe("pickupComment", () => {
  const body = pickupComment(analysis, "sprintsaver/42-tva");

  it("tient l'essentiel sur une ligne : type, critères testables, branche", () => {
    expect(body.startsWith("**Pris en charge par SprintSaver** · bug · 1/2 critères testables · branche `sprintsaver/42-tva`\n\n")).toBe(true);
    expect(pickupComment({ ...analysis, type: "feature", typeSource: "agent" }, "b")).toContain(" · fonctionnalité (type déduit) · ");
  });

  it("résumé visible, critères non testables visibles avec leur raison", () => {
    expect(body).toContain("Le total TVA est faux pour les demi-centimes.");
    expect(body).toContain("À vérifier à la main (non testables) :\n- Le design est validé — jugement visuel");
    expect(body).not.toContain("La TVA est arrondie au centime"); // les testables ne sont pas relistés
  });

  it("plan, hypothèses et précédents retenus repliés", () => {
    expect(body).toContain("<details><summary>Plan (2 étapes)</summary>\n\n1. Écrire un test qui reproduit\n2. Corriger l'arrondi\n   Cas négatifs inclus\n\n</details>");
    expect(body).toContain("<details><summary>Hypothèses (1)</summary>\n\n- Arrondi commercial\n\n</details>");
    expect(body).toContain("<details><summary>Précédents (1)</summary>\n\n- #12 : même module\n\n</details>");
    expect(body).not.toContain("!34");
    expectSigned(body);
  });

  it("omet les sections vides", () => {
    const minimal = pickupComment({ ...analysis, plan: [], precedents: [], assumptions: [], criteria: [] }, "b");
    expect(minimal).not.toContain("<details>");
    expect(minimal).not.toContain("À vérifier");
    expect(minimal).toContain(" · aucune case à cocher · ");
  });
});

describe("needsInfoComment", () => {
  const body = needsInfoComment(["Quel arrondi ?", "Quelle devise ?\nEUR seulement ?"], ["alice", "@bob", "@alice", "Bob", " "]);

  it("mentionne chaque personne une seule fois en tête", () => {
    expect(body.startsWith("@alice @bob\n\n")).toBe(true);
  });

  it("numérote les questions", () => {
    expect(body).toContain("1. Quel arrondi ?\n2. Quelle devise ?\n   EUR seulement ?");
  });

  it("explique comment relancer et signe", () => {
    expect(body).toContain("Répondez en commentaire, puis remettez `auto::ready`.");
    expect(needsInfoComment(["q"], [], "bot::go")).toContain("remettez `bot::go`");
    expectSigned(body);
  });

  it("sans mention, commence directement par le message", () => {
    expect(needsInfoComment(["q"], []).startsWith("**Précisions nécessaires**")).toBe(true);
  });
});

describe("blockedComment", () => {
  it("cause, détails, puis branche, MR et relance sur une ligne", () => {
    const body = blockedComment({
      reason: "tests toujours rouges après 3 itérations",
      details: ["`vat.test.ts` échoue", "timeout sur e2e"],
      branch: "sprintsaver/42-tva",
      mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
      mentions: ["alice", "alice"],
    });
    expect(body.startsWith("@alice\n\n**Bloqué** : tests toujours rouges après 3 itérations\n\n- `vat.test.ts` échoue\n- timeout sur e2e")).toBe(true);
    expect(body).toContain(
      "Branche `sprintsaver/42-tva` · [MR brouillon](https://gitlab.example.com/g/p/-/merge_requests/7). Levez le blocage, puis remettez `auto::ready`.",
    );
    expect(body).not.toContain("--accept-ci");
    expectSigned(body);
  });

  it("omet MR et détails absents", () => {
    const body = blockedComment({ reason: "r", details: [], branch: "b", mentions: [] });
    expect(body).toBe("**Bloqué** : r\n\nBranche `b`. Levez le blocage, puis remettez `auto::ready`.\n\n<sub>SprintSaver</sub>\n");
  });

  it("sortie de commande en bloc de code, puis jobs CI repliés, et --accept-ci pour un blocage CI", () => {
    const body = blockedComment({
      reason: "plafond d'itérations CI atteint (3)",
      details: ["Pipeline : https://gitlab.example.com/p/2"],
      branch: "b",
      mentions: [],
      output: "ERROR: boom",
      jobs: [{ name: "test <unit>", webUrl: "https://gitlab.example.com/j/3", excerpt: "Tests: 1 failed" }],
      acceptCiRef: "shop#42",
    });
    expect(body).toContain("- Pipeline : https://gitlab.example.com/p/2\n\n```text\nERROR: boom\n```");
    expect(body).toContain("<summary>Log du job test &lt;unit&gt; (extrait)</summary>");
    expect(body).toContain("```text\nTests: 1 failed\n```");
    expect(body).toContain("Pour livrer sans CI verte : `sprintsaver run shop#42 --accept-ci`.");
  });
});

describe("baseCiBrokenComment", () => {
  it("dit en une ligne que la CI de la branche par défaut est cassée, avec le lien", () => {
    const body = baseCiBrokenComment({
      defaultBranch: "main",
      pipelineUrl: "https://gitlab.example.com/g/p/-/pipelines/99",
      branch: "sprintsaver/42-tva",
      mentions: ["@alice"],
      acceptCiRef: "shop#42",
    });
    expect(body).toBe(
      [
        "@alice",
        "",
        "**Bloqué : CI de `main` cassée**, indépendamment de ce ticket ([dernier pipeline](https://gitlab.example.com/g/p/-/pipelines/99)).",
        "",
        "Branche `sprintsaver/42-tva`. Réparez la CI de `main`, puis remettez `auto::ready`.",
        "Pour livrer sans CI verte : `sprintsaver run shop#42 --accept-ci`.",
        "",
        "<sub>SprintSaver</sub>",
        "",
      ].join("\n"),
    );
  });

  it("jobs communs avec la base et extraits de logs repliables, délimiteur plus long que les backticks du log", () => {
    const body = baseCiBrokenComment({
      defaultBranch: "main",
      pipelineUrl: "https://gitlab.example.com/g/p/-/pipelines/99",
      branch: "b",
      mentions: [],
      sharedJobs: ["db"],
      jobs: [
        { name: "db", webUrl: "https://gitlab.example.com/j/1", excerpt: "ERROR: ```relation``` manquante" },
        { name: "lint <web>", webUrl: "https://gitlab.example.com/j/2", excerpt: "" },
      ],
    });
    expect(body).toContain("En échec ici comme sur `main` : `db` (non relancés).");
    expect(body).toContain("<details><summary>Log du job db (extrait)</summary>");
    expect(body).toContain("````text\nERROR: ```relation``` manquante\n````");
    // Job sans extrait : lien seul, pas de bloc repliable.
    expect(body).toContain("- `lint <web>` : https://gitlab.example.com/j/2");
    expect(body.match(/<details>/g)).toHaveLength(1);
    expectSigned(body);
  });
});

describe("deliveredComment", () => {
  it("une ligne : lien de la MR et score de preuve ; critères manuels à part", () => {
    const body = deliveredComment({
      mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
      provenCount: 2,
      totalTestable: 3,
      untestable: ["Le design est validé"],
    });
    expect(body.startsWith("**MR prête à relire** : https://gitlab.example.com/g/p/-/merge_requests/7 · 2/3 critères prouvés\n\n")).toBe(true);
    expect(body).toContain("À vérifier à la main :\n- Le design est validé");
    expectSigned(body);
  });

  it("sans critère testable ni manuel : le lien seul", () => {
    expect(deliveredComment({ mrUrl: "u", provenCount: 0, totalTestable: 0, untestable: [] })).toBe(
      "**MR prête à relire** : u\n\n<sub>SprintSaver</sub>\n",
    );
  });
});

describe("markdown helpers", () => {
  it("codeSpan choisit un délimiteur plus long que les backticks internes", () => {
    expect(codeSpan("a")).toBe("`a`");
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x`")).toBe("`` `x` ``");
  });

  it("mentionList déduplique sans tenir compte de la casse ni du @", () => {
    expect(mentionList(["a", "@A", "@@b", "", "b"])).toEqual(["@a", "@b"]);
  });

  it("listItem indente les lignes de continuation", () => {
    expect(listItem("10.", "x\ny\n\nz")).toBe("10. x\n    y\n\n    z");
  });
});
