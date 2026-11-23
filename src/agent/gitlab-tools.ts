/**
 * Serveur MCP in-process exposant GitLab en lecture seule aux sessions agent (ADR § 4, § 9).
 * Tous les outils sont limités au projet du ticket courant : le modèle ne choisit jamais le projet.
 * Une erreur GitLab est renvoyée comme résultat `isError` lisible plutôt que levée.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { GitLabApi } from "../contracts.js";
import type { ProjectConfig } from "../config/schema.js";

export const GITLAB_MCP_SERVER_NAME = "gitlab";
const MR_DIFF_MAX_CHARS = 40_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

interface TextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function text(t: string): TextResult {
  return { content: [{ type: "text", text: t }] };
}

function errorResult(action: string, err: unknown): TextResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Erreur GitLab (${action}) : ${msg}` }], isError: true };
}

async function guarded(action: string, fn: () => Promise<string>): Promise<TextResult> {
  try {
    return text(await fn());
  } catch (err) {
    return errorResult(action, err);
  }
}

/** Définitions des outils (exportées pour tester les handlers sans démarrer le serveur). */
export function gitlabReadTools(gitlab: GitLabApi, project: ProjectConfig) {
  const pid = project.id;

  const searchIssues = tool(
    "search_issues",
    `Recherche des tickets du projet GitLab ${project.path} par mots-clés (titre et description). ` +
      "Utile pour trouver des précédents : tickets fermés similaires.",
    {
      query: z.string().min(1).describe("Mots-clés"),
      state: z.enum(["opened", "closed", "all"]).optional().describe("Filtre d'état (défaut : all)"),
      limit: z.number().int().min(1).max(20).optional().describe("Nombre max de résultats (défaut 10)"),
    },
    async (args) =>
      guarded("search_issues", async () => {
        const issues = await gitlab.searchIssues(pid, args.query, args.state ?? "all", args.limit ?? 10);
        if (issues.length === 0) return `Aucun ticket trouvé pour « ${args.query} ».`;
        return issues
          .map((i) => `#${i.iid} [${i.state}] ${i.title}${i.labels.length ? ` (labels : ${i.labels.join(", ")})` : ""} — ${i.webUrl}`)
          .join("\n");
      }),
    { annotations: { ...READ_ONLY, title: "Rechercher des tickets" } },
  );

  const getIssue = tool(
    "get_issue",
    `Lit un ticket du projet ${project.path} : description et commentaires humains.`,
    { iid: z.number().int().positive().describe("Numéro (iid) du ticket") },
    async (args) =>
      guarded("get_issue", async () => {
        const [issue, notes] = await Promise.all([gitlab.getIssue(pid, args.iid), gitlab.getIssueNotes(pid, args.iid)]);
        const parts = [
          `# #${issue.iid} ${issue.title}`,
          `État : ${issue.state} · type : ${issue.issueType} · auteur : @${issue.authorUsername} · créé le ${issue.createdAt}`,
          `Labels : ${issue.labels.length ? issue.labels.join(", ") : "aucun"}`,
          `URL : ${issue.webUrl}`,
          "",
          "## Description",
          issue.description.trim() || "(vide)",
          "",
          `## Commentaires (${notes.length})`,
          ...(notes.length
            ? notes.map((n) => `### @${n.authorUsername} — ${n.createdAt}\n${n.body.trim()}`)
            : ["(aucun)"]),
        ];
        return parts.join("\n");
      }),
    { annotations: { ...READ_ONLY, title: "Lire un ticket" } },
  );

  const getClosingMrs = tool(
    "get_issue_closing_mrs",
    `Liste les merge requests du projet ${project.path} qui ont fermé (ou fermeront) un ticket.`,
    { iid: z.number().int().positive().describe("Numéro (iid) du ticket") },
    async (args) =>
      guarded("get_issue_closing_mrs", async () => {
        const mrs = await gitlab.closingMrs(pid, args.iid);
        if (mrs.length === 0) return `Aucune MR liée à la fermeture de #${args.iid}.`;
        return mrs
          .map((m) => `!${m.iid} [${m.state}${m.mergedAt ? `, mergée le ${m.mergedAt}` : ""}] ${m.title} — ${m.webUrl}`)
          .join("\n");
      }),
    { annotations: { ...READ_ONLY, title: "MR qui ferment un ticket" } },
  );

  const getMrDiff = tool(
    "get_mr_diff",
    `Diff unifié d'une merge request du projet ${project.path} (tronqué à ${MR_DIFF_MAX_CHARS} caractères).`,
    { mr_iid: z.number().int().positive().describe("Numéro (iid) de la merge request") },
    async (args) =>
      guarded("get_mr_diff", async () => {
        const diff = await gitlab.mrDiff(pid, args.mr_iid, MR_DIFF_MAX_CHARS);
        return diff.trim() ? diff : `La MR !${args.mr_iid} n'a pas de diff.`;
      }),
    { annotations: { ...READ_ONLY, title: "Diff d'une MR" } },
  );

  return [searchIssues, getIssue, getClosingMrs, getMrDiff];
}

export function createGitLabReadServer(gitlab: GitLabApi, project: ProjectConfig): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: GITLAB_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions: `Accès en lecture seule au projet GitLab ${project.path} (tickets, MR, diffs). Aucune écriture n'est possible.`,
    tools: gitlabReadTools(gitlab, project),
  });
}
