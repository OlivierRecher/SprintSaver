/**
 * Agent de configuration de `sprintsaver init` (ADR, amendement 5).
 *
 * Une session Agent SDK par projet produit une proposition complète de config (nom court, checkout local, stack,
 * commandes, mode de test, pipeline, fichiers à copier, dossiers de dépendances, statuts, labels de type), avec une
 * explication, les versions de toolchain relevées et les prérequis manquants.
 * - données du projet et de la machine via les outils MCP in-process de `config-tools.ts` ;
 * - commandes déléguées au sous-agent `detect-commands` (option `agents`, outil Agent) ;
 * - outils intégrés en lecture seule (Read, Glob, Grep) dans un worktree de la branche par défaut ; ni Bash ni
 *   écriture ; aucune écriture sur GitLab (les labels sont créés par le code déterministe, après validation) ;
 * - `settingSources: []`, `strictMcpConfig`, garde-fou PreToolUse, sans clé API (ADR § 2) ;
 * - sortie structurée revalidée par zod, avec une relance sur la même session.
 */
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  query,
  type HookCallback,
  type HookCallbackMatcher,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { OPUS, SONNET, type Config } from "../config/schema.js";
import { resolveClaudeExecutable } from "./claude-path.js";
import { INIT_MCP_SERVER_NAME, MAX_VERIFY_ATTEMPTS, initToolName } from "./config-tools.js";
import { DETECT_COMMANDS_AGENT, detectCommandsAgent } from "./detect-commands.js";
import { createGuardHooks, realpathLongestPrefix } from "./guard-hook.js";
import { toOutputJsonSchema } from "./output-schema.js";
import { parseJsonFromText, sessionEnv, type QueryFn } from "./runner.js";

/** Clés de `config.models` qui surchargent les modèles de l'agent de configuration. */
export const CONFIG_AGENT_MODEL_KEY = "init";
export const DETECT_COMMANDS_MODEL_KEY = DETECT_COMMANDS_AGENT;

export function configAgentModels(config: Pick<Config, "models"> | null): { main: string; detect: string } {
  return {
    main: config?.models[CONFIG_AGENT_MODEL_KEY] ?? SONNET,
    detect: config?.models[DETECT_COMMANDS_MODEL_KEY] ?? OPUS,
  };
}

const StatusTargetProposal = z.object({
  kind: z.enum(["native", "label"]).describe("native : statut natif des work items ; label : label du projet (créé par l'orchestrateur s'il n'existe pas)"),
  name: z.string().describe("Nom du statut natif ou du label"),
  id: z.string().describe("Id global du statut natif (gid://…) ; vide pour un label"),
});

export const ToolchainEntrySchema = z.object({
  tool: z.string().describe("Outil (node, python, java, dotnet, go, ruby…)"),
  required: z.string().describe("Version exigée par le dépôt (vide si aucune)"),
  source: z.string().describe("D'où vient l'exigence (CI, fichier de version, manifeste, README)"),
  available: z.string().describe("Ce que la machine fournit (défaut du PATH, gestionnaires de versions)"),
  pinnedBy: z.string().describe("Comment les commandes fixent la version (vide si elles ne la fixent pas)"),
});

export const ConfigProposalSchema = z.object({
  name: z.string().describe("Nom court du projet : lettres, chiffres, - et _, unique parmi les projets suivis"),
  localCheckout: z.string().describe("Checkout local de l'utilisateur (chemin absolu) ; vide si aucun"),
  stack: z.string().describe("Langage / framework / outil de test, en quelques mots"),
  setupCommand: z.string().describe("Installation des dépendances dans un worktree neuf ; vide si rien"),
  buildCommand: z.string().describe("Build utile avant les tests, indicatif (jamais exécuté comme garde-fou) ; vide sinon"),
  testCommand: z
    .string()
    .describe("Seule commande exécutée pour valider une modification : toutes les vérifications bloquantes de la CI (typecheck, lint, tests…), non interactive ; vide si aucune"),
  testMode: z.enum(["local", "ci-only"]),
  ciSource: z.enum(["merge_request", "branch"]).describe("Pipeline à surveiller après un push"),
  worktreeInclude: z
    .array(z.string())
    .describe("Fichiers ignorés par git nécessaires pour lancer les tests et l'application en local (config d'environnement locale, secrets de dev…), copiés depuis le checkout local dans chaque worktree (motifs .gitignore)"),
  cowDirs: z.array(z.string()).describe("Dossiers de dépendances lourds à cloner en copy-on-write"),
  status: z.object({ inProgress: StatusTargetProposal, inReview: StatusTargetProposal, blocked: StatusTargetProposal }),
  typeLabels: z.object({
    bug: z.array(z.string()).describe("Labels qui désignent un bug (créés s'ils n'existent pas)"),
    feature: z.array(z.string()).describe("Labels qui désignent une évolution (créés s'ils n'existent pas)"),
  }),
  toolchain: z.array(ToolchainEntrySchema),
  prerequisites: z.array(z.string()).describe("Ce que l'utilisateur doit installer ou faire avant le premier ticket, avec la commande ; vide si rien"),
  verification: z.object({
    status: z.enum(["passed", "baseline_red", "broken", "prerequisite_missing", "not_run"]),
    failingTests: z.array(z.string()).describe("Tests rouges sur la branche par défaut (ligne de base)"),
    note: z.string(),
  }),
  explanation: z.string().describe("Pourquoi cette config, en 3 à 6 phrases, en français"),
});
export type AgentProposal = z.infer<typeof ConfigProposalSchema>;

export const CONFIG_AGENT_SYSTEM = `# Agent de configuration SprintSaver

SprintSaver est un outil qui traite des tickets GitLab jusqu'à une merge request prête à relire. Pour chaque ticket, il crée un worktree neuf de la branche par défaut, le prépare (fichiers ignorés copiés depuis le checkout local de l'utilisateur, dossiers de dépendances clonés en copy-on-write, commande de setup), puis lance build et tests. Il suit l'avancement du ticket par des statuts (natifs ou labels) et reconnaît le type du ticket par ses labels.

Tu proposes la config SprintSaver complète d'UN projet. Personne ne répond à tes questions pendant la session : tranche, et explique tes choix. L'utilisateur relira ta proposition et pourra la corriger avant que quoi que ce soit soit écrit.
- Tu ne modifies aucun fichier et tu n'as pas de Bash. Ton répertoire courant est un worktree de la branche par défaut : lis-y le dépôt (Read, Glob, Grep).
- Les données du projet et de la machine passent par les outils du serveur ${INIT_MCP_SERVER_NAME}. Aucun outil n'écrit sur GitLab : l'orchestrateur créera lui-même les labels manquants après validation.
- Les commandes setup, build et test sont l'affaire du sous-agent ${DETECT_COMMANDS_AGENT} : ne les devine pas toi-même.
- Termine par la sortie structurée demandée, conforme au schéma JSON.`;

export function configAgentPrompt(projectPath: string): string {
  return `Propose la config SprintSaver du projet GitLab ${projectPath}.

Étapes :
1. get_project_info : infos du projet, nom proposé, noms déjà pris, config actuelle éventuelle. Une config actuelle est le point de départ : garde ses valeurs sauf si elles sont fausses ou périmées.
2. Checkout local : garde celui de la config actuelle s'il existe encore ; sinon appelle find_local_checkout. S'il y en a plusieurs, prends le plus probable (dossier de travail habituel, pas une copie de sauvegarde) et dis pourquoi. Aucun : chaîne vide.
3. analyse_ci : ciSource (merge_request si la CI déclenche des pipelines de MR, sinon branch) et versions de toolchain de la CI.
4. Délègue les commandes au sous-agent ${DETECT_COMMANDS_AGENT} (outil Agent, subagent_type « ${DETECT_COMMANDS_AGENT} », au premier plan : pas en arrière-plan). Donne-lui dans ta demande : le chemin du projet, le checkout local retenu (il y cherche les fichiers ignorés à copier : config d'environnement locale, secrets de dev), les commandes de la config actuelle s'il y en a, et ce que tu as appris de la CI. Il fait vérifier ses commandes par une exécution réelle (${MAX_VERIFY_ATTEMPTS} tentatives au plus pour le projet) et rend un bloc JSON : reprends-en les commandes, testMode, worktreeInclude, cowDirs, toolchain, prerequisites et verification sans les réécrire. N'appelle pas ${initToolName("verify_commands")} toi-même.
5. list_native_statuses et list_labels, puis le mapping des trois rôles :
   - inProgress (le ticket est en cours de traitement), inReview (MR livrée, à relire), blocked (l'outil est bloqué et attend un humain) ;
   - pour chaque rôle, un statut natif s'il en existe un qui correspond (id et nom exacts), sinon un label existant qui correspond, sinon un label à créer : sprintsaver::en-cours, sprintsaver::en-review, sprintsaver::bloque ;
   - ne mappe pas deux rôles sur la même cible.
6. typeLabels : les labels existants qui désignent un bug et ceux qui désignent une évolution (feature, enhancement, story…). S'il n'y en a aucun pour un type, propose « bug » ou « feature » (créé par l'orchestrateur).
7. name : le nom proposé par get_project_info, sauf si la config actuelle en a un.

Attends le rapport du sous-agent avant de rendre la sortie structurée : ne rends jamais de sortie partielle ou provisoire, elle est définitive. Dans explanation, résume les choix qui méritent l'attention de l'utilisateur (version de toolchain fixée, checkout retenu, labels à créer, tests rouges sur la branche par défaut).`;
}

export interface ConfigAgentParams {
  /** Worktree de la branche par défaut, lu par l'agent. */
  cwd: string;
  projectPath: string;
  server: McpSdkServerConfigWithInstance;
  models: { main: string; detect: string };
  queryFn?: QueryFn;
  claudeExecutable?: string;
  maxTurns?: number;
  /** Transcript JSONL de la session (diagnostic). */
  transcriptPath?: string;
  say?: (s: string) => void;
  abortSignal?: AbortSignal;
}

export interface ConfigAgentResult {
  proposal: AgentProposal;
  turns: number;
  costUsd: number;
  durationMs: number;
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

/**
 * Les agents de configuration ne lisent que le worktree de la branche par défaut (et les dossiers temporaires, où
 * Claude Code range les sorties d'outil trop longues). Le checkout local de l'utilisateur contient des fichiers
 * ignorés avec de vrais secrets (.env…) : ils n'en connaissent que les noms, par list_local_ignored_files.
 */
export function readScopeDecision(toolName: string, input: unknown, cwd: string): string | null {
  if (!READ_TOOLS.has(toolName)) return null;
  const obj = (input ?? {}) as Record<string, unknown>;
  const raw = [obj.file_path, obj.path].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (typeof obj.pattern === "string" && toolName === "Glob" && isAbsolute(obj.pattern)) raw.push(obj.pattern.replace(/[*?[{].*$/, ""));
  const roots = [cwd, tmpdir(), "/tmp", "/private/tmp", join(homedir(), ".claude")].map((r) => realpathLongestPrefix(resolve(r)));
  for (const r of raw) {
    const abs = realpathLongestPrefix(isAbsolute(r) ? resolve(r) : resolve(cwd, r));
    if (!roots.some((root) => abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep))) {
      return `Refusé : ${toolName} sur ${r} est hors du dépôt analysé (${cwd}). Lis uniquement le worktree courant ; pour les fichiers ignorés du checkout local, utilise list_local_ignored_files (noms seulement).`;
    }
  }
  return null;
}

function readScopeHooks(cwd: string): HookCallbackMatcher[] {
  const callback: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const reason = readScopeDecision(input.tool_name, input.tool_input, cwd);
    if (!reason) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  };
  return [{ hooks: [callback], onFailure: "block" }];
}

/** Options SDK de la session (exportées pour les tests). */
export function configAgentOptions(p: ConfigAgentParams, claudePath: string, abortController: AbortController): Options {
  return {
    abortController,
    pathToClaudeCodeExecutable: claudePath,
    mcpServersDelivery: "initialize",
    cwd: p.cwd,
    model: p.models.main,
    effort: "medium",
    settingSources: [],
    strictMcpConfig: true,
    // Lecture seule : pas de Bash ni d'écriture. Agent sert à appeler le sous-agent detect-commands.
    tools: ["Read", "Glob", "Grep", "Agent"],
    agents: { [DETECT_COMMANDS_AGENT]: detectCommandsAgent(p.models.detect) },
    systemPrompt: { type: "preset", preset: "claude_code", append: CONFIG_AGENT_SYSTEM },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks: { PreToolUse: [...(createGuardHooks(p.cwd).PreToolUse ?? []), ...readScopeHooks(p.cwd)] },
    mcpServers: { [INIT_MCP_SERVER_NAME]: p.server },
    outputFormat: { type: "json_schema", schema: toOutputJsonSchema(ConfigProposalSchema) },
    maxTurns: p.maxTurns ?? 60,
    // Une vérification (setup + build + tests) peut durer plusieurs minutes.
    env: { ...sessionEnv(), MCP_TOOL_TIMEOUT: String(3 * 60 * 60 * 1000) },
    extraArgs: { "no-chrome": null },
  };
}

class Transcript {
  private constructor(private readonly handle: FileHandle) {}
  static async open(file: string): Promise<Transcript> {
    await mkdir(dirname(file), { recursive: true });
    return new Transcript(await open(file, "a"));
  }
  async write(entry: unknown): Promise<void> {
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ type: "sprintsaver_unserializable" });
    }
    await this.handle.appendFile(`${line}\n`, "utf8");
  }
  async close(): Promise<void> {
    await this.handle.close();
  }
}

function toolUses(msg: SDKMessage): { name: string; input: Record<string, unknown> }[] {
  if (msg.type !== "assistant") return [];
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: "tool_use"; name: string; input: Record<string, unknown> } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use")
    .map((b) => ({ name: b.name, input: b.input ?? {} }));
}

function lastAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b): b is { type: "text"; text: string } => (b as { type?: unknown })?.type === "text").map((b) => b.text);
  return parts.length ? parts.join("\n") : null;
}

interface RunStats {
  turns: number;
  durationMs: number;
  costUsd: number;
}

/**
 * Une session peut émettre plusieurs messages `result` (par exemple si un sous-agent tourne malgré tout en
 * arrière-plan et relance un tour à sa fin) : le dernier fait foi, les tours et durées s'additionnent, le coût est
 * cumulatif.
 */
async function runOnce(
  queryFn: QueryFn,
  prompt: string,
  options: Options,
  transcript: Transcript | null,
  say: (s: string) => void,
  stats: RunStats,
): Promise<{ result: SDKResultMessage; lastText: string }> {
  let result: SDKResultMessage | null = null;
  let lastText = "";
  for await (const msg of queryFn({ prompt, options })) {
    if (transcript) await transcript.write(msg);
    for (const t of toolUses(msg)) {
      if (t.name === "Agent" || t.name === "Task") say(`  Sous-agent ${String(t.input.subagent_type ?? DETECT_COMMANDS_AGENT)} : versions de toolchain et commandes…`);
    }
    const text = lastAssistantText(msg);
    if (text) lastText = text;
    if (msg.type === "result") {
      result = msg;
      stats.turns += msg.num_turns;
      stats.durationMs += msg.duration_ms;
      stats.costUsd = Math.max(stats.costUsd, msg.total_cost_usd);
    }
  }
  if (!result) throw new Error("session terminée sans résultat");
  if (result.subtype !== "success") {
    throw new Error(`session en erreur (${result.subtype}) : ${result.errors.join("; ") || "sans détail"}`);
  }
  if (result.is_error) throw new Error(`session en erreur : ${result.result || "erreur API sans détail"}`);
  return { result, lastText };
}

function validate(outcome: { result: SDKResultMessage; lastText: string }): { ok: true; data: AgentProposal } | { ok: false; error: string } {
  const r = outcome.result;
  if (r.subtype !== "success") return { ok: false, error: "pas de résultat" };
  const candidate = r.structured_output ?? parseJsonFromText(r.result || outcome.lastText);
  if (candidate === undefined || candidate === null) return { ok: false, error: "Aucune sortie structurée." };
  const parsed = ConfigProposalSchema.safeParse(candidate);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

/** Lance l'agent de configuration ; lève si la session échoue ou si la sortie reste invalide après une relance. */
export async function runConfigAgent(p: ConfigAgentParams): Promise<ConfigAgentResult> {
  const queryFn = (p.queryFn ?? query) as QueryFn;
  const say = p.say ?? (() => {});
  const claudePath = p.claudeExecutable ?? resolveClaudeExecutable();
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  p.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const options = configAgentOptions(p, claudePath, abortController);
  const transcript = p.transcriptPath ? await Transcript.open(p.transcriptPath) : null;
  try {
    const stats: RunStats = { turns: 0, durationMs: 0, costUsd: 0 };
    const first = await runOnce(queryFn, configAgentPrompt(p.projectPath), options, transcript, say, stats);
    let v = validate(first);
    if (!v.ok) {
      const retry = await runOnce(
        queryFn,
        `Ta sortie structurée ne respecte pas le schéma attendu :\n\n${v.error}\n\nNe refais aucune analyse ni vérification. Renvoie uniquement la sortie structurée corrigée, complète et conforme au schéma JSON.`,
        { ...options, resume: first.result.session_id, maxTurns: 5 },
        transcript,
        say,
        stats,
      );
      v = validate(retry);
      if (!v.ok) throw new Error(`sortie de l'agent invalide après relance :\n${v.error}`);
    }
    return { proposal: v.data, ...stats };
  } finally {
    p.abortSignal?.removeEventListener("abort", onAbort);
    await transcript?.close();
  }
}
