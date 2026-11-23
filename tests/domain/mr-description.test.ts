import { describe, expect, it } from "vitest";
import { IN_PROGRESS_BANNER, renderMrDescription, type MrDescriptionInput } from "../../src/domain/mr-description.js";

function input(overrides: Partial<MrDescriptionInput> = {}): MrDescriptionInput {
  return {
    iid: 42,
    issueUrl: "https://gitlab.example.com/g/p/-/issues/42",
    summary: "Corrige le calcul de TVA.",
    criteria: [
      { index: 0, text: "La TVA est arrondie au centime", checkedInitially: false, testable: true },
      { index: 1, text: "Le design est validé", checkedInitially: false, testable: false, reason: "jugement visuel" },
      { index: 2, text: "Les totaux négatifs sont refusés", checkedInitially: false, testable: true },
    ],
    proofs: [
      { index: 0, proven: true, tests: ["test_a", "test_b"], reason: "assert sur 0,005 → 0,01" },
      { index: 2, proven: false, tests: [], reason: "le test n'asserte pas le refus" },
    ],
    tests: [
      { name: "test_a", file: "src/vat.test.ts", change: "added", criteria: [0], explanation: "arrondi standard" },
      { name: "test_b", file: "src/vat.test.ts", change: "modified", criteria: [0], explanation: "arrondi des demi-centimes" },
    ],
    assumptions: [],
    nits: [],
    flakyJobs: [],
    inProgress: false,
    ...overrides,
  };
}

describe("renderMrDescription", () => {
  it("rend le squelette dans l'ordre", () => {
    const md = renderMrDescription(input());
    expect(md.startsWith("Closes #42\n\n## Résumé\nCorrige le calcul de TVA.\n\n## Critères\n")).toBe(true);
    const order = ["Closes #42", "## Résumé", "## Critères", "## Tests ajoutés / modifiés"].map((s) => md.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(md).not.toContain(IN_PROGRESS_BANNER);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("ajoute la bannière en cours en tête si inProgress", () => {
    const md = renderMrDescription(input({ inProgress: true }));
    expect(md.startsWith(`${IN_PROGRESS_BANNER}\n\nCloses #42`)).toBe(true);
    expect(IN_PROGRESS_BANNER).toBe("> 🚧 Travail en cours — SprintSaver itère encore sur cette MR.");
  });

  it("rend les critères prouvés, non testables et non prouvés", () => {
    const md = renderMrDescription(input());
    expect(md).toContain(
      [
        "## Critères",
        "- [x] La TVA est arrondie au centime → `test_a`, `test_b` : assert sur 0,005 → 0,01",
        "- [ ] Le design est validé (non testable : jugement visuel)",
        "- [ ] Les totaux négatifs sont refusés (non prouvé : le test n'asserte pas le refus)",
      ].join("\n"),
    );
  });

  it("trie les critères par index et gère les cas sans preuve ni raison", () => {
    const md = renderMrDescription(
      input({
        criteria: [
          { index: 1, text: "B", checkedInitially: false },
          { index: 0, text: "A", checkedInitially: false, testable: false },
        ],
        proofs: [],
      }),
    );
    expect(md).toContain("- [ ] A (non testable : raison non précisée)\n- [ ] B (non prouvé : aucun test ne le prouve)");
  });

  it("indique l'absence de critères", () => {
    expect(renderMrDescription(input({ criteria: [], proofs: [] }))).toContain("## Critères\nAucun critère.");
  });

  it("liste les tests avec type de changement et fichier", () => {
    const md = renderMrDescription(input());
    expect(md).toContain(
      [
        "## Tests ajoutés / modifiés",
        "- `test_a` (ajouté, `src/vat.test.ts`) : arrondi standard",
        "- `test_b` (modifié, `src/vat.test.ts`) : arrondi des demi-centimes",
      ].join("\n"),
    );
  });

  it("signale l'absence de tests", () => {
    expect(renderMrDescription(input({ tests: [] }))).toContain("## Tests ajoutés / modifiés\nAucun test ajouté ou modifié.");
  });

  it("omet les sections optionnelles vides", () => {
    const md = renderMrDescription(input({ assumptions: ["  "] }));
    expect(md).not.toContain("## Hypothèses");
    expect(md).not.toContain("## Nits restants");
    expect(md).not.toContain("## Jobs CI instables");
  });

  it("rend hypothèses, nits et jobs instables", () => {
    const md = renderMrDescription(
      input({
        assumptions: ["Arrondi bancaire non souhaité", "Devise\nunique"],
        nits: [
          { severity: "nit", category: "style", file: "src/vat.ts", line: 12, description: "nom de variable" },
          { severity: "nit", category: "style", file: "src/a.ts", description: "sans ligne" },
          { severity: "nit", category: "doc", description: "sans fichier" },
        ],
        flakyJobs: ["test:e2e", "test:e2e", "lint"],
      }),
    );
    expect(md).toContain("## Hypothèses\n- Arrondi bancaire non souhaité\n- Devise unique");
    expect(md).toContain("## Nits restants\n- `src/vat.ts:12` nom de variable\n- `src/a.ts` sans ligne\n- sans fichier");
    expect(md).toContain(
      "## Jobs CI instables\n- `test:e2e` : passé à la 2ᵉ tentative\n- `lint` : passé à la 2ᵉ tentative",
    );
  });

  it("échappe les backticks dans les noms et aplatit les retours à la ligne", () => {
    const md = renderMrDescription(
      input({
        criteria: [{ index: 0, text: "Ligne 1\nLigne 2", checkedInitially: false, testable: true }],
        proofs: [{ index: 0, proven: true, tests: ["it `works`", "`edge`"], reason: "ok\r\nvraiment" }],
        tests: [{ name: "a``b", file: "f.ts", change: "added", criteria: [0], explanation: "x\ny" }],
      }),
    );
    expect(md).toContain("- [x] Ligne 1 Ligne 2 → `` it `works` ``, `` `edge` `` : ok vraiment");
    expect(md).toContain("- ```a``b``` (ajouté, `f.ts`) : x y");
  });

  it("omet les deux-points si preuve sans raison", () => {
    const md = renderMrDescription(
      input({
        criteria: [{ index: 0, text: "C", checkedInitially: false, testable: true }],
        proofs: [{ index: 0, proven: true, tests: ["t"], reason: "" }],
      }),
    );
    expect(md).toContain("- [x] C → `t`\n");
  });
});

describe("avant / après", () => {
  it("captures : une section après le résumé, un tableau Avant | Après par écran", () => {
    const md = renderMrDescription(
      input({
        captures: [
          { label: "Panier avec remise", beforeMarkdown: "![a](/uploads/s1/1-avant.png)", afterMarkdown: "![b](/uploads/s2/1-apres.png)", note: "Le total apparaît sous la liste." },
          { label: "Nouvel écran", afterMarkdown: "![c](/uploads/s3/2-apres.png)", note: "" },
        ],
      }),
    );
    expect(md).toContain(
      "## Captures avant / après\n\n### Panier avec remise\n\n| Avant | Après |\n|---|---|\n| ![a](/uploads/s1/1-avant.png) | ![b](/uploads/s2/1-apres.png) |\n\nLe total apparaît sous la liste.",
    );
    expect(md).toContain("| _écran inexistant avant ce changement_ | ![c](/uploads/s3/2-apres.png) |");
    expect(md.indexOf("## Résumé")).toBeLessThan(md.indexOf("## Captures avant / après"));
    expect(md.indexOf("## Captures avant / après")).toBeLessThan(md.indexOf("## Critères"));
  });

  it("captures manquantes : la raison est donnée au relecteur", () => {
    expect(renderMrDescription(input({ capturesMissing: "application impossible à lancer" }))).toContain(
      "## Captures avant / après\n\n> Captures non réalisées : application impossible à lancer",
    );
    const partial = renderMrDescription(
      input({ captures: [{ label: "A", afterMarkdown: "![x](/u/x.png)", note: "" }], capturesMissing: "B : authentification requise" }),
    );
    expect(partial).toContain("> Captures incomplètes : B : authentification requise");
  });

  it("changements de données et d'API : un diff explicite par contrat", () => {
    const md = renderMrDescription(
      input({
        dataChanges: [
          {
            subject: "GET /api/cart",
            kind: "endpoint",
            change: "modified",
            before: '{\n  "total": 12.3\n}',
            after: '{\n  "total": 12.30,\n  "currency": "EUR"\n}',
            note: "Champ ajouté, rétrocompatible.",
          },
          { subject: "table discounts", kind: "data", change: "added", before: "ignoré", after: "id INTEGER\nrate NUMERIC", note: "" },
        ],
      }),
    );
    expect(md).toContain(
      [
        "## Changements de données et d'API",
        "",
        "### `GET /api/cart` (API, modifié)",
        "",
        "Champ ajouté, rétrocompatible.",
        "",
        "```diff",
        " {",
        '-  "total": 12.3',
        '+  "total": 12.30,',
        '+  "currency": "EUR"',
        " }",
        "```",
      ].join("\n"),
    );
    // Ajout : l'avant éventuel est ignoré, tout est en « + ».
    expect(md).toContain("### `table discounts` (données, ajouté)\n\n```diff\n+id INTEGER\n+rate NUMERIC\n```");
  });

  it("le bloc diff reste fermé quand l'exemple contient des backticks", () => {
    const md = renderMrDescription(
      input({ dataChanges: [{ subject: "doc", kind: "data", change: "modified", before: "a", after: "```js\nb\n```", note: "" }] }),
    );
    expect(md).toContain("````diff\n-a\n+```js\n+b\n+```\n````");
  });

  it("sans captures ni changement de données : aucune section supplémentaire", () => {
    const md = renderMrDescription(input({ captures: [], dataChanges: [] }));
    expect(md).not.toContain("Captures");
    expect(md).not.toContain("Changements de données");
  });
});
