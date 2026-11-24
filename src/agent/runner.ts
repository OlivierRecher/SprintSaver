/**
 * Runner des sessions agent : un appel `query()` du Claude Agent SDK par phase (ADR § 1, § 2, § 9, § 11).
 *
 * - skills déterministes + contexte du ticket ajoutés au prompt système `claude_code` ;
 * - `settingSources: []`, `strictMcpConfig` : rien d'implicite ne s'ajoute à la session ;
 * - `bypassPermissions` + garde-fou PreToolUse ;
 * - GitLab en lecture seule via MCP in-process ;
 * - Claude in Chrome (`--chrome`) pour les phases de `config.chrome.phases`, `--no-chrome` ailleurs (ADR, amendement 4) ;
 * - sortie structurée (`outputFormat: json_schema`) revalidée par zod, avec une relance sur la même session ;
 * - transcript JSONL optionnel dans `runs/<ticket>/<phase>-<iteration>.jsonl` (ouvert en ajout : une session
 *   reprise après une interruption s'ajoute à la précédente, après une ligne de séparation) ;
 * - processus `claude` lancé dans son propre groupe de processus (`detached`) : le Ctrl+C du terminal ne
 *   l'atteint pas, la phase en cours se termine. Seul l'arrêt immédiat (`abortSignal`) l'interrompt.
 */
import { toOutputJsonSchema } from "./output-schema.js";
import { spawn } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  query,
  type EffortLevel,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AgentRunError, type AgentRunner, type AgentRunRequest, type AgentRunResult, type GitLabApi } from "../contracts.js";
import { chromeFor, modelFor, type AgentPhase, type Config } from "../config/schema.js";
import { paths } from "../config/paths.js";
import { log } from "../log.js";
import { resolveClaudeExecutable } from "./claude-path.js";
import { createGitLabReadServer, GITLAB_MCP_SERVER_NAME } from "./gitlab-tools.js";
import { createGuardHooks } from "./guard-hook.js";
import { buildSkillContext } from "./skills.js";
import { trackProcessGroup } from "../process-groups.js";
import { projectCommandEnv } from "../process-env.js";

/** Signature minimale de `query()` utilisée par le runner (injectable pour les tests). */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface AgentRunnerDeps {
  config: Config;
  gitlab: GitLabApi;
  queryFn?: QueryFn | typeof query;
  skillsRoot?: string;
  /** Chemin du binaire `claude`. Défaut : SPRINTSAVER_CLAUDE_PATH, sinon `claude` du PATH (résolu au premier run). */
  claudeExecutable?: string;
}

/** Tours max accordés à la relance qui ne fait que corriger la sortie structurée. */
const OUTPUT_FIX_MAX_TURNS = 10;

const LIGHT_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>(["mr-writeup", "retro"]);

export function effortFor(phase: AgentPhase): EffortLevel {
  return LIGHT_PHASES.has(phase) ? "medium" : "high";
}

export const SPRINTSAVER_PREAMBLE = `# Contexte d'exécution SprintSaver

Tu es une phase d'un pipeline automatisé (SprintSaver) qui traite un ticket GitLab jusqu'à une merge request prête à relire.
- Aucun humain ne lit cette session et personne ne répondra à tes questions : tranche toi-même, documente tes hypothèses dans ta sortie, et signale dans la sortie ce qui bloque vraiment.
- Travaille uniquement dans le répertoire courant (le worktree du ticket). N'écris jamais ailleurs, sauf dans /tmp.
- Ne pousse jamais, ne fais ni fetch, ni pull, ni rebase, et ne touche pas aux remotes : l'orchestrateur gère le remote.
- Ne commite pas : l'orchestrateur commite lui-même à la fin de la phase. Laisse tes modifications dans l'arbre de travail.
- GitLab n'est accessible qu'en lecture, via les outils MCP \`${GITLAB_MCP_SERVER_NAME}\` (search_issues, get_issue, get_issue_closing_mrs, get_mr_diff). N'utilise ni glab ni l'API HTTP.
- Un garde-fou refuse les commandes interdites : si un appel est refusé, lis la raison et adapte-toi, ne cherche pas à le contourner.
- Termine en produisant la sortie structurée demandée, conforme au schéma JSON fourni. L'orchestrateur ne lit que cette sortie.`;

/**
 * Environnement de la session : celui des commandes du projet (sans les traces du gestionnaire de paquets qui a
 * lancé SprintSaver, voir process-env.ts), sans clé API (auth via le login Claude Code, ADR § 2).
 */
export function sessionEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...projectCommandEnv(base), CLAUDE_AGENT_SDK_CLIENT_APP: "sprintsaver/0.1.0" };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Fonction `spawn` minimale (injectable pour les tests). */
export type SpawnFn = typeof spawn;

/**
 * Lance le CLI `claude` détaché dans son propre groupe de processus (`setsid`) : le SIGINT envoyé par le
 * terminal au groupe de premier plan (Ctrl+C) ne le tue pas, ce qui laisse la phase en cours se terminer.
 * Il s'arrête quand le SDK ferme son stdin (fin de session, abort) ou via le `signal` transmis par le SDK.
 * stderr est drainé (sinon le tube plein bloquerait l'enfant) et sa fin journalisée en cas d'échec.
 */
export function spawnDetachedClaude(opts: SpawnOptions, spawnFn: SpawnFn = spawn): SpawnedProcess {
  const child = spawnFn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4_000);
  });
  // Détaché : sans suivi, il survivrait à la sortie de SprintSaver (SIGHUP, 3e Ctrl+C, sortie forcée).
  const untrack = trackProcessGroup(child.pid);
  child.once("exit", (code, signal) => {
    untrack();
    if (code !== 0 && code !== null) log.debug({ code, signal, stderr: stderrTail }, "processus claude terminé en erreur");
  });
  return child as unknown as SpawnedProcess;
}

export function transcriptFile(ticketKey: string, phase: AgentPhase, iteration: number): string {
  return join(paths.run(ticketKey), `${phase}-${iteration}.jsonl`);
}

/** Extrait un objet JSON d'un texte libre (JSON brut, bloc ```json, ou premier {…} englobant). */
export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // candidat suivant
    }
  }
  return undefined;
}

class Transcript {
  private readonly handle: FileHandle;

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  /** Ouvre en ajout : une session reprise (même phase, même itération) n'écrase pas la précédente. */
  static async open(file: string, header: Record<string, unknown>): Promise<Transcript> {
    await mkdir(dirname(file), { recursive: true });
    const t = new Transcript(await open(file, "a"));
    await t.write({ type: "sprintsaver_session_start", at: new Date().toISOString(), ...header });
    return t;
  }

  async write(entry: unknown): Promise<void> {
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ type: "sprintsaver_unserializable", repr: String(entry) });
    }
    await this.handle.appendFile(line + "\n", "utf8");
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

interface SessionOutcome {
  result: SDKResultMessage;
  /** Dernier texte d'assistant vu (repli si `result` est vide). */
  lastText: string;
}

function assistantText(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text);
  return parts.length ? parts.join("\n") : null;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.constructor.name === "AbortError");
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const queryFn = (deps.queryFn ?? query) as QueryFn;
  const { config } = deps;

  async function runSession(
    phase: AgentPhase,
    prompt: string,
    options: Options,
    transcript: Transcript | null,
  ): Promise<SessionOutcome> {
    let result: SDKResultMessage | null = null;
    let lastText = "";
    const aborted = () => options.abortController?.signal.aborted === true;
    try {
      for await (const msg of queryFn({ prompt, options })) {
        if (transcript) await transcript.write(msg);
        const t = assistantText(msg);
        if (t) lastText = t;
        if (msg.type === "result") result = msg;
        if (aborted()) break;
      }
    } catch (err) {
      if (err instanceof AgentRunError) throw err;
      const reason = aborted() || isAbort(err) ? "aborted" : "execution_error";
      throw new AgentRunError(`Session ${phase} interrompue : ${(err as Error).message ?? String(err)}`, phase, reason);
    }
    // Résultat déjà reçu : on le garde (le moteur s'arrêtera après la phase) ; sinon, session perdue.
    if (!result && aborted()) throw new AgentRunError(`Session ${phase} interrompue par l'arrêt immédiat`, phase, "aborted");
    if (!result) throw new AgentRunError(`Session ${phase} terminée sans message result`, phase, "execution_error");

    if (result.subtype === "error_max_turns") {
      throw new AgentRunError(`Session ${phase} : plafond de tours atteint (${result.num_turns})`, phase, "max_turns");
    }
    if (result.subtype === "error_max_structured_output_retries") {
      throw new AgentRunError(
        `Session ${phase} : le SDK n'a pas obtenu de sortie structurée valide (${result.errors.join("; ")})`,
        phase,
        "invalid_output",
      );
    }
    if (result.subtype !== "success") {
      throw new AgentRunError(
        `Session ${phase} en erreur (${result.subtype}) : ${result.errors.join("; ") || "sans détail"}`,
        phase,
        "execution_error",
      );
    }
    if (result.is_error) {
      throw new AgentRunError(`Session ${phase} en erreur : ${result.result || "erreur API sans détail"}`, phase, "execution_error");
    }
    return { result, lastText };
  }

  async function run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    const browser = chromeFor(config, req.phase);
    const skills = await buildSkillContext({
      phase: req.phase,
      ticketType: req.ticketType,
      typeSkills: req.typeSkills,
      project: req.project,
      worktreePath: req.worktreePath,
      skillsRoot: deps.skillsRoot,
      browser,
    });
    log.debug({ phase: req.phase, ticket: req.ticketKey, skills: skills.loaded }, "skills chargés");

    const append = [SPRINTSAVER_PREAMBLE, skills.text, req.context?.trim() ? `# Contexte du ticket\n\n${req.context.trim()}` : ""]
      .filter((s) => s.length > 0)
      .join("\n\n---\n\n");

    let claudePath: string;
    try {
      claudePath = deps.claudeExecutable ?? resolveClaudeExecutable();
    } catch (err) {
      throw new AgentRunError((err as Error).message, req.phase, "execution_error");
    }

    if (req.abortSignal?.aborted) {
      throw new AgentRunError(`Session ${req.phase} non lancée : arrêt immédiat demandé`, req.phase, "aborted");
    }
    // Relie l'arrêt immédiat (2e Ctrl+C) à la session : le SDK ferme stdin puis tue le processus.
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const model = modelFor(config, req.phase);
    const options: Options = {
      abortController,
      spawnClaudeCodeProcess: (o) => spawnDetachedClaude(o),
      pathToClaudeCodeExecutable: claudePath,
      // Claude Code >= 2.1.261 (2.1.330 attendu, même version que le SDK) : serveurs MCP via l'initialize.
      mcpServersDelivery: "initialize",
      cwd: req.worktreePath,
      model,
      effort: effortFor(req.phase),
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: { type: "preset", preset: "claude_code", append },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: createGuardHooks(req.worktreePath, req.extraWritableRoots),
      mcpServers: { [GITLAB_MCP_SERVER_NAME]: createGitLabReadServer(deps.gitlab, req.project) },
      outputFormat: { type: "json_schema", schema: toOutputJsonSchema(req.outputSchema) },
      maxTurns: config.limits.maxTurnsPerSession,
      env: sessionEnv(),
      // Explicite dans les deux sens : un réglage personnel de Claude Code ne doit pas l'activer en douce.
      extraArgs: browser ? { chrome: null } : { "no-chrome": null },
    };

    const transcriptPath = config.transcripts.enabled ? transcriptFile(req.ticketKey, req.phase, req.iteration) : undefined;
    let transcript: Transcript | null = null;
    try {
      transcript = transcriptPath ? await Transcript.open(transcriptPath, { phase: req.phase, iteration: req.iteration }) : null;
    } catch (err) {
      req.abortSignal?.removeEventListener("abort", onAbort);
      throw err;
    }

    let numTurns = 0;
    let durationMs = 0;
    let costUsd: number | undefined;
    const account = (r: SDKResultMessage): void => {
      numTurns += r.num_turns;
      durationMs += r.duration_ms;
      // total_cost_usd est cumulatif sur une session reprise : on garde la dernière valeur.
      costUsd = Math.max(costUsd ?? 0, r.total_cost_usd);
    };

    try {
      const first = await runSession(req.phase, req.prompt, options, transcript);
      account(first.result);
      let parsed = validate(req.outputSchema, first);

      if (!parsed.success) {
        log.warn({ phase: req.phase, ticket: req.ticketKey, errors: parsed.error }, "sortie structurée invalide, relance sur la même session");
        const retryPrompt =
          "Ta sortie structurée ne respecte pas le schéma attendu. Erreurs de validation :\n\n" +
          parsed.error +
          "\n\nNe refais aucun travail sur le code. Renvoie uniquement la sortie structurée corrigée, complète et conforme au schéma JSON.";
        if (transcript) await transcript.write({ type: "sprintsaver_output_retry", errors: parsed.error });
        const second = await runSession(
          req.phase,
          retryPrompt,
          { ...options, resume: first.result.session_id, maxTurns: Math.min(OUTPUT_FIX_MAX_TURNS, options.maxTurns ?? OUTPUT_FIX_MAX_TURNS) },
          transcript,
        );
        account(second.result);
        parsed = validate(req.outputSchema, second);
        if (!parsed.success) {
          throw new AgentRunError(`Session ${req.phase} : sortie structurée invalide après relance :\n${parsed.error}`, req.phase, "invalid_output");
        }
      }

      log.info(
        { phase: req.phase, ticket: req.ticketKey, iteration: req.iteration, model, turns: numTurns, durationMs, costUsd },
        `agent ${req.phase}#${req.iteration} : ${numTurns} tours, ${(durationMs / 1000).toFixed(0)} s, coût estimé ~$${(costUsd ?? 0).toFixed(2)}`,
      );

      return {
        output: parsed.data,
        numTurns,
        durationMs,
        costUsd,
        transcriptPath,
        skillsLoaded: skills.loaded,
      };
    } finally {
      req.abortSignal?.removeEventListener("abort", onAbort);
      await transcript?.close();
    }
  }

  return { run };
}

type Validation<T> = { success: true; data: T } | { success: false; error: string };

function validate<T>(schema: z.ZodType<T>, outcome: SessionOutcome): Validation<T> {
  const { result, lastText } = outcome;
  if (result.subtype !== "success") return { success: false, error: "pas de résultat" };
  const candidate =
    result.structured_output !== undefined && result.structured_output !== null
      ? result.structured_output
      : parseJsonFromText(result.result || lastText);
  if (candidate === undefined) {
    return { success: false, error: "Aucune sortie structurée ni JSON trouvé dans la réponse finale." };
  }
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { success: true, data: parsed.data };
  return { success: false, error: z.prettifyError(parsed.error) };
}
