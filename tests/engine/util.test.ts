import { describe, expect, it } from "vitest";
import { branchName, extractFailingTests, mergeTests, slugify, typeFromIssue } from "../../src/engine/util.js";
import { makeProject } from "../helpers/fakes.js";

describe("util", () => {
  it("slug de branche : ASCII, 40 caractères max, sans tiret final", () => {
    expect(slugify("Écran « Panier » : total erroné !")).toBe("ecran-panier-total-errone");
    expect(slugify("a".repeat(39) + " bcd")).toBe("a".repeat(39));
    expect(slugify("!!!")).toBe("ticket");
    expect(branchName(7, "Fix login")).toBe("sprintsaver/7-fix-login");
  });

  it("type depuis les labels, puis le type GitLab, sinon null", () => {
    const p = makeProject();
    expect(typeFromIssue({ labels: ["Type::Bug"], issueType: "issue" }, p)).toEqual({ type: "bug", source: "labels" });
    expect(typeFromIssue({ labels: ["feature"], issueType: "incident" }, p)).toEqual({ type: "feature", source: "labels" });
    expect(typeFromIssue({ labels: [], issueType: "incident" }, p)).toEqual({ type: "bug", source: "issue_type" });
    expect(typeFromIssue({ labels: [], issueType: "issue" }, p)).toBeNull();
  });

  it("repère les tests en échec dans des sorties courantes", () => {
    const out = ["FAIL src/a.test.ts > somme", " ✗ arrondit", "not ok 3 - parse vide", "--- FAIL: TestX (0.00s)", "ok"].join("\n");
    expect(extractFailingTests(out)).toEqual(["src/a.test.ts > somme", "arrondit", "parse vide", "TestX"]);
  });

  it("fusionne les tests par fichier + nom", () => {
    const t = (name: string, explanation: string) => ({ name, file: "f", change: "added" as const, criteria: [], explanation });
    expect(mergeTests([t("a", "1"), t("b", "1")], [t("a", "2"), t("c", "1")]).map((x) => `${x.name}${x.explanation}`)).toEqual(["a2", "b1", "c1"]);
  });
});
