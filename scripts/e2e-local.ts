/**
 * Banc d'essai bout en bout, sans GitLab : vrai moteur, vrai git (dépôt bare local), vraies sessions Claude.
 * Seul GitLab est simulé en mémoire. Sert à mettre au point les skills et les prompts.
 *
 *   npx tsx scripts/e2e-local.ts            # modèles Sonnet partout (moins cher)
 *   npx tsx scripts/e2e-local.ts --opus     # modèles par défaut de la config (Opus)
 *   npx tsx scripts/e2e-local.ts --keep     # garde le dossier temporaire pour inspection
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const root = mkdtempSync(join(tmpdir(), "sprintsaver-e2e-"));
process.env.SPRINTSAVER_HOME = join(root, "home");

// Imports après SPRINTSAVER_HOME pour que les chemins pointent vers le bac à sable.
const { ConfigSchema, AGENT_PHASES, SONNET } = await import("../src/config/schema.js");
const { createGitOps } = await import("../src/git/gitops.js");
const { createAgentRunner } = await import("../src/agent/runner.js");
const { createStateStore } = await import("../src/state/store.js");
const { createRunRecorder } = await import("../src/state/runs.js");
const { createTicketProcessor } = await import("../src/engine/processor.js");
const { FakeGitLab, CallLog, makeIssue } = await import("../tests/helpers/fakes.js");
const { paths } = await import("../src/config/paths.js");

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@example.invalid", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@example.invalid" } });
}

// --- Dépôt cible : un mini projet Node avec un bug de formatage de prix -------------------------
const origin = join(root, "origin.git");
const seed = join(root, "seed");
execFileSync("git", ["init", "--bare", "-b", "main", origin]);
mkdirSync(join(seed, "src"), { recursive: true });
mkdirSync(join(seed, "test"), { recursive: true });
writeFileSync(
  join(seed, "package.json"),
  JSON.stringify({ name: "shop", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
);
writeFileSync(
  join(seed, "src", "price.js"),
  `/** Formate un montant en centimes pour l'affichage. */\nexport function formatPrice(cents) {\n  return \`\${cents / 100} €\`;\n}\n`,
);
writeFileSync(
  join(seed, "test", "price.test.js"),
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { formatPrice } from "../src/price.js";\n\ntest("formate un montant entier", () => {\n  assert.equal(typeof formatPrice(1000), "string");\n});\n`,
);
writeFileSync(join(seed, "CLAUDE.md"), "# shop\n\nTests : `npm test` (node:test). Code en ESM, pas de dépendances.\n");
git(seed, "init", "-b", "main");
git(seed, "add", "-A");
git(seed, "commit", "-m", "init");
git(seed, "remote", "add", "origin", origin);
git(seed, "push", "origin", "main");

// --- Config ------------------------------------------------------------------------------------
const project = {
  name: "shop",
  id: 7,
  path: "team/shop",
  httpUrl: `file://${origin}`,
  defaultBranch: "main",
  testCommand: "npm test",
  testMode: "local" as const,
  status: { mode: "labels" as const, inProgress: "st::doing", inReview: "st::review", blocked: "st::blocked" },
};
const config = ConfigSchema.parse({
  gitlab: { username: "olivier", userId: 42 },
  git: { authorName: "SprintSaver E2E", authorEmail: "e2e@example.invalid" },
  models: args.has("--opus") ? {} : Object.fromEntries(AGENT_PHASES.map((p) => [p, SONNET])),
  projects: [project],
});
const projectConfig = config.projects[0]!;

// --- GitLab simulé -----------------------------------------------------------------------------
const calls = new CallLog();
const gitlab = new FakeGitLab(calls);
gitlab.notes = [];
gitlab.issue = makeIssue({
  projectId: 7,
  iid: 31,
  title: "Le prix s'affiche mal dans le panier",
  labels: ["bug", "auto::ready"],
  issueType: "issue",
  webUrl: "https://gitlab.example.com/team/shop/-/issues/31",
  authorUsername: "po",
  description: [
    "Dans le panier, 10,50 € s'affiche `10.5 €`.",
    "",
    "## Critères d'acceptation",
    "- [ ] `formatPrice(1050)` renvoie `10,50 €` (virgule décimale, toujours deux décimales)",
    "- [ ] `formatPrice(0)` renvoie `0,00 €`",
    "- [ ] Les montants négatifs gardent leur signe : `formatPrice(-250)` renvoie `-2,50 €`",
    "- [ ] Valider le rendu avec le PO",
  ].join("\n"),
});

// Scénario --ci-fail : le premier pipeline échoue (et sa relance aussi) sur un job "lint" qui exige
// une JSDoc @returns sur formatPrice. Exerce la boucle ci-fix et la re-review du delta.
if (args.has("--ci-fail")) {
  const failedJob = { id: 501, name: "lint", stage: "test", status: "failed", webUrl: "https://gitlab.example.com/job/501", allowFailure: false };
  const failed = {
    kind: "failed" as const,
    pipeline: { id: 900, status: "failed" as const, sha: "x", ref: "b", webUrl: "https://gitlab.example.com/pipelines/900" },
    failedJobs: [failedJob],
  };
  gitlab.pipelineOutcomes = [failed];
  gitlab.retryOutcomes = [failed];
  gitlab.jobLog = async () =>
    [
      "$ npm run lint",
      "src/price.js",
      "  2:1  error  Missing JSDoc @returns for function 'formatPrice'  jsdoc/require-returns",
      "  2:1  error  Missing JSDoc @param for parameter 'cents'          jsdoc/require-param",
      "✖ 2 problems (2 errors, 0 warnings)",
      "ERROR: Job failed: exit code 1",
    ].join("\n");
}

// --- Exécution ---------------------------------------------------------------------------------
const processor = createTicketProcessor({
  config,
  gitlab,
  git: createGitOps({ token: "e2e-token", authorName: config.git.authorName, authorEmail: config.git.authorEmail }),
  agent: createAgentRunner({ config, gitlab }),
  store: createStateStore(),
  recorder: createRunRecorder(),
});

const t0 = Date.now();
const state = await processor.process(projectConfig, 31);
const minutes = ((Date.now() - t0) / 60000).toFixed(1);

// --- Rapport -----------------------------------------------------------------------------------
console.log("\n================ RÉSULTAT E2E ================");
console.log(`Phase finale : ${state.phase}${state.blockedReason ? ` (${state.blockedReason})` : ""} en ${minutes} min`);
console.log(`Compteurs : ${JSON.stringify(state.counters)}`);
console.log(`Tests déclarés : ${state.tests.map((t) => `${t.name} [${t.criteria.join(",")}]`).join(" | ")}`);
console.log(`Preuves : ${state.proofs.map((p) => `#${p.index}:${p.proven ? "ok" : "NON"}`).join(" ")}`);
console.log(`Nits : ${state.nits.length}`);
console.log("\nAppels GitLab :", calls.entries.join(" → "));
console.log("\n--- Commentaires ---\n" + gitlab.comments.join("\n\n---\n"));
const lastMr = gitlab.mrUpdates.at(-1)?.patch;
if (lastMr) console.log(`\n--- MR finale : ${lastMr.title}\n${lastMr.description}`);
console.log("\n--- Description finale du ticket ---\n" + gitlab.issue.description);
const verify = join(root, "verify");
execFileSync("git", ["clone", "-q", origin, verify]);
const branch = state.branch;
console.log(`\n--- git log ${branch} ---\n` + git(verify, "log", "--format=%h %an <%ae> %s%n%b", `origin/${branch}`, "--not", "origin/main"));
console.log("--- tests sur la branche poussée ---");
git(verify, "checkout", "-q", branch);
try {
  console.log(execFileSync("npm", ["test"], { cwd: verify, encoding: "utf8" }).split("\n").filter((l) => /^(# |ℹ )(tests|pass|fail) /.test(l)).join("\n"));
} catch (e) {
  console.log("ÉCHEC des tests sur la branche :", (e as { stdout?: string }).stdout?.slice(-2000));
}
const runDir = paths.run(state.key);
if (existsSync(runDir)) {
  console.log(`\nRuns : ${runDir} → ${readdirSync(runDir).join(", ")}`);
  const retro = join(runDir, "retro.md");
  if (existsSync(retro)) console.log("\n--- retro.md ---\n" + readFileSync(retro, "utf8"));
}
console.log(`\nWorktree supprimé : ${!existsSync(state.worktreePath)}`);

if (args.has("--keep")) console.log(`\nDossier conservé : ${root}`);
else rmSync(root, { recursive: true, force: true });
process.exit(state.phase === "finalized" ? 0 : 1);
