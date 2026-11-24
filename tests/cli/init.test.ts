import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { AgentProposal } from "../../src/agent/config-agent.js";
import { ConfigSchema, ProjectConfigSchema, type ProjectConfig } from "../../src/config/schema.js";
import {
  DEFAULT_STATUS_LABELS,
  normalizeProjectArg,
  runInit,
  typeLabelEditChoices,
  type InitDeps,
  type Prompter,
  ensureGlabConnection,
  statusChoices,
  typeLabelChoices,
  reservedProjectNames,
  resolveHumanUser,
  suggestProjectName,
  validateProjectName,
} from "../../src/cli/init.js";
import { createGitLabRest } from "../../src/gitlab/rest.js";
import { fakeFetch, type FakeRoute } from "../helpers/fake-fetch.js";
import { CallLog, FakeGit, makeAgentProposal, makeProject } from "../helpers/fakes.js";
import { GlabAuthError, type ExecFn } from "../../src/gitlab/glab-auth.js";

function prior(id: number, name: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    name,
    id,
    path: `grp/${name}`,
    httpUrl: `https://gitlab.example.com/grp/${name}.git`,
    status: { mode: "labels", inProgress: "a", inReview: "b", blocked: "c" },
  });
}

describe("noms de projets (init)", () => {
  const priorById = new Map([
    [1, prior(1, "api")],
    [2, prior(2, "front")],
  ]);

  it("réserve les noms des projets existants re-sélectionnés (pas ceux désélectionnés)", () => {
    expect([...reservedProjectNames([3, 1], priorById)]).toEqual(["api"]);
    expect([...reservedProjectNames([1, 2], priorById)].sort()).toEqual(["api", "front"]);
  });

  it("un nouveau projet traité avant un projet existant ne peut pas prendre son nom", () => {
    const used = reservedProjectNames([3, 1], priorById);
    // projet 3 (nouveau, path grp/api) configuré en premier
    expect(suggestProjectName("api", used)).toBe("api-2");
    expect(validateProjectName("api", used)).toMatch(/déjà utilisé/);
    expect(validateProjectName("api-2", used)).toBe(true);
    // le projet existant garde son propre nom
    expect(validateProjectName("api", used, "api")).toBe(true);
    expect(suggestProjectName("api", used, "api")).toBe("api");
  });

  it("refuse les caractères invalides", () => {
    expect(validateProjectName("-x", new Set())).toMatch(/Lettres/);
  });
});

describe("jeton de projet dans init (ADR, amendement 1)", () => {
  it("resolveHumanUser redemande tant que le username est introuvable, puis renvoie l'humain", async () => {
    const ff = fakeFetch([
      {
        path: "/users",
        respond: (req) =>
          req.query.get("username") === "olivier" ? { json: [{ id: 5, username: "olivier", name: "Olivier" }] } : { json: [] },
      },
    ]);
    const rest = createGitLabRest("https://gitlab.example.com", "glpat-bot", { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 });
    const answers = ["olivir", "@olivier"];
    const defaults: (string | undefined)[] = [];
    const said: string[] = [];
    const user = await resolveHumanUser(
      rest,
      async (def) => {
        defaults.push(def);
        return answers.shift()!;
      },
      "ancien",
      (s) => said.push(s),
    );
    expect(user).toEqual({ id: 5, username: "olivier", name: "Olivier", email: undefined });
    expect(defaults).toEqual(["ancien", undefined]);
    expect(said.join("\n")).toMatch(/« olivir » introuvable/);
  });

});

describe("resolveHumanUser : recherche d'utilisateurs refusée", () => {
  it("demande l'id directement au lieu d'échouer", async () => {
    const ff = fakeFetch([{ path: "/users", respond: { status: 404, json: {} } }]);
    const rest = createGitLabRest("https://gitlab.example.com", "t", { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 });
    const said: string[] = [];
    const user = await resolveHumanUser(rest, async () => "@olivier.recher", undefined, (s) => said.push(s), async (u) => {
      expect(u).toBe("olivier.recher");
      return 1234;
    });
    expect(user).toEqual({ id: 1234, username: "olivier.recher", name: "olivier.recher" });
    expect(said.join("\n")).toMatch(/HTTP 404.*Indique ton id/);
  });
});

describe("connexion glab dans init (ADR, amendement 2)", () => {
  /** Faux glab : `--version` répond si installé ; `auth status` donne un jeton une fois `loggedIn` vrai. */
  function fakeGlab(state: { installed: boolean; loggedIn: boolean }): ExecFn {
    return async (_cmd, args) => {
      if (!state.installed) return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "--version") return { code: 0, stdout: "glab 1.60.0 (2026-10-01)\n", stderr: "" };
      return state.loggedIn
        ? { code: 0, stdout: "", stderr: "gitlab.com\n  ✓ Logged in to gitlab.com as olivier\n  ✓ Token: glpat-from-glab\n" }
        : { code: 1, stdout: "", stderr: "gitlab.com\n  x No token provided\n" };
    };
  }
  const quiet = () => {};

  it("glab absent : erreur explicite qui dit comment l'installer", async () => {
    const err = await ensureGlabConnection("gitlab.com", { exec: fakeGlab({ installed: false, loggedIn: false }), say: quiet }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlabAuthError);
    expect((err as Error).message).toMatch(/brew install glab/);
  });

  it("glab connecté : renvoie le fournisseur sans rien demander", async () => {
    const provider = await ensureGlabConnection("gitlab.com", {
      exec: fakeGlab({ installed: true, loggedIn: true }),
      confirmLogin: async () => {
        throw new Error("ne doit pas demander");
      },
      say: quiet,
    });
    expect(await provider.get()).toBe("glpat-from-glab");
  });

  it("glab non connecté : propose glab auth login, puis relit la connexion", async () => {
    const state = { installed: true, loggedIn: false };
    const logins: string[] = [];
    const provider = await ensureGlabConnection("gitlab.com", {
      exec: fakeGlab(state),
      confirmLogin: async () => true,
      login: async (host) => {
        logins.push(host);
        state.loggedIn = true;
        return true;
      },
      say: quiet,
    });
    expect(logins).toEqual(["gitlab.com"]);
    expect(await provider.get()).toBe("glpat-from-glab");
  });

  it("glab non connecté et connexion refusée : erreur qui indique la commande à lancer", async () => {
    const err = await ensureGlabConnection("gitlab.example.com", {
      exec: fakeGlab({ installed: true, loggedIn: false }),
      confirmLogin: async () => false,
      say: quiet,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/glab auth login --hostname gitlab\.example\.com/);
  });
});

describe("statuts et labels proposés par init", () => {
  const natives = [
    { id: "gid://s/1", name: "To do" },
    { id: "gid://s/2", name: "In progress" },
    { id: "gid://s/3", name: "Done" },
  ];

  it("cas réel : seul « en cours » a un statut natif → natif pour en cours, création de label proposée pour les autres", () => {
    const inProgress = statusChoices("inProgress", natives, [], undefined);
    expect(inProgress.defaultValue).toBe("native:gid://s/2");
    const inReview = statusChoices("inReview", natives, [], undefined);
    expect(inReview.defaultValue).toBe(`create:${DEFAULT_STATUS_LABELS.inReview.name}`);
    const blocked = statusChoices("blocked", natives, [], undefined);
    expect(blocked.defaultValue).toBe(`create:${DEFAULT_STATUS_LABELS.blocked.name}`);
    // Chaque rôle propose les trois sortes de cible, plus un nom libre.
    expect(blocked.choices.map((c) => c.name)).toEqual([
      "Statut natif : To do",
      "Statut natif : In progress",
      "Statut natif : Done",
      "Créer le label « sprintsaver::bloque »",
      "Créer un autre label…",
    ]);
  });

  it("un label existant qui ressemble au rôle est choisi par défaut, et la création n'est plus proposée s'il existe", () => {
    const c = statusChoices("blocked", [], ["Blocked", "sprintsaver::bloque"], undefined);
    expect(c.defaultValue).toBe("label:Blocked");
    expect(c.choices.some((x) => x.choice.kind === "create")).toBe(false);
  });

  it("la cible actuelle est reprise ; un ancien label disparu est proposé à la recréation", () => {
    expect(statusChoices("inReview", natives, ["review"], { kind: "label", name: "review" }).defaultValue).toBe("label:review");
    const gone = statusChoices("inReview", natives, [], { kind: "label", name: "ancien::review" });
    expect(gone.defaultValue).toBe("create:ancien::review");
    expect(gone.choices[0]?.name).toBe("Créer le label « ancien::review »");
  });

  it("labels de type : création cochée d'office quand aucun label ne correspond", () => {
    expect(typeLabelChoices("bug", [], undefined)).toEqual([{ name: "Créer le label « bug »", value: "\u0000create:bug", checked: true }]);
    const withGuess = typeLabelChoices("bug", ["defect", "doc"], undefined);
    expect(withGuess.filter((c) => c.checked).map((c) => c.value)).toEqual(["defect"]);
    expect(withGuess.at(-1)).toEqual({ name: "Créer le label « bug »", value: "\u0000create:bug", checked: false });
    expect(typeLabelChoices("feature", ["feature"], undefined)).toEqual([{ name: "feature", value: "feature", checked: true }]);
  });
});

// ---------------------------------------------------------------------------
// runInit : agent de configuration, validation, --yes, --dry-run (ADR, amendement 5)
// ---------------------------------------------------------------------------

describe("runInit avec l'agent de configuration", () => {
  const saved = process.env.SPRINTSAVER_HOME;
  let home: string;
  let roots: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ss-init-"));
    roots = join(home, "checkouts");
    await mkdir(roots, { recursive: true });
    process.env.SPRINTSAVER_HOME = join(home, "ss");
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.SPRINTSAVER_HOME;
    else process.env.SPRINTSAVER_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  const shop = { id: 7, name: "shop", path_with_namespace: "team/shop", http_url_to_repo: "https://gitlab.example.com/team/shop.git", web_url: "https://gitlab.example.com/team/shop", default_branch: "main" };
  const api = { ...shop, id: 9, name: "api", path_with_namespace: "team/api", http_url_to_repo: "https://gitlab.example.com/team/api.git", web_url: "https://gitlab.example.com/team/api" };

  function gitlab(over: FakeRoute[] = []) {
    return fakeFetch([
      ...over,
      { path: "/version", respond: { json: { version: "18.0.0" } } },
      { path: "/user", respond: { json: { id: 42, username: "olivier", name: "Olivier", commit_email: "olivier@example.com" } } },
      { path: "/projects", respond: { json: [shop, api] } },
      { path: "/projects/team/shop", respond: { json: shop } },
      { path: "/projects/7", respond: { json: shop } },
      { path: "/projects/9", respond: { json: api } },
      { path: "/projects/7/labels", respond: { json: [{ name: "bug", color: "#f00" }, { name: "feature", color: "#00f" }] } },
      { method: "POST", path: "/projects/7/labels", respond: { status: 201, json: {} } },
      { path: "/projects/7/ci/lint", respond: { json: { valid: true, merged_yaml: "test:\n  image: python:3.10\n  script: [make test]\n" } } },
      { path: "/projects/7/repository/tree", respond: { json: [{ name: "package.json", type: "blob" }, { name: "package-lock.json", type: "blob" }] } },
      { path: "/projects/7/repository/files/package.json/raw", respond: { text: JSON.stringify({ scripts: { test: "vitest run" } }) } },
      {
        method: "POST",
        path: "/api/graphql",
        respond: { json: { data: { project: { workItemTypes: { nodes: [{ name: "Issue", widgetDefinitions: [{ allowedStatuses: [{ id: "gid://s/2", name: "In progress" }] }] }] } } } } },
      },
    ]);
  }

  const glab: ExecFn = async (_cmd, args) =>
    args[0] === "--version" ? { code: 0, stdout: "glab 1.60.0\n", stderr: "" } : { code: 0, stdout: "", stderr: "  ✓ Token: glpat-test-token\n" };

  /** Session simulée : appelle verify_commands comme le ferait le sous-agent, puis rend la proposition. */
  function agentSession(proposal: AgentProposal, verifyArgs?: Record<string, unknown>) {
    const sessions: { options?: Options }[] = [];
    const queryFn = (params: { prompt: string; options?: Options }) => {
      sessions.push(params);
      return (async function* () {
        if (verifyArgs) {
          // API interne du serveur MCP du SDK : le test joue le rôle du modèle qui appelle l'outil.
          const instance = (params.options!.mcpServers!.sprintsaver as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance;
          await instance._registeredTools.verify_commands!.handler(verifyArgs, {});
        }
        yield { type: "result", subtype: "success", is_error: false, num_turns: 20, duration_ms: 120_000, total_cost_usd: 0.6, session_id: "s", result: "", structured_output: proposal } as unknown as SDKMessage;
      })();
    };
    return { queryFn, sessions };
  }

  const verifyArgs = {
    setup_command: "uv venv --python 3.10 .venv",
    build_command: "",
    test_command: ".venv/bin/python -m unittest discover -s tests",
    worktree_include: [],
    cow_dirs: [],
    local_checkout: "",
  };

  function deps(over: Partial<InitDeps> = {}): { deps: InitDeps; said: string[]; git: FakeGit; log: CallLog } {
    const said: string[] = [];
    const log = new CallLog();
    const git = new FakeGit(log);
    return {
      said,
      git,
      log,
      deps: {
        say: (s) => said.push(s),
        glabExec: glab,
        makeGitOps: () => git,
        claudeExecutable: "/bin/claude",
        checkoutRoots: [roots],
        gitGlobal: async () => undefined,
        ...over,
      },
    };
  }

  /** Répond la valeur par défaut, sauf réponses scriptées (par fragment du message, consommées dans l'ordre). */
  function scripted(answers: [string, unknown][]) {
    const asked: string[] = [];
    const take = (message: string): { hit: boolean; value?: unknown } => {
      asked.push(message);
      const i = answers.findIndex(([frag]) => message.includes(frag));
      if (i === -1) return { hit: false };
      const [, value] = answers.splice(i, 1)[0]!;
      return { hit: true, value };
    };
    const prompter: Prompter = {
      input: async (o) => {
        const a = take(o.message);
        return a.hit ? String(a.value) : (o.default ?? "");
      },
      confirm: async (o) => {
        const a = take(o.message);
        return a.hit ? Boolean(a.value) : (o.default ?? false);
      },
      select: async <T,>(o: { message: string; choices: { name: string; value: T }[]; default?: T }) => {
        const a = take(o.message);
        return (a.hit ? a.value : (o.default ?? o.choices[0]!.value)) as T;
      },
      checkbox: async <T,>(o: { message: string; choices: { name: string; value: T; checked?: boolean }[] }) => {
        const a = take(o.message);
        return (a.hit ? a.value : o.choices.filter((c) => c.checked).map((c) => c.value)) as T[];
      },
    };
    return { prompter, asked, answers };
  }

  it("--yes --dry-run : propose, vérifie pour de vrai, n'écrit ni sur GitLab ni dans la config", async () => {
    const ff = gitlab();
    const session = agentSession(makeAgentProposal(), verifyArgs);
    const d = deps({ fetch: ff.fetch, queryFn: session.queryFn });
    d.git.testResults = [
      { exitCode: 0, output: "Creating virtual environment at: .venv", timedOut: false, durationMs: 900 },
      { exitCode: 0, output: "Ran 3 tests\nOK", timedOut: false, durationMs: 400 },
      { exitCode: 0, output: "Ran 3 tests\nOK", timedOut: false, durationMs: 400 },
    ];
    const output = join(home, "out.yaml");
    const configPath = join(home, "ss", "config.yaml");
    await runInit({ yes: true, dryRun: true, projects: ["https://gitlab.example.com/team/shop"], output, configPath }, d.deps);

    expect(ff.calls.filter((c) => c.method === "POST" && c.path !== "/api/graphql")).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
    const written = ConfigSchema.parse(YAML.parse(await readFile(output, "utf8")));
    expect(written.gitlab).toEqual({ url: "https://gitlab.example.com", username: "olivier", userId: 42 });
    expect(written.git).toEqual({ authorName: "Olivier", authorEmail: "olivier@example.com" });
    expect(written.projects).toHaveLength(1);
    expect(written.projects[0]).toMatchObject({
      name: "shop",
      setupCommand: "uv venv --python 3.10 .venv",
      testCommand: ".venv/bin/python -m unittest discover -s tests",
      status: { inProgress: { kind: "native", id: "gid://s/2", name: "In progress" } },
      toolchain: [{ tool: "python", required: "3.10" }],
    });
    // Vérification exécutée par l'orchestrateur dans un worktree jetable, retiré ensuite.
    expect(d.log.entries).toEqual([
      "git.ensureReferenceClone",
      "git.createDetachedWorktree",
      "git.createDetachedWorktree",
      "git.prepareWorktree",
      "git.run:uv venv --python 3.10 .venv",
      "git.run:.venv/bin/python -m unittest discover -s tests",
      // Relance du test dans le même worktree, comme dans la boucle test/fix.
      "git.run:.venv/bin/python -m unittest discover -s tests",
      "git.removeWorktree",
      "git.removeWorktree",
    ]);
    const text = d.said.join("\n");
    expect(text).toContain("Mode --dry-run");
    expect(text).toContain("Vérification réelle  : commandes vérifiées : setup, tests, build et relance des tests passent (tentative 1).");
    expect(text).toContain("Labels qui seraient créés sur team/shop : sprintsaver::en-review, sprintsaver::bloque, auto::ready.");
    expect(text).toContain("--dry-run : config de SprintSaver inchangée");
    expect(session.sessions[0]!.options!.cwd).toBe(join(home, "ss", "worktrees", "init-7"));
  });

  it("--dry-run sans --output : la config est affichée, rien n'est écrit", async () => {
    const d = deps({ fetch: gitlab().fetch, queryFn: agentSession(makeAgentProposal()).queryFn });
    const configPath = join(home, "ss", "config.yaml");
    await runInit({ yes: true, dryRun: true, url: "https://gitlab.example.com", projects: ["team/shop"], configPath }, d.deps);
    expect(existsSync(configPath)).toBe(false);
    const text = d.said.join("\n");
    expect(text).toContain("── Config produite (non écrite) ──");
    expect(text).toContain("testCommand: .venv/bin/python -m unittest discover -s tests");
    expect(text).toContain("Commandes non vérifiées : acceptées (--yes)");
  });

  it("--yes : crée les labels manquants après coup, écrit la config, garde les autres projets suivis", async () => {
    const ff = gitlab();
    const d = deps({ fetch: ff.fetch, queryFn: agentSession(makeAgentProposal(), verifyArgs).queryFn });
    const configPath = join(home, "ss", "config.yaml");
    const other = makeProject({ name: "api", id: 9, path: "team/api", httpUrl: "https://gitlab.example.com/team/api.git" });
    await mkdir(join(home, "ss"), { recursive: true });
    await writeFile(
      configPath,
      YAML.stringify(ConfigSchema.parse({ gitlab: { url: "https://gitlab.example.com", username: "olivier", userId: 42 }, git: { authorName: "O. R.", authorEmail: "or@example.com" }, projects: [other] })),
    );
    await runInit({ yes: true, projects: ["team/shop"], configPath }, d.deps);

    const posts = ff.calls.filter((c) => c.method === "POST" && c.path === "/projects/7/labels").map((c) => (c.body as { name: string }).name);
    expect(posts).toEqual(["sprintsaver::en-review", "sprintsaver::bloque", "auto::ready"]);
    const cfg = ConfigSchema.parse(YAML.parse(await readFile(configPath, "utf8")));
    expect(cfg.projects.map((p) => p.name)).toEqual(["api", "shop"]);
    expect(cfg.projects[0]).toEqual(other);
    expect(cfg.git).toEqual({ authorName: "O. R.", authorEmail: "or@example.com" });
  });

  it("agent en échec : repli sur la détection simple, sans question en --yes", async () => {
    const d = deps({
      fetch: gitlab().fetch,
      queryFn: () => {
        throw new Error("claude introuvable");
      },
    });
    const output = join(home, "out.yaml");
    await runInit({ yes: true, dryRun: true, url: "https://gitlab.example.com", projects: ["team/shop"], output }, d.deps);
    const cfg = ConfigSchema.parse(YAML.parse(await readFile(output, "utf8")));
    expect(cfg.projects[0]).toMatchObject({ name: "shop", setupCommand: "npm ci", testCommand: "npm test", cowDirs: ["node_modules"] });
    expect(d.said.join("\n")).toMatch(/Agent de configuration impossible \(claude introuvable\) : proposition par détection simple/);
  });

  it("interactif : la proposition s'affiche, un champ se modifie, puis validation et écriture", async () => {
    const ff = gitlab();
    const d = deps({ fetch: ff.fetch, queryFn: agentSession(makeAgentProposal(), verifyArgs).queryFn });
    const s = scripted([
      ["Config de team/shop", "edit"],
      ["Champ à modifier", "testCommand"],
      ["Commande de test", ".venv/bin/python -m unittest -v"],
      ["Config de team/shop", "accept"],
    ]);
    const configPath = join(home, "ss", "config.yaml");
    await runInit({ projects: ["team/shop"], configPath }, { ...d.deps, prompter: s.prompter });
    expect(s.answers).toEqual([]);
    const cfg = ConfigSchema.parse(YAML.parse(await readFile(configPath, "utf8")));
    expect(cfg.projects[0]!.testCommand).toBe(".venv/bin/python -m unittest -v");
    const text = d.said.join("\n");
    expect(text).toContain("Les commandes ont changé");
    expect(text).toContain("les commandes ont changé depuis la dernière vérification");
    // Labels créés seulement après validation (et l'identité git demandée).
    expect(ff.calls.filter((c) => c.method === "POST" && c.path === "/projects/7/labels")).toHaveLength(3);
    expect(s.asked.indexOf("Email de l'auteur des commits")).toBeGreaterThan(s.asked.lastIndexOf("Config de team/shop"));
  });

  it("interactif : « Tout annuler » n'écrit rien, ni labels ni config", async () => {
    const ff = gitlab();
    const d = deps({ fetch: ff.fetch, queryFn: agentSession(makeAgentProposal()).queryFn });
    const s = scripted([["Config de team/shop", "abort"]]);
    const configPath = join(home, "ss", "config.yaml");
    await runInit({ projects: ["team/shop"], configPath }, { ...d.deps, prompter: s.prompter });
    expect(existsSync(configPath)).toBe(false);
    expect(ff.calls.filter((c) => c.method === "POST" && c.path !== "/api/graphql")).toEqual([]);
    expect(d.said.join("\n")).toContain("Init annulé : rien n'a été écrit");
  });

  it("interactif sans agent (--no-agent) : questions champ par champ puis validation", async () => {
    let called = false;
    const d = deps({
      fetch: gitlab().fetch,
      queryFn: () => {
        called = true;
        throw new Error("ne doit pas être appelé");
      },
    });
    const s = scripted([["Commande de setup", "npm ci --ignore-scripts"]]);
    const configPath = join(home, "ss", "config.yaml");
    await runInit({ projects: ["team/shop"], configPath, agent: false }, { ...d.deps, prompter: s.prompter });
    expect(called).toBe(false);
    for (const q of ["Nom court du projet", "Commande de setup", "Commande de build", "Commande de test", "Mode de test", "Statut « en cours »", "Labels désignant un ticket « bug »"]) {
      expect(s.asked.some((a) => a.startsWith(q))).toBe(true);
    }
    const cfg = ConfigSchema.parse(YAML.parse(await readFile(configPath, "utf8")));
    expect(cfg.projects[0]).toMatchObject({ setupCommand: "npm ci --ignore-scripts", testCommand: "npm test" });
  });

  it("erreurs d'usage : --yes sans projet ni config, --output égal à la config en --dry-run", async () => {
    const d = deps({ fetch: gitlab().fetch });
    await expect(runInit({ yes: true, configPath: join(home, "ss", "config.yaml") }, d.deps)).rejects.toThrow(/--project/);
    const configPath = join(home, "ss", "config.yaml");
    await expect(runInit({ yes: true, dryRun: true, output: configPath, configPath }, d.deps)).rejects.toThrow(/--dry-run n'écrit jamais/);
  });
});

describe("arguments et choix de init", () => {
  it("normalizeProjectArg : chemin, URL de projet ou de page, instance sous un sous-chemin", () => {
    expect(normalizeProjectArg("/team/shop/")).toBe("team/shop");
    expect(normalizeProjectArg("https://gitlab.example.com/team/shop.git")).toBe("team/shop");
    expect(normalizeProjectArg("https://gitlab.example.com/team/sub/shop/-/issues/12")).toBe("team/sub/shop");
    expect(normalizeProjectArg("https://exemple.fr/gitlab/team/shop", "https://exemple.fr/gitlab")).toBe("team/shop");
  });

  it("typeLabelEditChoices : labels retenus cochés, labels à créer listés", () => {
    expect(typeLabelEditChoices("bug", ["defect", "doc"], ["defect", "type::bug"])).toEqual([
      { name: "defect", value: "defect", checked: true },
      { name: "doc", value: "doc", checked: false },
      { name: "Créer le label « type::bug »", value: "\u0000create:type::bug", checked: true },
      { name: "Créer le label « bug »", value: "\u0000create:bug", checked: false },
    ]);
  });
});
