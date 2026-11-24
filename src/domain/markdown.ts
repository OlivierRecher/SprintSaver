/** Petits utilitaires de rendu markdown (GitLab Flavored Markdown) partagés par les textes du domaine. */

/**
 * Code inline sûr : le délimiteur est une suite de backticks plus longue que la plus longue
 * présente dans le texte, avec des espaces de garde si le texte commence ou finit par un backtick.
 */
export function codeSpan(text: string): string {
  const value = oneLine(text);
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Délimiteur de bloc de code plus long que toute suite de backticks du contenu (3 au minimum). */
export function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Coupe un texte trop long sur un mot, avec « … ». */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Échappe le texte placé dans une balise HTML (`<summary>`), où le markdown n'est pas fiable. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Ramène un texte sur une seule ligne (les retours à la ligne casseraient un élément de liste ou de tableau). */
export function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Élément de liste dont le texte peut tenir sur plusieurs lignes : les lignes suivantes sont indentées
 * sous le contenu de l'élément pour rester dans la liste.
 */
export function listItem(marker: string, text: string): string {
  const indent = " ".repeat(marker.length + 1);
  const lines = text.trim().split(/\r?\n/);
  return lines.map((line, i) => (i === 0 ? `${marker} ${line}` : line.trim() === "" ? "" : `${indent}${line}`)).join("\n");
}

/** Mentions `@user` dédupliquées (insensible à la casse et au `@` initial), dans l'ordre d'apparition. */
export function mentionList(mentions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of mentions) {
    const username = raw.trim().replace(/^@+/, "");
    if (username === "") continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`@${username}`);
  }
  return out;
}
