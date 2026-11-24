import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { launchRecipePatch, projectSkillFromTemplate, withLaunchRecipe } from "../../src/domain/project-skill.js";

const TEMPLATE = [
  "# Projet <nom>",
  "",
  "## Contexte",
  "",
  "<!-- Ce que fait le produit.",
  "     Sur deux lignes. -->",
  "",
  "## Captures d'écran",
  "",
  "<!-- Comment lancer l'application. -->",
  "",
  "## Pièges connus",
  "",
  "<!-- Tests instables. -->",
  "",
].join("\n");

const RECIPE = "- `npx expo export --platform web` puis `npx serve dist-web -l 4801`.\n- Compte de démo : `demo@asso.test`.";

describe("skill projet : recette de lancement", () => {
  it("remplace le contenu de la section « Captures d'écran » et garde les autres", () => {
    const current = "# Projet shop\n\n## Captures d'écran\n\nancienne recette\n\n## Pièges connus\n\n- e2e instable\n";
    expect(withLaunchRecipe(current, RECIPE)).toBe(
      `# Projet shop\n\n## Captures d'écran\n\n${RECIPE}\n\n## Pièges connus\n\n- e2e instable\n`,
    );
  });

  it("ajoute la section si elle manque, y compris en fin de fichier", () => {
    expect(withLaunchRecipe("# Projet shop\n\n## Contexte\n\nx\n", "r")).toBe("# Projet shop\n\n## Contexte\n\nx\n\n## Captures d'écran\n\nr\n");
    expect(withLaunchRecipe("# Projet shop\n\n## Captures d'écran\n\nvieux\n", "r")).toBe("# Projet shop\n\n## Captures d'écran\n\nr\n");
  });

  it("nouveau skill tiré du gabarit : titre renseigné, commentaires retirés", () => {
    expect(projectSkillFromTemplate(TEMPLATE, "volunear")).toBe(
      "# Projet volunear\n\n## Contexte\n\n## Captures d'écran\n\n## Pièges connus\n",
    );
  });

  it("aucun patch sans recette ou si la section est déjà à jour", () => {
    expect(launchRecipePatch({ projectName: "shop", current: null, template: TEMPLATE, recipe: "  " })).toBeNull();
    const current = `# Projet shop\n\n## Captures d'écran\n\n${RECIPE}\n`;
    expect(launchRecipePatch({ projectName: "shop", current, template: TEMPLATE, recipe: RECIPE })).toBeNull();
  });
});

describe("launchRecipePatch appliqué par git apply", () => {
  let repo: string;
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  async function apply(patch: string): Promise<void> {
    writeFileSync(join(repo, "p.patch"), patch);
    await execa("git", ["apply", "p.patch"], { cwd: repo });
  }

  function setup(existing?: string): void {
    repo = mkdtempSync(join(tmpdir(), "ss-skill-"));
    mkdirSync(join(repo, "skills", "projects"), { recursive: true });
    if (existing !== undefined) writeFileSync(join(repo, "skills", "projects", "shop.md"), existing);
  }

  it("crée le fichier quand le projet n'a pas encore de skill", async () => {
    setup();
    await apply(launchRecipePatch({ projectName: "shop", current: null, template: TEMPLATE, recipe: RECIPE })!);
    expect(readFileSync(join(repo, "skills", "projects", "shop.md"), "utf8")).toBe(
      `# Projet shop\n\n## Contexte\n\n## Captures d'écran\n\n${RECIPE}\n\n## Pièges connus\n`,
    );
  });

  it("modifie un skill existant, même sans retour à la ligne final", async () => {
    const existing = "# Projet shop\n\n## Captures d'écran\n\npas de captures possibles";
    setup(existing);
    await apply(launchRecipePatch({ projectName: "shop", current: existing, template: TEMPLATE, recipe: RECIPE })!);
    expect(readFileSync(join(repo, "skills", "projects", "shop.md"), "utf8")).toBe(`# Projet shop\n\n## Captures d'écran\n\n${RECIPE}\n`);
  });
});
