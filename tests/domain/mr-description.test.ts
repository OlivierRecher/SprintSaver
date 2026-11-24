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
  it("rend le squelette dans l'ordre : ticket, résumé sans titre, critères, tests", () => {
    const md = renderMrDescription(input());
    expect(md.startsWith("Closes #42\n\nCorrige le calcul de TVA.\n\n## Critères : 1/2 prouvés\n")).toBe(true);
    const order = ["Closes #42", "## Critères", "## Tests"].map((s) => md.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(md).not.toContain("## Résumé");
    expect(md).not.toContain(IN_PROGRESS_BANNER);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("ajoute la bannière en cours en tête si inProgress", () => {
    const md = renderMrDescription(input({ inProgress: true }));
    expect(md.startsWith(`${IN_PROGRESS_BANNER}\n\nCloses #42`)).toBe(true);
    expect(IN_PROGRESS_BANNER).toBe("> 🚧 Travail en cours — SprintSaver itère encore sur cette MR.");
  });

  it("critères : ouverts visibles, prouvés repliés avec leurs tests, sans la raison de la preuve", () => {
    const md = renderMrDescription(input());
    expect(md).toContain(
      [
        "## Critères : 1/2 prouvés",
        "- [ ] Le design est validé — à vérifier à la main : jugement visuel",
        "- [ ] Les totaux négatifs sont refusés — non prouvé : le test n'asserte pas le refus",
        "",
        "<details><summary>Critères prouvés (1)</summary>",
        "",
        "- [x] La TVA est arrondie au centime → `test_a`, `test_b`",
        "",
        "</details>",
      ].join("\n"),
    );
    expect(md).not.toContain("assert sur 0,005");
  });

  it("tous les critères prouvés : un titre avec le score et la liste repliée", () => {
    const md = renderMrDescription(
      input({
        criteria: [{ index: 0, text: "A", checkedInitially: false, testable: true }],
        proofs: [{ index: 0, proven: true, tests: ["t"], reason: "" }],
      }),
    );
    expect(md).toContain("## Critères : 1/1 prouvés\n\n<details><summary>Critères prouvés (1)</summary>\n\n- [x] A → `t`\n\n</details>");
  });

  it("coupe un critère trop long sur un mot", () => {
    const long = `Le texte d'introduction ${"devient très long ".repeat(15)}fin`;
    const md = renderMrDescription(input({ criteria: [{ index: 0, text: long, checkedInitially: false, testable: true }], proofs: [] }));
    const line = md.split("\n").find((l) => l.startsWith("- [ ] Le texte"))!;
    const text = line.slice("- [ ] ".length, line.indexOf(" — non prouvé"));
    expect(text.endsWith("long…")).toBe(true); // coupé après un mot entier
    expect(text.length).toBeLessThanOrEqual(140);
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
    expect(md).toContain("## Critères : 0/1 prouvés\n- [ ] A — à vérifier à la main : raison non précisée\n- [ ] B — non prouvé : aucun test ne le prouve");
  });

  it("indique l'absence de critères", () => {
    expect(renderMrDescription(input({ criteria: [], proofs: [] }))).toContain("## Critères\nAucun critère.");
  });

  it("tests : une ligne par fichier avec le nombre d'ajouts et de modifications", () => {
    const md = renderMrDescription(
      input({
        tests: [
          { name: "a", file: "src/vat.test.ts", change: "added", criteria: [0], explanation: "x" },
          { name: "b", file: "src/vat.test.ts", change: "added", criteria: [0], explanation: "x" },
          { name: "c", file: "src/vat.test.ts", change: "modified", criteria: [0], explanation: "x" },
          { name: "d", file: "e2e/cart.spec.ts", change: "modified", criteria: [1], explanation: "x" },
        ],
      }),
    );
    expect(md).toContain("## Tests\n- `src/vat.test.ts` : 2 ajoutés, 1 modifié\n- `e2e/cart.spec.ts` : 1 modifié");
    expect(md).not.toContain("`a`");
  });

  it("signale l'absence de tests", () => {
    expect(renderMrDescription(input({ tests: [] }))).toContain("## Tests\nAucun test ajouté ou modifié.");
  });

  it("omet les sections optionnelles vides", () => {
    const md = renderMrDescription(input({ assumptions: ["  "] }));
    expect(md).not.toContain("Hypothèses");
    expect(md).not.toContain("Nits");
    expect(md).not.toContain("## À vérifier");
  });

  it("à vérifier, en tête : CI acceptée, CI non exécutée, jobs instables", () => {
    const md = renderMrDescription(
      input({ ciAccepted: true, ciNoRunnerPipelineUrl: "https://gitlab.example.com/g/p/-/pipelines/7", flakyJobs: ["test:e2e", "test:e2e", "lint"] }),
    );
    expect(md).toContain(
      [
        "## À vérifier",
        "- **CI rouge acceptée manuellement** (`sprintsaver run --accept-ci`) : aucun pipeline vert sur ce code.",
        "- **CI non exécutée** : aucun runner disponible ([pipeline](https://gitlab.example.com/g/p/-/pipelines/7)).",
        "- Jobs instables : `test:e2e`, `lint` (vert à la 2ᵉ tentative).",
      ].join("\n"),
    );
    expect(md.indexOf("## À vérifier")).toBeLessThan(md.indexOf("## Critères"));
    expect(renderMrDescription(input({ flakyJobs: ["e2e"] }))).toContain("- Job instable : `e2e` (vert à la 2ᵉ tentative).");
  });

  it("hypothèses et nits repliés, avec leur nombre", () => {
    const md = renderMrDescription(
      input({
        assumptions: ["Arrondi bancaire non souhaité", "Devise\nunique"],
        nits: [
          { severity: "nit", category: "style", file: "src/vat.ts", line: 12, description: "nom de variable" },
          { severity: "nit", category: "style", file: "src/a.ts", description: "sans ligne" },
          { severity: "nit", category: "doc", description: "sans fichier" },
        ],
      }),
    );
    expect(md).toContain("<details><summary>Hypothèses (2)</summary>\n\n- Arrondi bancaire non souhaité\n- Devise unique\n\n</details>");
    expect(md).toContain(
      "<details><summary>Nits restants (3)</summary>\n\n- `src/vat.ts:12` nom de variable\n- `src/a.ts` sans ligne\n- sans fichier\n\n</details>",
    );
  });

  it("échappe les backticks dans les noms et aplatit les retours à la ligne", () => {
    const md = renderMrDescription(
      input({
        criteria: [{ index: 0, text: "Ligne 1\nLigne 2", checkedInitially: false, testable: true }],
        proofs: [{ index: 0, proven: true, tests: ["it `works`", "`edge`"], reason: "ok\r\nvraiment" }],
        tests: [{ name: "a", file: "f``.ts", change: "added", criteria: [0], explanation: "x\ny" }],
      }),
    );
    expect(md).toContain("- [x] Ligne 1 Ligne 2 → `` it `works` ``, `` `edge` ``\n");
    expect(md).toContain("- ```f``.ts``` : 1 ajouté");
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
      "## Captures\n\n### Panier avec remise\n\n| Avant | Après |\n|---|---|\n| ![a](/uploads/s1/1-avant.png) | ![b](/uploads/s2/1-apres.png) |\n\nLe total apparaît sous la liste.",
    );
    expect(md).toContain("| _écran inexistant avant ce changement_ | ![c](/uploads/s3/2-apres.png) |");
    expect(md.indexOf("Corrige le calcul de TVA.")).toBeLessThan(md.indexOf("## Captures"));
    expect(md.indexOf("## Captures")).toBeLessThan(md.indexOf("## Critères"));
  });

  it("captures manquantes : la raison est donnée au relecteur", () => {
    expect(renderMrDescription(input({ capturesMissing: "application impossible à lancer" }))).toContain(
      "## Captures\n\n> Captures non réalisées : application impossible à lancer",
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
        "## Changements d'API et de données",
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

  it("note de capture coupée à 200 caractères", () => {
    const md = renderMrDescription(input({ captures: [{ label: "A", afterMarkdown: "![x](/u/x.png)", note: "mot ".repeat(100) }] }));
    const note = md.split("\n").find((l) => l.startsWith("mot "))!;
    expect(note.length).toBeLessThanOrEqual(200);
    expect(note.endsWith("…")).toBe(true);
  });

  it("sans captures ni changement de données : aucune section supplémentaire", () => {
    const md = renderMrDescription(input({ captures: [], dataChanges: [] }));
    expect(md).not.toContain("Captures");
    expect(md).not.toContain("Changements d'API");
  });
});
