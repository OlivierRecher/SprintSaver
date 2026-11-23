import { describe, expect, it } from "vitest";
import { checkBoxes, checkBoxesByText, parseCheckboxes } from "../../src/domain/checkboxes.js";

describe("parseCheckboxes", () => {
  it("repère toutes les puces et numérotations", () => {
    const md = ["- [ ] tiret", "* [x] étoile", "+ [X] plus", "1. [ ] point", "12) [ ] parenthèse"].join("\n");
    expect(parseCheckboxes(md)).toEqual([
      { index: 0, text: "tiret", checked: false, line: 0 },
      { index: 1, text: "étoile", checked: true, line: 1 },
      { index: 2, text: "plus", checked: true, line: 2 },
      { index: 3, text: "point", checked: false, line: 3 },
      { index: 4, text: "parenthèse", checked: false, line: 4 },
    ]);
  });

  it("gère l'imbrication (espaces et tabulations) et le texte libre autour", () => {
    const md = [
      "# Critères",
      "",
      "Intro libre.",
      "- [ ] parent",
      "  - [x] enfant",
      "    1. [ ] petit-enfant",
      "\t- [ ] tabulé",
      "- élément sans case",
      "Fin.",
    ].join("\n");
    const boxes = parseCheckboxes(md);
    expect(boxes.map((b) => [b.index, b.text, b.checked, b.line])).toEqual([
      [0, "parent", false, 3],
      [1, "enfant", true, 4],
      [2, "petit-enfant", false, 5],
      [3, "tabulé", false, 6],
    ]);
  });

  it("trim le texte et garde le markdown inline", () => {
    expect(parseCheckboxes("-   [ ]    le **bouton** `ok`   ")[0]?.text).toBe("le **bouton** `ok`");
    expect(parseCheckboxes("- [ ]")[0]).toEqual({ index: 0, text: "", checked: false, line: 0 });
  });

  it("ignore les crochets hors élément de liste", () => {
    const md = [
      "Voir [ ] ici",
      "[ ] en début de ligne",
      "-[ ] sans espace",
      "- [] vide",
      "- [ x] mal formé",
      "- [x]collé",
      "- texte puis [ ] case",
      "- `[ ]` en code",
      "1.[ ] sans espace",
      "a. [ ] lettre",
    ].join("\n");
    expect(parseCheckboxes(md)).toEqual([]);
  });

  it("ignore les cases dans les blocs de code ``` et ~~~, même indentés", () => {
    const md = [
      "- [ ] avant",
      "```md",
      "- [ ] dans backticks",
      "```",
      "~~~",
      "- [ ] dans tildes",
      "```",
      "- [ ] toujours dans tildes (``` ne ferme pas ~~~)",
      "~~~",
      "- [ ] entre",
      "  ```",
      "  - [ ] dans bloc indenté",
      "  ```",
      "- ```",
      "  - [ ] bloc ouvert sur une puce",
      "  ```",
      "````",
      "```",
      "- [ ] la clôture doit être au moins aussi longue",
      "````",
      "- [ ] après",
    ].join("\n");
    expect(parseCheckboxes(md).map((b) => [b.text, b.line])).toEqual([
      ["avant", 0],
      ["entre", 9],
      ["après", 20],
    ]);
  });

  it("ne prend pas ```` ```x` ``` ```` pour une ouverture (backtick dans l'info)", () => {
    const md = ["``` a`b", "- [ ] visible"].join("\n");
    expect(parseCheckboxes(md).map((b) => b.text)).toEqual(["visible"]);
  });

  it("un bloc non fermé masque la suite", () => {
    expect(parseCheckboxes(["- [ ] a", "```", "- [ ] b"].join("\n")).map((b) => b.text)).toEqual(["a"]);
  });

  it("gère les fins de ligne CRLF", () => {
    const md = "- [ ] un\r\n```\r\n- [ ] code\r\n```\r\n- [x] deux\r\n";
    expect(parseCheckboxes(md)).toEqual([
      { index: 0, text: "un", checked: false, line: 0 },
      { index: 1, text: "deux", checked: true, line: 4 },
    ]);
  });

  it("chaîne vide", () => {
    expect(parseCheckboxes("")).toEqual([]);
  });
});

describe("checkBoxes", () => {
  const md = [
    "Intro avec [ ] crochets",
    "- [ ] zéro",
    "```",
    "- [ ] code",
    "```",
    "  * [ ] un",
    "1) [ ] deux",
    "- [X] trois",
  ].join("\n");

  it("coche exactement les index demandés et rien d'autre", () => {
    const out = checkBoxes(md, [0, 2]);
    expect(out).toBe(
      ["Intro avec [ ] crochets", "- [x] zéro", "```", "- [ ] code", "```", "  * [ ] un", "1) [x] deux", "- [X] trois"].join(
        "\n",
      ),
    );
    expect(parseCheckboxes(out).map((b) => b.checked)).toEqual([true, false, true, true]);
  });

  it("préserve CRLF, fins de ligne mixtes et absence de saut final", () => {
    const crlf = "a\r\n- [ ] un\r\n  - [ ] deux  \r\n\r\nfin";
    expect(checkBoxes(crlf, [1])).toBe("a\r\n- [ ] un\r\n  - [x] deux  \r\n\r\nfin");
    const mixed = "- [ ] a\n- [ ] b\r\n- [ ] c\n";
    expect(checkBoxes(mixed, [0, 1, 2])).toBe("- [x] a\n- [x] b\r\n- [x] c\n");
  });

  it("est idempotent et laisse [X] tel quel", () => {
    const once = checkBoxes(md, [0, 1, 3]);
    expect(checkBoxes(once, [0, 1, 3])).toBe(once);
    expect(once).toContain("- [X] trois");
  });

  it("ignore les index inconnus, les doublons et une liste vide", () => {
    expect(checkBoxes(md, [])).toBe(md);
    expect(checkBoxes(md, [-1, 42])).toBe(md);
    expect(checkBoxes(md, [1, 1])).toBe(checkBoxes(md, [1]));
  });

  it("ne touche pas au texte de la case même s'il contient [ ]", () => {
    expect(checkBoxes("- [ ] gérer [ ] et [x]", [0])).toBe("- [x] gérer [ ] et [x]");
  });

  it("préserve les caractères non ASCII et emoji autour", () => {
    const s = "🚀 é\n- [ ] ça 👍\n";
    expect(checkBoxes(s, [0])).toBe("🚀 é\n- [x] ça 👍\n");
  });
});

describe("commentaires HTML", () => {
  it("ignore les cases dans <!-- --> (une ou plusieurs lignes), pas celles autour", () => {
    const md = [
      "- [ ] avant",
      "<!-- - [ ] commentée sur une ligne -->",
      "<!--",
      "- [ ] commentée",
      "  - [x] commentée aussi",
      "-->",
      "- [ ] entre <!-- note inline -->",
      "  <!-- début",
      "- [ ] encore commentée",
      "fin --> texte",
      "```",
      "<!--",
      "```",
      "- [ ] après (le <!-- était dans du code)",
    ].join("\n");
    expect(parseCheckboxes(md).map((b) => [b.index, b.text, b.line])).toEqual([
      [0, "avant", 0],
      [1, "entre <!-- note inline -->", 6],
      [2, "après (le <!-- était dans du code)", 13],
    ]);
    const out = checkBoxes(md, [0, 1, 2, 3, 4]);
    expect(out).toContain("\n- [ ] commentée\n");
    expect(out).toContain("\n- [ ] encore commentée\n");
    expect(out).toContain("- [x] après");
  });

  it("un commentaire non fermé masque la suite", () => {
    expect(parseCheckboxes(["- [ ] a", "<!--", "- [ ] b"].join("\n")).map((b) => b.text)).toEqual(["a"]);
  });
});

describe("checkBoxesByText", () => {
  it("coche l'index donné si son texte (normalisé) correspond", () => {
    const md = "- [ ] un\n- [ ]   deux   mots  \n- [ ] trois";
    expect(checkBoxesByText(md, [{ index: 1, text: "deux mots" }])).toBe("- [ ] un\n- [x]   deux   mots  \n- [ ] trois");
  });

  it("description modifiée entre-temps : retrouve la case par son texte au lieu de cocher la mauvaise", () => {
    // Analyse faite sur « - [ ] a / - [ ] b » ; un humain a inséré une case en tête depuis.
    const md = "- [ ] nouvelle\n- [ ] a\n- [ ] b";
    expect(checkBoxesByText(md, [{ index: 0, text: "a" }, { index: 1, text: "b" }])).toBe("- [ ] nouvelle\n- [x] a\n- [x] b");
  });

  it("ne fait rien si le texte n'existe plus ou si la case est déjà cochée", () => {
    const md = "- [ ] x\n- [x] y";
    expect(checkBoxesByText(md, [{ index: 0, text: "disparue" }])).toBe(md);
    expect(checkBoxesByText(md, [{ index: 1, text: "y" }])).toBe(md);
    expect(checkBoxesByText(md, [])).toBe(md);
  });

  it("deux critères de même texte cochent deux cases distinctes", () => {
    const md = "- [ ] intro\n- [ ] même\n- [ ] même";
    expect(checkBoxesByText(md, [{ index: 0, text: "même" }, { index: 5, text: "même" }])).toBe("- [ ] intro\n- [x] même\n- [x] même");
    // l'index exact est réservé en priorité
    expect(checkBoxesByText(md, [{ index: 0, text: "même" }, { index: 2, text: "même" }])).toBe("- [ ] intro\n- [x] même\n- [x] même");
  });
});
