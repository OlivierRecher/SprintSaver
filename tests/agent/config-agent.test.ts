import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_AGENT_SYSTEM,
  configAgentModels,
  configAgentPrompt,
  readScopeDecision,
  runConfigAgent,
} from "../../src/agent/config-agent.js";
import { OPUS, SONNET } from "../../src/config/schema.js";
import { makeAgentProposal as agentProposal } from "../helpers/fakes.js";

type Script = (params: { prompt: string; options?: Options }, call: number) => SDKMessage[];

function fakeQuery(script: Script) {
  const seen: { prompt: string; options?: Options }[] = [];
  const queryFn = (params: { prompt: string; options?: Options }) => {
    seen.push(params);
    const msgs = script(params, seen.length);
    return (async function* () {
      for (const m of msgs) yield m;
    })();
  };
  return { queryFn, seen };
}

const result = (over: Record<string, unknown>) =>
  ({ type: "result", subtype: "success", is_error: false, num_turns: 12, duration_ms: 90_000, total_cost_usd: 0.4, session_id: "s1", result: "", ...over }) as unknown as SDKMessage;

const server = { type: "sdk", name: "sprintsaver", instance: {} } as unknown as McpSdkServerConfigWithInstance;
const base = { cwd: "/tmp/wt", projectPath: "team/shop", server, models: { main: SONNET, detect: OPUS }, claudeExecutable: "/bin/claude" };

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("agent de configuration", () => {
  it("session en lecture seule, sous-agent detect-commands, outils MCP sprintsaver, sans clé API ni réglages implicites", async () => {
    const { queryFn, seen } = fakeQuery(() => [result({ structured_output: agentProposal() })]);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-interdit";
    try {
      const res = await runConfigAgent({ ...base, queryFn });
      expect(res.proposal.name).toBe("shop");
      expect(res).toMatchObject({ turns: 12, costUsd: 0.4, durationMs: 90_000 });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
    const o = seen[0]!.options!;
    expect(o.cwd).toBe("/tmp/wt");
    expect(o.model).toBe(SONNET);
    expect(o.tools).toEqual(["Read", "Glob", "Grep", "Agent"]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["sprintsaver"]);
    expect(o.agents?.["detect-commands"]?.model).toBe(OPUS);
    expect(o.agents?.["detect-commands"]?.tools).not.toContain("Bash");
    expect(o.hooks?.PreToolUse).toHaveLength(2);
    expect(o.extraArgs).toEqual({ "no-chrome": null });
    expect(o.outputFormat?.type).toBe("json_schema");
    expect(seen[0]!.prompt).toContain("team/shop");
    expect(seen[0]!.prompt).toContain("detect-commands");
    expect(CONFIG_AGENT_SYSTEM).toMatch(/Aucun outil n'écrit sur GitLab/);
  });

  it("lecture limitée au worktree analysé : le checkout local (et ses secrets) n'est connu que par ses noms de fichiers", () => {
    const wt = "/tmp/ss-scope/wt";
    expect(readScopeDecision("Read", { file_path: "/Users/me/code/shop/.env" }, wt)).toMatch(/hors du dépôt analysé.*list_local_ignored_files/);
    expect(readScopeDecision("Grep", { pattern: "KEY", path: "/Users/me/code/shop" }, wt)).not.toBeNull();
    expect(readScopeDecision("Glob", { pattern: "/Users/me/code/shop/**/.env*" }, wt)).not.toBeNull();
    expect(readScopeDecision("Read", { file_path: "../../../etc/passwd" }, wt)).not.toBeNull();
    expect(readScopeDecision("Read", { file_path: "/tmp/ss-scope/wt/pyproject.toml" }, wt)).toBeNull();
    expect(readScopeDecision("Read", { file_path: "README.md" }, wt)).toBeNull();
    expect(readScopeDecision("Grep", { pattern: "x" }, wt)).toBeNull();
    expect(readScopeDecision("Glob", { pattern: "**/*.toml" }, wt)).toBeNull();
    expect(readScopeDecision("mcp__sprintsaver__get_project_info", {}, wt)).toBeNull();
  });

  it("les modèles se surchargent par config.models.init et config.models['detect-commands']", () => {
    expect(configAgentModels(null)).toEqual({ main: SONNET, detect: OPUS });
    expect(configAgentModels({ models: { init: "m1", "detect-commands": "m2" } })).toEqual({ main: "m1", detect: "m2" });
  });

  it("le prompt demande la délégation des commandes et le mapping des trois rôles de statut", () => {
    const p = configAgentPrompt("g/p");
    for (const needle of ["get_project_info", "find_local_checkout", "analyse_ci", "list_native_statuses", "list_labels", "inProgress", "inReview", "blocked", "typeLabels"]) {
      expect(p).toContain(needle);
    }
  });

  it("sortie invalide : une relance sur la même session, puis succès", async () => {
    const { queryFn, seen } = fakeQuery((_p, call) =>
      call === 1 ? [result({ structured_output: { name: "x" } })] : [result({ structured_output: agentProposal(), num_turns: 1, total_cost_usd: 0.45 })],
    );
    const res = await runConfigAgent({ ...base, queryFn });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.options?.resume).toBe("s1");
    expect(seen[1]!.prompt).toMatch(/ne respecte pas le schéma/);
    expect(res.turns).toBe(13);
    expect(res.costUsd).toBe(0.45);
  });

  it("session en erreur ou sortie toujours invalide : erreur explicite (init se rabat sur la détection simple)", async () => {
    await expect(
      runConfigAgent({ ...base, queryFn: fakeQuery(() => [result({ subtype: "error_max_turns", errors: ["trop de tours"] })]).queryFn }),
    ).rejects.toThrow(/error_max_turns.*trop de tours/);
    await expect(runConfigAgent({ ...base, queryFn: fakeQuery(() => [result({ structured_output: { name: 1 } })]).queryFn })).rejects.toThrow(
      /invalide après relance/,
    );
    await expect(runConfigAgent({ ...base, queryFn: fakeQuery(() => []).queryFn })).rejects.toThrow(/sans résultat/);
  });

  it("plusieurs messages result (sous-agent en arrière-plan) : le dernier fait foi, tours et durées cumulés", async () => {
    const { queryFn } = fakeQuery(() => [
      result({ structured_output: agentProposal({ setupCommand: "", testCommand: "" }), num_turns: 9, duration_ms: 13_000, total_cost_usd: 0.12 }),
      result({ structured_output: agentProposal(), num_turns: 2, duration_ms: 7_000, total_cost_usd: 0.18 }),
    ]);
    const res = await runConfigAgent({ ...base, queryFn });
    expect(res.proposal.setupCommand).toBe("uv venv --python 3.10 .venv");
    expect(res).toMatchObject({ turns: 11, durationMs: 20_000, costUsd: 0.18 });
    expect(configAgentPrompt("g/p")).toMatch(/ne rends jamais de sortie partielle/);
  });

  it("annonce l'appel du sous-agent et écrit un transcript", async () => {
    tmp = await mkdtemp(join(tmpdir(), "ss-cfg-agent-"));
    const transcriptPath = join(tmp, "init", "t.jsonl");
    const said: string[] = [];
    const { queryFn } = fakeQuery(() => [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "detect-commands" } }] } } as unknown as SDKMessage,
      result({ structured_output: agentProposal() }),
    ]);
    await runConfigAgent({ ...base, queryFn, transcriptPath, say: (s) => said.push(s) });
    expect(said.join("\n")).toMatch(/Sous-agent detect-commands/);
    const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
