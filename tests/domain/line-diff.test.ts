import { describe, expect, it } from "vitest";
import { lineDiff } from "../../src/domain/line-diff.js";

describe("lineDiff", () => {
  it("garde les lignes communes et marque les retraits puis les ajouts", () => {
    const before = ['{', '  "total": 12.3', '  "items": 2', '}'].join("\n");
    const after = ['{', '  "total": 12.30', '  "currency": "EUR"', '  "items": 2', '}'].join("\n");
    expect(lineDiff(before, after)).toEqual([
      " {",
      '-  "total": 12.3',
      '+  "total": 12.30',
      '+  "currency": "EUR"',
      '   "items": 2',
      " }",
    ]);
  });

  it("ajout pur, suppression pure, textes vides", () => {
    expect(lineDiff("", "a\nb")).toEqual(["+a", "+b"]);
    expect(lineDiff("a\nb\n", "")).toEqual(["-a", "-b"]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("ignore les fins de ligne Windows et le retour à la ligne final", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb")).toEqual([" a", " b"]);
  });

  it("très gros textes : tout l'avant retiré puis tout l'après ajouté, sans calcul quadratique", () => {
    const big = (p: string) => Array.from({ length: 600 }, (_, i) => `${p}${i}`).join("\n");
    const out = lineDiff(big("a"), big("b"));
    expect(out).toHaveLength(1200);
    expect(out[0]).toBe("-a0");
    expect(out[600]).toBe("+b0");
  });
});
