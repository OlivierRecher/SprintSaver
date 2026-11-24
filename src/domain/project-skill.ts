/**
 * Patch proposé sur `skills/projects/<projet>.md` à partir de la recette de lancement trouvée par la session de
 * captures (ADR, amendement 7). Comme pour la rétro, l'utilisateur relit le patch et l'applique (`git apply`).
 */

export const CAPTURES_HEADING = "## Captures d'écran";

/** Contenu du skill projet avec la section « Captures d'écran » remplacée par la recette (ajoutée si absente). */
export function withLaunchRecipe(content: string, recipe: string): string {
  const lines = content.replace(/\s+$/, "").split("\n");
  const body = recipe.trim().split("\n");
  const start = lines.findIndex((l) => l.trim() === CAPTURES_HEADING);
  if (start === -1) return [...lines, "", CAPTURES_HEADING, "", ...body, ""].join("\n");
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const after = lines.slice(end);
  return [...lines.slice(0, start + 1), "", ...body, ...(after.length > 0 ? ["", ...after] : []), ""].join("\n");
}

/** Nouveau skill projet tiré du gabarit : titre renseigné, commentaires d'aide retirés. */
export function projectSkillFromTemplate(template: string, projectName: string): string {
  return template
    .replace(/<nom>/g, projectName)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "\n");
}

/**
 * Diff unifié applicable par `git apply` depuis la racine du dépôt SprintSaver. Un seul bloc qui remplace tout le
 * fichier : le skill est court (moins de 80 lignes) et le relecteur voit la section modifiée. `null` si rien ne change.
 */
export function launchRecipePatch(input: { projectName: string; current: string | null; template: string; recipe: string }): string | null {
  const recipe = input.recipe.trim();
  if (recipe === "") return null;
  const path = `skills/projects/${input.projectName}.md`;
  const base = input.current ?? projectSkillFromTemplate(input.template, input.projectName);
  const next = withLaunchRecipe(base, recipe);
  if (input.current !== null && next === input.current) return null;

  const newLines = next.replace(/\n$/, "").split("\n");
  if (input.current === null) {
    return [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${newLines.length} @@`,
      ...newLines.map((l) => `+${l}`),
      "",
    ].join("\n");
  }
  const oldLines = input.current.replace(/\n$/, "").split("\n");
  const oldNoEol = !input.current.endsWith("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...(oldNoEol ? ["\\ No newline at end of file"] : []),
    ...newLines.map((l) => `+${l}`),
    "",
  ].join("\n");
}
