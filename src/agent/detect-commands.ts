/**
 * Détection des commandes d'un projet par une session Claude, pour `sprintsaver init` : l'IA lit le dépôt et propose
 * setup / build / test ; l'utilisateur valide ou corrige chaque proposition. La session est en lecture seule
 * (outils Read, Glob, Grep uniquement : rien n'est exécuté ni modifié).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SONNET } from "../config/schema.js";
import { resolveClaudeExecutable } from "./claude-path.js";
import { toOutputJsonSchema } from "./output-schema.js";
import { sessionEnv, type QueryFn } from "./runner.js";

export const DetectedCommandsSchema = z.object({
  stack: z.string().describe("Langage, framework et outil de test, en quelques mots (ex. « TypeScript / Next.js / Vitest »)"),
  setupCommand: z
    .string()
    .describe("Installation des dépendances depuis un dépôt fraîchement cloné, non interactive, respectant le lockfile. Vide si rien à installer."),
  buildCommand: z.string().describe("Compilation / build si le projet en a un et qu'il est utile avant les tests. Vide sinon."),
  testCommand: z.string().describe("Lance TOUTE la suite de tests automatisés, non interactive, code de sortie ≠ 0 en cas d'échec. Vide si aucun test."),
  testMode: z
    .enum(["local", "ci-only"])
    .describe("local si les tests tournent sur un poste de dev avec les outils du langage ; ci-only s'ils exigent des services absents en local (base, cloud, secrets CI)."),
  cowDirs: z.array(z.string()).describe("Dossiers de dépendances lourds à réutiliser entre copies du dépôt (ex. node_modules). Vide si aucun."),
  worktreeInclude: z
    .array(z.string())
    .describe("Fichiers ignorés par git mais nécessaires pour lancer les tests en local (ex. .env), en motifs .gitignore. Vide si aucun."),
  explanation: z.string().describe("Pourquoi ces commandes : fichiers lus et indices, en 2 à 4 phrases, en français"),
});
export type DetectedCommands = z.infer<typeof DetectedCommandsSchema>;

export const DETECT_PROMPT = `Tu analyses un dépôt pour configurer un outil qui va, sur le poste du développeur, cloner ce dépôt dans un dossier neuf, installer les dépendances, puis lancer la suite de tests pour valider des modifications.

Lis les fichiers qui décrivent le projet : manifestes et lockfiles (package.json, pnpm-lock.yaml, yarn.lock, *.csproj, *.sln, pom.xml, build.gradle, pyproject.toml, requirements*.txt, go.mod, Cargo.toml, Gemfile, composer.json…), Makefile / Taskfile / justfile, scripts du dossier racine, .gitlab-ci.yml (c'est souvent la meilleure source : la CI installe et teste le projet), Dockerfile / docker-compose, README et CONTRIBUTING, .env.example. Ne modifie rien et n'exécute rien.

Propose des commandes :
- lancées depuis la racine du dépôt, non interactives, sans variable d'environnement à saisir ;
- qui reproduisent ce que fait la CI quand c'est possible (mêmes scripts), sans les étapes propres à la CI (cache, artefacts, déploiement, docker login) ;
- qui respectent le lockfile (npm ci, pnpm install --frozen-lockfile, poetry install, dotnet restore…).
Pour un monorepo, propose les commandes qui couvrent l'ensemble (script racine) plutôt qu'un seul paquet.
Si une information manque, choisis la proposition la plus probable et dis-le dans l'explication : l'utilisateur relira et corrigera.`;

export interface DetectResult {
  commands: DetectedCommands;
  costUsd: number;
  turns: number;
}

/** Lance l'analyse dans `cwd` (le dépôt) ; lève si la session échoue ou si la sortie est invalide. */
export async function detectProjectCommands(
  cwd: string,
  opts: { queryFn?: QueryFn; claudeExecutable?: string; maxTurns?: number } = {},
): Promise<DetectResult> {
  const queryFn = opts.queryFn ?? query;
  let result: { subtype: string; structured_output?: unknown; num_turns: number; total_cost_usd: number; errors?: string[] } | null =
    null;
  for await (const msg of queryFn({
    prompt: DETECT_PROMPT,
    options: {
      pathToClaudeCodeExecutable: opts.claudeExecutable ?? resolveClaudeExecutable(),
      cwd,
      model: SONNET,
      settingSources: [],
      strictMcpConfig: true,
      // Lecture seule : aucun outil d'exécution ni d'écriture n'est disponible pendant l'analyse.
      tools: ["Read", "Glob", "Grep"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Analyse de dépôt pour SprintSaver, sans humain pour répondre : termine par la sortie structurée demandée.",
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: "json_schema", schema: toOutputJsonSchema(DetectedCommandsSchema) },
      maxTurns: opts.maxTurns ?? 30,
      env: sessionEnv(),
    },
  })) {
    if (msg.type === "result") result = msg;
  }
  if (!result) throw new Error("analyse terminée sans résultat");
  if (result.subtype !== "success") throw new Error(`analyse en erreur (${result.subtype}) : ${(result.errors ?? []).join("; ")}`);
  const parsed = DetectedCommandsSchema.safeParse(result.structured_output);
  if (!parsed.success) throw new Error(`sortie de l'analyse invalide : ${z.prettifyError(parsed.error)}`);
  const clean = (v: string) => v.trim();
  return {
    commands: {
      ...parsed.data,
      setupCommand: clean(parsed.data.setupCommand),
      buildCommand: clean(parsed.data.buildCommand),
      testCommand: clean(parsed.data.testCommand),
      cowDirs: parsed.data.cowDirs.map(clean).filter(Boolean),
      worktreeInclude: parsed.data.worktreeInclude.map(clean).filter(Boolean),
    },
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
  };
}
