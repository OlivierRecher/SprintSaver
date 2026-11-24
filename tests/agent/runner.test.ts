import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentRunError, type GitLabApi } from "../../src/contracts.js";
import { ConfigSchema, OPUS, SONNET, type ProjectConfig } from "../../src/config/schema.js";
import { killTrackedProcessGroups, trackedProcessGroups } from "../../src/process-groups.js";
import { projectCommandEnv } from "../../src/process-env.js";
import { createAgentRunner, parseJsonFromText, sessionEnv, spawnDetachedClaude, type QueryFn, type SpawnFn } from "../../src/agent/runner.js";

const project = { name: "webapp", id: 42, path: "g/webapp" } as ProjectConfig;
const Output = z.object({ files: z.array(z.string()), count: z.number().int() });

let root: string;
let skillsRoot: string;
let wt: string;
let savedHome: string | undefined;
let savedKey: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ss-runner-"));
  skillsRoot = join(root, "skills");
  wt = join(root, "wt");
  for (const phase of ["implement", "mr-writeup"]) {
    await mkdir(join(skillsRoot, "phases", phase), { recursive: true });
    await writeFile(join(skillsRoot, "phases", phase, "SKILL.md"), `---\nname: ${phase}\n---\nSkill ${phase}.`);
  }
  await mkdir(wt, { recursive: true });
  savedHome = process.env.SPRINTSAVER_HOME;
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.SPRINTSAVER_HOME = join(root, "home");
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SPRINTSAVER_HOME;
  else process.env.SPRINTSAVER_HOME = savedHome;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await rm(root, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({ gitlab: { token: "t", username: "u", userId: 1 }, ...overrides });
}

function success(structured: unknown, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    duration_ms: 2000,
    duration_api_ms: 1500,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0.5,
    structured_output: structured,
    session_id: "sess-1",
    ...extra,
  } as unknown as SDKMessage;
}

function errorResult(subtype: string): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    num_turns: 150,
    duration_ms: 1000,
    duration_api_ms: 900,
    stop_reason: null,
    total_cost_usd: 3,
    errors: ["boom"],
    session_id: "sess-1",
  } as unknown as SDKMessage;
}

const assistant = (text: string): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: "sess-1" }) as unknown as SDKMessage;

/** queryFn factice : chaque appel joue le script suivant et enregistre ses paramètres. */
function fakeQuery(scripts: SDKMessage[][]): { fn: QueryFn; calls: { prompt: string; options?: Options }[] } {
  const calls: { prompt: string; options?: Options }[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1] ?? [];
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
  return { fn, calls };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    phase: "implement" as const,
    ticketType: "feature" as const,
    project,
    ticketKey: "webapp-12",
    worktreePath: wt,
    prompt: "Implémente.",
    context: "Ticket #12 : ajouter un bouton.",
    outputSchema: Output,
    iteration: 1,
    ...overrides,
  };
}

const gitlab = {} as GitLabApi;
const CLAUDE = "/opt/test/bin/claude";

describe("createAgentRunner", () => {
  it("renvoie la sortie validée, les métriques et écrit le transcript", async () => {
    const q = fakeQuery([[assistant("Je regarde."), success({ files: ["a"], count: 1 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const res = await runner.run(request());
    expect(res.output).toEqual({ files: ["a"], count: 1 });
    expect(res.numTurns).toBe(4);
    expect(res.durationMs).toBe(2000);
    expect(res.costUsd).toBe(0.5);
    expect(res.skillsLoaded).toEqual(["phases/implement"]);
    expect(res.transcriptPath).toBe(join(root, "home", "runs", "webapp-12", "implement-1.jsonl"));
    const lines = (await readFile(res.transcriptPath as string, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string).type).toBe("sprintsaver_session_start");
    expect(JSON.parse(lines[2] as string).type).toBe("result");
  });

  it("n'écrase pas le transcript d'une session interrompue reprise à la même itération", async () => {
    const q = fakeQuery([[assistant("première session")], [success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    await expect(runner.run(request())).rejects.toMatchObject({ reason: "execution_error" });
    const res = await runner.run(request());
    const content = await readFile(res.transcriptPath as string, "utf8");
    expect(content).toContain("première session");
    expect(content.match(/sprintsaver_session_start/g)).toHaveLength(2);
  });

  it("charge les skills de type demandés (typeSkills)", async () => {
    await mkdir(join(skillsRoot, "phases", "analyse"), { recursive: true });
    await writeFile(join(skillsRoot, "phases", "analyse", "SKILL.md"), "Analyse.");
    for (const t of ["bug", "feature"]) {
      await mkdir(join(skillsRoot, "types", t), { recursive: true });
      await writeFile(join(skillsRoot, "types", t, "SKILL.md"), `Skill ${t}.`);
    }
    const q = fakeQuery([[success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const res = await runner.run(request({ phase: "analyse", typeSkills: ["bug", "feature"] }));
    expect(res.skillsLoaded).toEqual(["phases/analyse", "types/bug", "types/feature"]);
  });

  it("lance claude détaché (hors du groupe du terminal) et relie l'arrêt immédiat à un AbortController", async () => {
    const stop = new AbortController();
    let seen: Options | undefined;
    const q: QueryFn = (params) => {
      seen = params.options;
      const signal = params.options?.abortController?.signal;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield assistant("je travaille");
        stop.abort(); // 2e Ctrl+C pendant la session
        if (signal?.aborted) {
          const e = new Error("Claude Code process aborted by user");
          e.name = "AbortError";
          throw e;
        }
        yield success({ files: [], count: 0 });
      })();
    };
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q, skillsRoot, claudeExecutable: CLAUDE });
    const err = await runner.run(request({ abortSignal: stop.signal })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect((err as AgentRunError).reason).toBe("aborted");
    expect(seen?.abortController?.signal.aborted).toBe(true);
    expect(typeof seen?.spawnClaudeCodeProcess).toBe("function");
  });

  it("arrêt immédiat déjà demandé : aucune session lancée", async () => {
    const stop = new AbortController();
    stop.abort();
    const q = fakeQuery([[success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    await expect(runner.run(request({ abortSignal: stop.signal }))).rejects.toMatchObject({ reason: "aborted" });
    expect(q.calls).toHaveLength(0);
  });

  it("racines modifiables supplémentaires transmises au garde-fou", async () => {
    const q = fakeQuery([[success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const base = `${wt}.avant`;
    await runner.run(request({ extraWritableRoots: [base] }));
    const hook = (q.calls[0]?.options as Options).hooks!.PreToolUse![0]!.hooks[0]!;
    const call = (file_path: string) =>
      hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path } } as never, undefined, { signal: new AbortController().signal });
    expect(await call(`${base}/dist/a.js`)).toEqual({});
    expect(await call("/etc/hosts")).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  });

  it("passe les bonnes options au SDK", async () => {
    const q = fakeQuery([[success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    await runner.run(request());
    const opts = q.calls[0]?.options as Options;
    expect(q.calls[0]?.prompt).toBe("Implémente.");
    expect(opts.cwd).toBe(wt);
    expect(opts.pathToClaudeCodeExecutable).toBe(CLAUDE);
    expect(opts.mcpServersDelivery).toBe("initialize");
    expect(opts.model).toBe(OPUS);
    expect(opts.effort).toBe("high");
    expect(opts.settingSources).toEqual([]);
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.maxTurns).toBe(150);
    expect(opts.hooks?.PreToolUse).toHaveLength(1);
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["gitlab"]);
    expect(opts.outputFormat?.type).toBe("json_schema");
    expect((opts.outputFormat?.schema as { type?: string }).type).toBe("object");
    const sp = opts.systemPrompt as { type: string; preset: string; append: string };
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.append).toContain("pipeline automatisé");
    expect(sp.append).toContain("Skill implement.");
    expect(sp.append).toContain("Ticket #12 : ajouter un bouton.");
    expect(sp.append.indexOf("Skill implement.") < sp.append.indexOf("Ticket #12")).toBe(true);
    expect(opts.resume).toBeUndefined();
  });

  it("Claude in Chrome : --chrome et skill du navigateur pour review, --no-chrome ailleurs ou si désactivé", async () => {
    await mkdir(join(skillsRoot, "phases", "review"), { recursive: true });
    await writeFile(join(skillsRoot, "phases", "review", "SKILL.md"), "Skill review.");
    await mkdir(join(skillsRoot, "tools", "chrome"), { recursive: true });
    await writeFile(join(skillsRoot, "tools", "chrome", "SKILL.md"), "Skill navigateur.");
    const q = fakeQuery([[success({ files: [], count: 0 })], [success({ files: [], count: 0 })], [success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const review = await runner.run(request({ phase: "review" }));
    expect(q.calls[0]?.options?.extraArgs).toEqual({ chrome: null });
    expect(review.skillsLoaded).toEqual(["phases/review", "tools/chrome"]);
    expect((q.calls[0]?.options?.systemPrompt as { append: string }).append).toContain("Skill navigateur.");
    const impl = await runner.run(request());
    expect(q.calls[1]?.options?.extraArgs).toEqual({ "no-chrome": null });
    expect(impl.skillsLoaded).toEqual(["phases/implement"]);
    const off = createAgentRunner({ config: config({ chrome: { enabled: false } }), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    expect((await off.run(request({ phase: "review" }))).skillsLoaded).toEqual(["phases/review"]);
    expect(q.calls[2]?.options?.extraArgs).toEqual({ "no-chrome": null });
  });

  it("n'exporte pas ANTHROPIC_API_KEY dans l'env de la session", async () => {
    const q = fakeQuery([[success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    await runner.run(request());
    const env = q.calls[0]?.options?.env ?? {};
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    // PATH de l'utilisateur, sans les node_modules/.bin ajoutés si vitest tourne sous un script npm.
    expect(env.PATH).toBe(projectCommandEnv().PATH);
    expect("ANTHROPIC_API_KEY" in sessionEnv({ ANTHROPIC_API_KEY: "x", HOME: "/h" })).toBe(false);
    // Même environnement que les commandes du projet : sans les variables d'un script npm.
    const fromNpm = sessionEnv({ HOME: "/h", npm_config_prefix: "/opt/homebrew", npm_lifecycle_event: "dev", INIT_CWD: "/x" });
    expect(fromNpm.npm_config_prefix).toBeUndefined();
    expect(fromNpm.INIT_CWD).toBeUndefined();
    expect(fromNpm.HOME).toBe("/h");
  });

  it("utilise Sonnet et effort medium pour mr-writeup, et respecte la surcharge de modèle", async () => {
    const q = fakeQuery([[success({ files: [], count: 0 })], [success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({ config: config({ models: { implement: "claude-custom" } }), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    await runner.run(request({ phase: "mr-writeup" }));
    await runner.run(request());
    expect(q.calls[0]?.options?.model).toBe(SONNET);
    expect(q.calls[0]?.options?.effort).toBe("medium");
    expect(q.calls[1]?.options?.model).toBe("claude-custom");
  });

  it("n'écrit pas de transcript si désactivé", async () => {
    const q = fakeQuery([[success({ files: [], count: 0 })]]);
    const runner = createAgentRunner({
      config: config({ transcripts: { enabled: false, retentionDays: 30 } }),
      gitlab,
      queryFn: q.fn,
      skillsRoot,
      claudeExecutable: CLAUDE,
    });
    const res = await runner.run(request());
    expect(res.transcriptPath).toBeUndefined();
  });

  it("se rabat sur le JSON du texte final si structured_output est absent", async () => {
    const q = fakeQuery([[success(undefined, { result: 'Voici :\n```json\n{"files":["x"],"count":1}\n```' })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const res = await runner.run(request());
    expect(res.output).toEqual({ files: ["x"], count: 1 });
  });

  it("relance une fois en reprenant la session si la sortie est invalide, puis accepte la correction", async () => {
    const q = fakeQuery([
      [success({ files: "pas un tableau", count: 1.5 })],
      [success({ files: ["ok"], count: 1 }, { num_turns: 1, duration_ms: 300, total_cost_usd: 0.6, session_id: "sess-1" })],
    ]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const res = await runner.run(request());
    expect(res.output).toEqual({ files: ["ok"], count: 1 });
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.options?.resume).toBe("sess-1");
    expect(q.calls[1]?.prompt).toContain("files");
    expect(q.calls[1]?.prompt).toContain("uniquement la sortie structurée");
    expect(res.numTurns).toBe(5);
    expect(res.durationMs).toBe(2300);
    expect(res.costUsd).toBe(0.6);
  });

  it("échoue en invalid_output si la sortie reste invalide après relance", async () => {
    const q = fakeQuery([[success({ nope: 1 })], [success({ still: "bad" })]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    await expect(runner.run(request())).rejects.toMatchObject({ reason: "invalid_output", phase: "implement" });
    expect(q.calls).toHaveLength(2);
  });

  it("échoue en max_turns sur error_max_turns, sans relance", async () => {
    const q = fakeQuery([[errorResult("error_max_turns")]]);
    const runner = createAgentRunner({ config: config(), gitlab, queryFn: q.fn, skillsRoot, claudeExecutable: CLAUDE });
    const err = await runner.run(request()).catch((e: unknown) => e);
    expect(err instanceof AgentRunError).toBe(true);
    expect((err as AgentRunError).reason).toBe("max_turns");
    expect(q.calls).toHaveLength(1);
  });

  it("échoue en execution_error sur une autre erreur ou un flux sans result", async () => {
    const runner1 = createAgentRunner({ config: config(), gitlab, queryFn: fakeQuery([[errorResult("error_during_execution")]]).fn, skillsRoot, claudeExecutable: CLAUDE });
    await expect(runner1.run(request())).rejects.toMatchObject({ reason: "execution_error" });
    const runner2 = createAgentRunner({ config: config(), gitlab, queryFn: fakeQuery([[assistant("…")]]).fn, skillsRoot, claudeExecutable: CLAUDE });
    await expect(runner2.run(request())).rejects.toMatchObject({ reason: "execution_error" });
    const throwing: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        throw new Error("spawn claude ENOENT");
      })();
    const runner3 = createAgentRunner({ config: config(), gitlab, queryFn: throwing, skillsRoot, claudeExecutable: CLAUDE });
    await expect(runner3.run(request())).rejects.toMatchObject({ reason: "execution_error" });
  });
});

describe("spawnDetachedClaude", () => {
  it("passe detached: true et des tubes stdio, sans toucher au signal du SDK", () => {
    const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { stderr: null, once: () => undefined };
    }) as unknown as SpawnFn;
    const signal = new AbortController().signal;
    spawnDetachedClaude({ command: "/bin/claude", args: ["--x"], cwd: "/wt", env: { A: "1" }, signal }, fakeSpawn);
    expect(calls[0]?.command).toBe("/bin/claude");
    expect(calls[0]?.options).toMatchObject({ detached: true, cwd: "/wt", stdio: ["pipe", "pipe", "pipe"], signal });
  });

  it("lance réellement un processus lisible sur stdout", async () => {
    const child = spawnDetachedClaude({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const [code] = await Promise.all([
      new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
      new Promise((r) => child.stdout.on("end", r)),
    ]);
    expect(code).toBe(0);
    expect(out).toBe("ok");
  });

  it.skipIf(process.platform === "win32")("processus détaché suivi : tué avec son groupe si SprintSaver quitte, plus suivi une fois terminé", async () => {
    const child = spawnDetachedClaude({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const pid = (child as unknown as { pid?: number }).pid;
    const exited = new Promise<NodeJS.Signals | null>((r) => child.once("exit", (_c, sig) => r(sig)));
    expect(trackedProcessGroups()).toContain(pid);
    killTrackedProcessGroups("SIGTERM"); // ce que font la sortie forcée et le hook de sortie
    expect(await exited).toBe("SIGTERM");
    expect(trackedProcessGroups()).not.toContain(pid);
  });
});

describe("parseJsonFromText", () => {
  it("lit du JSON brut, un bloc ```json ou un objet entouré de texte", () => {
    expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonFromText('bla\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonFromText('résultat : {"a":3} fin')).toEqual({ a: 3 });
    expect(parseJsonFromText("rien")).toBeUndefined();
  });
});
