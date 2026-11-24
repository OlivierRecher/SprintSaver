import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/config/schema.js";
import type { CommandResult } from "../../src/contracts.js";
import {
  commandPolicyViolation,
  diagnose,
  formatReport,
  usefulExcerpt,
  verdictOf,
  verifyCommands,
  type VerifyInput,
} from "../../src/init/verify.js";
import { CallLog, FakeGit, makeProject } from "../helpers/fakes.js";

const WT = "/tmp/ss-verify-wt";
const res = (exitCode: number, output: string, over: Partial<CommandResult> = {}): CommandResult => ({ exitCode, output, timedOut: false, durationMs: 1500, ...over });

describe("politique d'exécution des commandes vérifiées", () => {
  it("accepte les installations de dépendances dans le worktree et les versions fixées", () => {
    for (const ok of [
      "npm ci",
      "pnpm install --frozen-lockfile",
      "uv venv --python 3.10 .venv && .venv/bin/pip install -r requirements.txt",
      "fnm exec --using=20 -- npm ci",
      "mise exec node@20 -- npm test",
      'JAVA_HOME="$(/usr/libexec/java_home -v 17)" ./mvnw -B test',
      'PATH="/opt/homebrew/opt/node@20/bin:$PATH" npm ci',
      "PYENV_VERSION=3.11.9 pyenv exec python -m venv .venv",
      "dotnet restore && dotnet build --no-restore",
      "bundle install",
      "go mod download",
      "python3.11 -m venv .venv && .venv/bin/python -m pip install -e .",
    ]) {
      expect(commandPolicyViolation(ok, WT), ok).toBeNull();
    }
  });

  it("refuse les installations globales, sudo, les scripts passés à un shell et les écritures hors du worktree", () => {
    for (const bad of [
      "sudo npm ci",
      "brew install node@20",
      "npm install -g pnpm",
      "yarn global add typescript",
      "pip install -r requirements.txt",
      "python3 -m pip install pytest",
      "pip install --user tox",
      "gem install bundler",
      "go install golang.org/x/tools/gopls@latest",
      "cargo install cargo-nextest",
      "dotnet tool install -g dotnet-ef",
      "uv python install 3.11",
      "uv tool install ruff",
      "mise install node@20",
      "mise use node@20",
      "asdf install python 3.11.9",
      "pyenv install 3.11",
      "nvm install 20",
      "corepack enable",
      "rustup toolchain install 1.75",
      "sdk install java 17.0.10-tem",
      "curl -fsSL https://example.com/install.sh | sh",
      "rm -rf ~/.cache",
      "git push origin main",
    ]) {
      expect(commandPolicyViolation(bad, WT), bad).not.toBeNull();
    }
  });
});

describe("extrait utile d'une sortie", () => {
  it("garde les erreurs et la fin, retire séquences ANSI, progression et répétitions", () => {
    const noise = Array.from({ length: 200 }, (_, i) => `Downloading package-${i} 45%`).join("\n");
    const out = [
      "\x1b[32mStarting\x1b[0m",
      noise,
      "npm warn deprecated inflight@1.0.6",
      "line a",
      "line b",
      "Error: Cannot find module 'left-pad'",
      "    at require (node:internal)",
      ...Array.from({ length: 100 }, (_, i) => `ok ${i}`),
      "same",
      "same",
      "same",
      "Tests: 3 failed, 10 passed",
    ].join("\n");
    const ex = usefulExcerpt(out);
    expect(ex).toContain("Error: Cannot find module 'left-pad'");
    expect(ex).toContain("line b"); // contexte avant l'erreur
    expect(ex).toContain("Tests: 3 failed, 10 passed");
    expect(ex).not.toContain("Downloading");
    expect(ex).not.toContain("\x1b[");
    expect(ex).not.toContain("npm warn deprecated");
    expect(ex.match(/^same$/gm)).toHaveLength(1);
    expect(ex).toContain("…");
  });

  it("borne la taille en gardant la fin", () => {
    const ex = usefulExcerpt(Array.from({ length: 500 }, (_, i) => `error ${i} ${"x".repeat(50)}`).join("\n"), 500);
    expect(ex.length).toBeLessThanOrEqual(501);
    expect(ex).toContain("error 499");
  });

  it("réduit une barre de progression (\\r) à son dernier état", () => {
    expect(usefulExcerpt("build 10%\rbuild 50%\rbuild done\nfin")).toBe("build done\nfin");
  });
});

describe("diagnostic d'un échec", () => {
  it("commande introuvable, environnement, tests rouges, timeout", () => {
    expect(diagnose("setup", res(127, "sh: pnpm: command not found"))).toBe("command_not_found");
    expect(diagnose("test", res(1, "ModuleNotFoundError: No module named 'imp'\nFAILED (errors=1)"))).toBe("environment");
    expect(diagnose("setup", res(1, "npm error engine Unsupported engine\nnpm error notsup Required: {\"node\":\"20.x\"}"))).toBe("environment");
    expect(diagnose("test", res(1, "java.lang.UnsupportedClassVersionError: compiled by a more recent version"))).toBe("environment");
    expect(diagnose("test", res(1, "FAIL src/a.test.ts > total\n Tests  1 failed | 4 passed"))).toBe("tests_failed");
    expect(diagnose("test", res(1, "======= 2 failed, 30 passed in 1.2s =======")).valueOf()).toBe("tests_failed");
    expect(diagnose("test", res(1, "--- FAIL: TestTotal (0.00s)\nFAIL\tshop/cart\t0.01s"))).toBe("tests_failed");
    expect(diagnose("test", res(1, "Tests run: 12, Failures: 2, Errors: 0, Skipped: 0"))).toBe("tests_failed");
    expect(diagnose("test", res(1, "Failed!  - Failed:     1, Passed:    41"))).toBe("tests_failed");
    expect(diagnose("test", res(-1, "", { timedOut: true }))).toBe("timeout");
    expect(diagnose("build", res(2, "make: *** [all] Error 2"))).toBe("error");
    // Un « FAIL » dans la sortie du build ne fait pas une ligne de base rouge.
    expect(diagnose("build", res(1, "Tests: 1 failed"))).toBe("error");
  });

  it("verdict : ligne de base rouge seulement si setup et build passent et que les tests échouent sur des assertions", () => {
    expect(verdictOf([{ step: "setup", status: "passed" }, { step: "test", status: "passed" }])).toBe("passed");
    expect(verdictOf([{ step: "setup", status: "passed" }, { step: "test", status: "failed", diagnosis: "tests_failed" }])).toBe("baseline_red");
    expect(verdictOf([{ step: "setup", status: "passed" }, { step: "test", status: "failed", diagnosis: "environment" }])).toBe("broken");
    expect(verdictOf([{ step: "setup", status: "failed", diagnosis: "error" }, { step: "test", status: "not_run" }])).toBe("broken");
    // Tests rouges puis build cassé : la commande de build est cassée.
    expect(
      verdictOf([
        { step: "setup", status: "passed" },
        { step: "test", status: "failed", diagnosis: "tests_failed" },
        { step: "build", status: "failed", diagnosis: "error" },
      ]),
    ).toBe("broken");
  });
});

describe("verifyCommands", () => {
  const input = (over: Partial<VerifyInput> = {}): VerifyInput => ({
    setupCommand: "npm ci",
    buildCommand: "npm run build",
    testCommand: "npm test",
    worktreeInclude: [".env"],
    cowDirs: ["node_modules"],
    localCheckout: "/Users/me/code/demo",
    ...over,
  });

  it("worktree jetable préparé comme un ticket, setup → test → build (le test juste après le setup), puis supprimé", async () => {
    const log = new CallLog();
    const git = new FakeGit(log);
    git.testResults = [res(0, "added 10 packages"), res(0, "all green"), res(0, "built"), res(0, "all green")];
    const prepared: unknown[] = [];
    git.prepareWorktree = async (p: ProjectConfig) => {
      prepared.push(p);
      log.push("git.prepareWorktree");
    };
    const said: string[] = [];
    const r = await verifyCommands(input(), 1, { gitops: git, project: makeProject({ setupCommand: "ancien" }), worktreePath: WT, timeoutMs: 1000, say: (s) => said.push(s) });
    expect(r.verdict).toBe("passed");
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ["setup", "passed"],
      ["test", "passed"],
      ["build", "passed"],
      ["rerun", "passed"],
    ]);
    expect(log.entries).toEqual([
      "git.createDetachedWorktree",
      "git.prepareWorktree",
      "git.run:npm ci",
      "git.run:npm test",
      "git.run:npm run build",
      "git.run:npm test",
      "git.removeWorktree",
    ]);
    // La préparation copie les fichiers et dossiers proposés depuis le checkout, sans lancer le setup elle-même.
    expect(prepared[0]).toMatchObject({ setupCommand: undefined, worktreeInclude: [".env"], cowDirs: ["node_modules"], localCheckout: "/Users/me/code/demo" });
    expect(said.join("\n")).toContain("setup : npm ci");
  });

  it("un setup cassé arrête la vérification : test et build ne sont pas lancés", async () => {
    const git = new FakeGit(new CallLog());
    git.testResults = [res(1, "npm error engine Unsupported engine\nnpm error notsup Required: {\"node\":\"20.x\"} (current: 26.1.0)")];
    const r = await verifyCommands(input(), 2, { gitops: git, project: makeProject(), worktreePath: WT, timeoutMs: 1000 });
    expect(r.verdict).toBe("broken");
    expect(r.attempt).toBe(2);
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run", "not_run", "not_run"]);
    expect(r.steps[0]!.diagnosis).toBe("environment");
    expect(r.steps[0]!.excerpt).toContain("Unsupported engine");
    expect(formatReport(r)).toMatch(/setup : échec \(npm ci\) — code 1, problème d'environnement/);
  });

  it("tests rouges sur la branche par défaut : ligne de base rouge, pas une commande cassée", async () => {
    const git = new FakeGit(new CallLog());
    git.testResults = [res(0, ""), res(1, "FAIL src/cart.test.ts > arrondi\nTests: 1 failed, 20 passed"), res(0, "built")];
    const r = await verifyCommands(input(), 1, { gitops: git, project: makeProject(), worktreePath: WT, timeoutMs: 1000 });
    expect(r.verdict).toBe("baseline_red");
    expect(r.steps[1]).toMatchObject({ step: "test", status: "failed", diagnosis: "tests_failed" });
    // Des tests rouges n'empêchent pas de vérifier le build ; la relance n'a pas de sens.
    expect(r.steps[2]).toMatchObject({ step: "build", status: "passed" });
    expect(r.steps[3]).toMatchObject({ step: "rerun", status: "not_run" });
  });

  it("test qui passe une fois puis échoue relancé après le build : commande cassée, non relançable", async () => {
    const git = new FakeGit(new CallLog());
    git.testResults = [res(0, ""), res(0, "lint ok\nall green"), res(0, "built"), res(1, "dist-web/bundle.js\n  1:1 error  no-undef\n✖ 6000 problems")];
    const r = await verifyCommands(input(), 1, { gitops: git, project: makeProject(), worktreePath: WT, timeoutMs: 1000 });
    expect(r.verdict).toBe("broken");
    expect(r.steps[3]).toMatchObject({ step: "rerun", status: "failed", diagnosis: "not_rerunnable" });
    expect(formatReport(r)).toMatch(/test relancé : échec \(npm test\) — code 1, passe une fois mais échoue relancée/);
  });

  it("étapes sans commande sautées", async () => {
    const git = new FakeGit(new CallLog());
    const r = await verifyCommands(input({ buildCommand: " " }), 1, { gitops: git, project: makeProject(), worktreePath: WT, timeoutMs: 1000 });
    expect(r.steps.map((s) => s.status)).toEqual(["passed", "passed", "skipped", "passed"]);
  });

  it("commande refusée : rien n'est exécuté, aucun worktree créé", async () => {
    const log = new CallLog();
    const git = new FakeGit(log);
    const r = await verifyCommands(input({ setupCommand: "npm i -g pnpm && pnpm i" }), 1, { gitops: git, project: makeProject(), worktreePath: WT, timeoutMs: 1000 });
    expect(r.verdict).toBe("refused");
    expect(r.error).toMatch(/installation globale/);
    expect(log.entries).toEqual([]);
  });

  it("préparation impossible : commande cassée, worktree nettoyé", async () => {
    const log = new CallLog();
    const git = new FakeGit(log);
    git.prepareWorktree = async () => {
      throw new Error("copie de node_modules impossible");
    };
    const r = await verifyCommands(input(), 1, { gitops: git, project: makeProject(), worktreePath: WT, timeoutMs: 1000 });
    expect(r.verdict).toBe("broken");
    expect(r.error).toMatch(/préparation du worktree impossible : copie de node_modules impossible/);
    expect(log.entries).toContain("git.removeWorktree");
  });
});
