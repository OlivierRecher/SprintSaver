import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { detectProjectCommands } from "../../src/agent/detect-commands.js";
import { SONNET } from "../../src/config/schema.js";

function fakeQuery(result: Record<string, unknown>) {
  const seen: { prompt: string; options?: Options }[] = [];
  const queryFn = (params: { prompt: string; options?: Options }) => {
    seen.push(params);
    return (async function* () {
      yield { type: "result", num_turns: 6, total_cost_usd: 0.04, ...result } as unknown as SDKMessage;
    })();
  };
  return { queryFn, seen };
}

const proposal = {
  stack: "TypeScript / Next.js / Vitest",
  setupCommand: " npm ci ",
  buildCommand: "",
  testCommand: "npm test",
  testMode: "local",
  cowDirs: ["node_modules", " "],
  worktreeInclude: [".env"],
  explanation: "package-lock.json et le job test de .gitlab-ci.yml.",
};

describe("detectProjectCommands", () => {
  it("session Sonnet en lecture seule dans le dépôt, sans clé API ni réglages implicites", async () => {
    const { queryFn, seen } = fakeQuery({ subtype: "success", structured_output: proposal });
    const res = await detectProjectCommands("/tmp/repo", { queryFn, claudeExecutable: "/bin/claude" });
    const o = seen[0]!.options!;
    expect(o.cwd).toBe("/tmp/repo");
    expect(o.model).toBe(SONNET);
    expect(o.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(o.settingSources).toEqual([]);
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen[0]!.prompt).toMatch(/\.gitlab-ci\.yml/);
    expect(res).toEqual({
      commands: { ...proposal, setupCommand: "npm ci", cowDirs: ["node_modules"] },
      costUsd: 0.04,
      turns: 6,
    });
  });

  it("échec de session ou sortie invalide : erreur explicite (init se rabat sur la détection simple)", async () => {
    await expect(
      detectProjectCommands("/r", { queryFn: fakeQuery({ subtype: "error_max_turns", errors: ["trop de tours"] }).queryFn, claudeExecutable: "c" }),
    ).rejects.toThrow(/error_max_turns.*trop de tours/);
    await expect(
      detectProjectCommands("/r", { queryFn: fakeQuery({ subtype: "success", structured_output: { stack: "x" } }).queryFn, claudeExecutable: "c" }),
    ).rejects.toThrow(/sortie de l'analyse invalide/);
  });
});
