import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_VERIFY_ATTEMPTS, ciImages, createInitServer, initTools, type InitToolsDeps, type InitToolsState } from "../../src/agent/config-tools.js";
import type { VerificationReport, VerifyInput } from "../../src/init/verify.js";
import { makeProject } from "../helpers/fakes.js";

const info = { id: 7, name: "shop", pathWithNamespace: "team/shop", httpUrl: "https://gitlab.example.com/team/shop.git", webUrl: "https://gitlab.example.com/team/shop", defaultBranch: "main" };

let checkout: string;
beforeAll(async () => {
  checkout = await mkdtemp(join(tmpdir(), "ss-cfg-tools-"));
});
afterAll(async () => {
  await rm(checkout, { recursive: true, force: true });
});

function setup(over: Partial<InitToolsDeps> = {}) {
  const verified: { input: VerifyInput; attempt: number }[] = [];
  const said: string[] = [];
  const deps: InitToolsDeps = {
    info,
    takenNames: ["api"],
    suggestedName: "shop",
    triggerLabel: "auto::ready",
    listLabels: async () => [{ name: "bug", color: "#f00" }, { name: "Doing", color: "#00f" }],
    listStatuses: async () => [{ id: "gid://s/2", name: "In progress" }],
    ciConfig: async () => ({ source: "merged", yaml: "test:\n  image: python:3.10-slim\n  script: [make test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == \"merge_request_event\"\n" }),
    findCheckouts: async () => ({ matches: [checkout], roots: ["/Users/me/code"], scanned: 42, truncated: false }),
    isCheckout: async (d) => d === checkout,
    listIgnored: async () => ({ entries: [".env", "apps/web/.env.local", "certs/"], excluded: 4, truncated: false, examplePairs: [[".env", ".env.example"]] }),
    probe: async (tools) => `sondes : ${tools.join(",")}`,
    versionManagers: async () => "uv (…)",
    verify: async (input, attempt): Promise<VerificationReport> => {
      verified.push({ input, attempt });
      return { attempt, input, verdict: attempt === 1 ? "broken" : "passed", steps: [{ step: "setup", command: input.setupCommand, status: attempt === 1 ? "failed" : "passed", exitCode: attempt === 1 ? 1 : 0, diagnosis: "environment", excerpt: "No module named 'imp'" }], durationMs: 1000 };
    },
    say: (s) => said.push(s),
    ...over,
  };
  const state: InitToolsState = { reports: [], refusedCalls: 0 };
  const tools = initTools(deps, state);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`outil ${name} absent`);
    const res = await t.handler(args as never, {});
    return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
  };
  return { deps, state, tools, call, verified, said };
}

const verifyArgs = (over: Record<string, unknown> = {}) => ({
  setup_command: "uv venv --python 3.10 .venv",
  build_command: "",
  test_command: ".venv/bin/python -m unittest",
  worktree_include: [".env", " "],
  cow_dirs: [],
  local_checkout: "",
  ...over,
});

describe("outils MCP de l'agent de configuration", () => {
  it("expose les outils de lecture et la vérification ; aucun outil n'écrit sur GitLab", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      "get_project_info",
      "list_labels",
      "list_native_statuses",
      "analyse_ci",
      "find_local_checkout",
      "list_local_ignored_files",
      "probe_toolchains",
      "list_version_managers",
      "verify_commands",
    ]);
    for (const t of tools.filter((x) => x.name !== "verify_commands")) expect(t.annotations?.readOnlyHint).toBe(true);
    const server = createInitServer(setup().deps, { reports: [], refusedCalls: 0 });
    expect(server.name).toBe("sprintsaver");
  });

  it("get_project_info : infos, nom proposé, noms pris et config actuelle", async () => {
    const { call } = setup({ prior: makeProject({ name: "shop", testCommand: "make test" }) });
    const { text } = await call("get_project_info");
    expect(text).toContain("Projet : team/shop (id 7)");
    expect(text).toContain("Branche par défaut : main");
    expect(text).toContain("Nom court proposé : shop");
    expect(text).toContain("déjà pris par d'autres projets : api");
    expect(text).toContain("testCommand: make test");
    const none = await setup().call("get_project_info");
    expect(none.text).toContain("Pas de config SprintSaver actuelle");
  });

  it("labels, statuts natifs, CI (images et pipeline de MR), checkout local", async () => {
    const { call, said } = setup();
    expect((await call("list_labels")).text).toBe("bug\nDoing");
    expect((await call("list_native_statuses")).text).toBe("gid://s/2 — In progress");
    const ci = (await call("analyse_ci")).text;
    expect(ci).toContain("config fusionnée");
    expect(ci).toContain("Pipeline à surveiller selon l'heuristique : merge_request");
    expect(ci).toContain("Images : python:3.10-slim");
    const co = (await call("find_local_checkout")).text;
    expect(co).toContain(checkout);
    expect(co).toContain("42 dossiers parcourus");
    expect(said.join("\n")).toMatch(/checkout local/);
  });

  it("pas de CI, pas de statut natif : le dit", async () => {
    const { call } = setup({ ciConfig: async () => ({ source: "none", yaml: "" }), listStatuses: async () => [] });
    expect((await call("analyse_ci")).text).toMatch(/Pas de CI.*branch/);
    expect((await call("list_native_statuses")).text).toMatch(/utilise des labels/);
  });

  it("list_local_ignored_files : noms seulement, exclusions et pendants d'exemples ; refuse un dossier qui n'est pas un checkout du projet", async () => {
    const { call } = setup();
    const res = await call("list_local_ignored_files", { local_checkout: checkout });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("noms seulement, contenu jamais lu");
    expect(res.text).toContain("  apps/web/.env.local");
    expect(res.text).toContain("4 entrées de dépendances, build ou cache écartées");
    expect(res.text).toContain(".env  (exemple versionné : .env.example)");
    const bad = await call("list_local_ignored_files", { local_checkout: "/etc" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("n'est pas un checkout de team/shop");
  });

  it("probe_toolchains et list_version_managers délèguent aux sondes de l'orchestrateur", async () => {
    const { call } = setup();
    expect((await call("probe_toolchains", { tools: ["python3", "uv"] })).text).toBe("sondes : python3,uv");
    // Un nom hors liste n'invalide pas l'appel : les sondes le signalent comme inconnu.
    expect((await call("probe_toolchains", { tools: ["cobol"] })).text).toBe("sondes : cobol");
    expect((await call("list_version_managers")).text).toBe("uv (…)");
  });

  it("verify_commands : exécution par l'orchestrateur, rapport enregistré, plafond de tentatives", async () => {
    const { call, state, verified } = setup();
    const first = await call("verify_commands", verifyArgs());
    expect(first.isError).toBe(false);
    expect(first.text).toContain("Vérification 1 : commande cassée");
    expect(first.text).toContain("No module named 'imp'");
    expect(first.text).toContain("Vérifications restantes : 2.");
    expect(verified[0]!.input).toEqual({
      setupCommand: "uv venv --python 3.10 .venv",
      buildCommand: undefined,
      testCommand: ".venv/bin/python -m unittest",
      worktreeInclude: [".env"],
      cowDirs: [],
    });
    const second = await call("verify_commands", verifyArgs({ local_checkout: checkout }));
    expect(second.text).toContain("Tout passe.");
    expect(verified[1]!.input.localCheckout).toBe(checkout);
    await call("verify_commands", verifyArgs());
    expect(state.reports).toHaveLength(MAX_VERIFY_ATTEMPTS);
    const fourth = await call("verify_commands", verifyArgs());
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toMatch(/Plafond de 3 vérifications/);
    expect(verified).toHaveLength(3);
    expect(state.refusedCalls).toBe(1);
  });

  it("verify_commands refuse un checkout qui n'est pas celui du projet, sans consommer de tentative", async () => {
    const { call, state } = setup();
    const res = await call("verify_commands", verifyArgs({ local_checkout: "/etc" }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("n'est pas un checkout de team/shop");
    expect(state.reports).toHaveLength(0);
  });

  it("une erreur GitLab devient un résultat isError lisible", async () => {
    const { call } = setup({
      listLabels: async () => {
        throw new Error("HTTP 403");
      },
    });
    const res = await call("list_labels");
    expect(res).toEqual({ text: "Erreur (list_labels) : HTTP 403", isError: true });
  });

  it("ciImages : images en ligne et sous la forme name:", () => {
    expect(ciImages("image: node:20\njob:\n  image:\n    name: maven:3.9-eclipse-temurin-17\n    entrypoint: ['']\n  # image: commented\n")).toEqual([
      "node:20",
      "maven:3.9-eclipse-temurin-17",
    ]);
  });
});
