/** Petites fonctions pures du moteur. */
import type { Issue, TestEntry } from "../contracts.js";
import type { ProjectConfig, TicketType } from "../config/schema.js";

/** Slug ASCII minuscule, séparé par des tirets, `max` caractères au plus (sans tiret final). */
export function slugify(title: string, max = 40): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/g, "") || "ticket";
}

export function branchName(iid: number, title: string): string {
  return `sprintsaver/${iid}-${slugify(title)}`;
}

/**
 * Type du ticket d'après ses labels (mapping de config) puis son type GitLab.
 * Retourne null si c'est à l'agent de décider.
 */
export function typeFromIssue(
  issue: Pick<Issue, "labels" | "issueType">,
  project: Pick<ProjectConfig, "typeLabels">,
): { type: TicketType; source: "labels" | "issue_type" } | null {
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()));
  const has = (list: string[]) => list.some((l) => labels.has(l.toLowerCase()));
  if (has(project.typeLabels.bug)) return { type: "bug", source: "labels" };
  if (has(project.typeLabels.feature)) return { type: "feature", source: "labels" };
  if (issue.issueType.toLowerCase() === "incident") return { type: "bug", source: "issue_type" };
  return null;
}

/** Ajoute ou remplace des tests (clé : fichier + nom). */
export function mergeTests(current: TestEntry[], incoming: TestEntry[]): TestEntry[] {
  const key = (t: TestEntry) => `${t.file}::${t.name}`;
  const out = [...current];
  for (const t of incoming) {
    const i = out.findIndex((x) => key(x) === key(t));
    if (i >= 0) out[i] = t;
    else out.push(t);
  }
  return out;
}

const FAIL_PATTERNS: RegExp[] = [
  /^\s*(?:FAIL|FAILED|✗|×|✕|✖)\s+(.+?)\s*$/,
  /^\s*not ok \d+\s+-?\s*(.+?)\s*$/,
  /^\s*---\s*FAIL:\s*(\S+)/,
  /^\s*Failed\s+(\S.+?)\s*(?:\[.*\])?\s*$/,
  /^(?:FAILED)\s+(\S+)/,
];

/** Repère, si c'est simple, les noms des tests en échec dans une sortie de test runner (au plus `max`). */
export function extractFailingTests(output: string, max = 10): string[] {
  const found: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    for (const re of FAIL_PATTERNS) {
      const m = re.exec(line);
      const name = m?.[1]?.trim();
      if (name && !found.includes(name)) {
        found.push(name.length > 160 ? `${name.slice(0, 157)}...` : name);
        break;
      }
    }
    if (found.length >= max) break;
  }
  return found;
}

/** Fait court pour un résumé de phase. */
export function shortFact(text: string, max = 200): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
