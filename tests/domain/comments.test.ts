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

  it("annonce la prise en charge, le type et sa source", () => {
    expect(body.startsWith("**Pris en charge par SprintSaver.**")).toBe(true);
    expect(body).toContain("**Type retenu** : bug (d'après les labels du ticket)");
    expect(pickupComment({ ...analysis, type: "feature", typeSource: "agent" }, "b")).toContain(
      "**Type retenu** : fonctionnalité (déduit par l'analyse)",
    );
    expect(pickupComment({ ...analysis, typeSource: "issue_type" }, "b")).toContain("d'après le type GitLab du ticket");
  });

  it("contient résumé et plan numéroté (multi-ligne indenté)", () => {
    expect(body).toContain("### Résumé\nLe total TVA est faux pour les demi-centimes.");
    expect(body).toContain("### Plan\n1. Écrire un test qui reproduit\n2. Corriger l'arrondi\n   Cas négatifs inclus");
  });

  it("classe les critères testables / non testables avec raison", () => {
    expect(body).toContain("**Testables (1)** — seront prouvés par un test :\n- La TVA est arrondie au centime");
    expect(body).toContain(
      "**Non testables (1)** — à vérifier manuellement, ne bloquent pas la livraison :\n- Le design est validé — jugement visuel",
    );
  });

  it("ne liste que les précédents retenus, puis hypothèses et branche", () => {
    expect(body).toContain("### Précédents retenus\n- #12 : même module");
    expect(body).not.toContain("!34");
    expect(body).toContain("### Hypothèses\n- Arrondi commercial");
    expect(body).toContain("Branche de travail : `sprintsaver/42-tva`");
    expectSigned(body);
  });

  it("omet les sections vides", () => {
    const minimal = pickupComment({ ...analysis, plan: [], precedents: [], assumptions: [], criteria: [] }, "b");
    expect(minimal).not.toContain("### Plan");
    expect(minimal).not.toContain("### Précédents");
    expect(minimal).not.toContain("### Hypothèses");
    expect(minimal).not.toContain("Non testables");
    expect(minimal).toContain("Aucune case à cocher dans la description.");
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
    expect(body).toContain("Répondez en commentaire puis remettez le label `auto::ready`");
    expect(needsInfoComment(["q"], [], "bot::go")).toContain("remettez le label `bot::go`");
    expectSigned(body);
  });

  it("sans mention, commence directement par le message", () => {
    expect(needsInfoComment(["q"], []).startsWith("SprintSaver a besoin de précisions")).toBe(true);
  });
});

describe("blockedComment", () => {
  it("donne cause, détails, branche, MR et relance", () => {
    const body = blockedComment({
      reason: "tests toujours rouges après 3 itérations",
      details: ["`vat.test.ts` échoue", "timeout sur e2e"],
      branch: "sprintsaver/42-tva",
      mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
      mentions: ["alice", "alice"],
    });
    expect(body.startsWith("@alice\n\n**SprintSaver est bloqué sur ce ticket** : tests toujours rouges après 3 itérations")).toBe(
      true,
    );
    expect(body).toContain("Détails :\n- `vat.test.ts` échoue\n- timeout sur e2e");
    expect(body).toContain("- Travail en cours poussé sur la branche `sprintsaver/42-tva`.");
    expect(body).toContain("- Merge request (brouillon) : https://gitlab.example.com/g/p/-/merge_requests/7");
    expect(body).toContain("remettez le label `auto::ready`");
    expectSigned(body);
  });

  it("omet MR et détails absents", () => {
    const body = blockedComment({ reason: "r", details: [], branch: "b", mentions: [] });
    expect(body).not.toContain("Merge request");
    expect(body).not.toContain("Détails");
    expect(body.startsWith("**SprintSaver est bloqué")).toBe(true);
  });
});

describe("baseCiBrokenComment", () => {
  it("explique la CI cassée de la branche par défaut", () => {
    const body = baseCiBrokenComment({
      defaultBranch: "main",
      pipelineUrl: "https://gitlab.example.com/g/p/-/pipelines/99",
      branch: "sprintsaver/42-tva",
      mentions: ["@alice"],
    });
    expect(body.startsWith("@alice\n\n")).toBe(true);
    expect(body).toContain("La CI de `main` est cassée, indépendamment de ce ticket");
    expect(body).toContain("https://gitlab.example.com/g/p/-/pipelines/99");
    expect(body).toContain("`sprintsaver/42-tva`");
    expect(body).toContain("Une fois la CI de `main` réparée, remettez le label `auto::ready` pour relancer.");
    expectSigned(body);
  });
});

describe("deliveredComment", () => {
  it("annonce la MR, le score de preuve et les critères manuels", () => {
    const body = deliveredComment({
      mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
      summary: "Arrondi corrigé.",
      provenCount: 2,
      totalTestable: 3,
      untestable: ["Le design est validé"],
    });
    expect(body).toContain("**Merge request prête à relire** : https://gitlab.example.com/g/p/-/merge_requests/7");
    expect(body).toContain("Arrondi corrigé.");
    expect(body).toContain("**2/3**");
    expect(body).toContain("Critères non testables, à vérifier manuellement :\n- Le design est validé");
    expectSigned(body);
  });

  it("omet la section manuelle s'il n'y a rien", () => {
    const body = deliveredComment({ mrUrl: "u", summary: "", provenCount: 0, totalTestable: 0, untestable: [] });
    expect(body).not.toContain("manuellement");
    expect(body).toContain("**0/0**");
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
