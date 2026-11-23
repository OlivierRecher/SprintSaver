/**
 * Session agent minimale et réelle, pour `sprintsaver doctor` : vérifie que le SDK démarre, que l'auth
 * Claude Code fonctionne sans ANTHROPIC_API_KEY et que la sortie structurée revient.
 */
import { toOutputJsonSchema } from "./output-schema.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SONNET } from "../config/schema.js";
import { resolveClaudeExecutable } from "./claude-path.js";
import { createGuardHooks } from "./guard-hook.js";
import { sessionEnv, type QueryFn } from "./runner.js";

const SmokeOutput = z.object({ files: z.array(z.string()) });

/** Retourne un résumé d'une ligne ; lève si la session échoue ou si la sortie est invalide. */
export async function agentSmokeTest(cwd: string, queryFn: QueryFn = query, claudeExecutable?: string): Promise<string> {
  const started = Date.now();
  const claudePath = claudeExecutable ?? resolveClaudeExecutable();
  let result: { subtype: string; structured_output?: unknown; num_turns: number; total_cost_usd: number; errors?: string[] } | null = null;

  for await (const msg of queryFn({
    prompt: "Liste les fichiers et dossiers à la racine du répertoire courant. Ne modifie rien.",
    options: {
      pathToClaudeCodeExecutable: claudePath,
      mcpServersDelivery: "initialize",
      cwd,
      model: SONNET,
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Test de fonctionnement de SprintSaver : réponds via la sortie structurée." },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: createGuardHooks(cwd),
      outputFormat: { type: "json_schema", schema: toOutputJsonSchema(SmokeOutput) },
      maxTurns: 5,
      env: sessionEnv(),
    },
  })) {
    if (msg.type === "result") result = msg;
  }

  if (!result) throw new Error("Session de test terminée sans message result");
  if (result.subtype !== "success") {
    throw new Error(`Session de test en erreur (${result.subtype}) : ${(result.errors ?? []).join("; ")}`);
  }
  const parsed = SmokeOutput.safeParse(result.structured_output);
  if (!parsed.success) throw new Error(`Sortie structurée invalide : ${z.prettifyError(parsed.error)}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  return `Agent SDK OK (${SONNET}, ${claudePath}) : ${parsed.data.files.length} entrées à la racine, ${result.num_turns} tours, ${seconds} s, coût estimé ~$${result.total_cost_usd.toFixed(3)}`;
}
