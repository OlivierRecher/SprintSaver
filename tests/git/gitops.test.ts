import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "../../src/config/paths.js";
import type { ProjectConfig } from "../../src/config/schema.js";
import { createGitOps } from "../../src/git/gitops.js";

const TOKEN = "glpat-super-secret-token";
const saved: Record<string, string | undefined> = {};
let root: string;
let originPath: string;
let seed: string;
let counter = 0;

async function g(cwd: string, ...args: string[]): Promise<string> {
  const res = await execa("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args], { cwd });
  return res.stdout;
}

async function seedCommit(file: string, content: string, msg: string, branch = "main"): Promise<string> {
  await g(seed, "checkout", "-q", "-B", branch, `origin/${branch}`).catch(() => g(seed, "checkout", "-q", "-B", branch, "origin/main"));
  await mkdir(join(seed, file, ".."), { recursive: true });
  await writeFile(join(seed, file), content);
  await g(seed, "add", "-A");
  await g(seed, "commit", "-q", "-m", msg);
  await g(seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  await g(seed, "fetch", "-q", "origin");
  return (await g(seed, "rev-parse", "HEAD")).trim();
}

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: `p${counter}`,
    id: 1,
    path: "group/p",
    httpUrl: `file://${originPath}`,
    defaultBranch: "main",
    testMode: "local",
    ciSource: "merge_request",
    worktreeInclude: [],
    cowDirs: [],
    status: { inProgress: { kind: "label", name: "a" }, inReview: { kind: "label", name: "b" }, blocked: { kind: "label", name: "c" } },
    typeLabels: { bug: ["bug"], feature: ["feature"] },
    ...over,
  };
}

const ops = createGitOps({ token: TOKEN, authorName: "Bot Tester", authorEmail: "bot@example.com" });

beforeAll(async () => {
  for (const k of ["SPRINTSAVER_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  root = await realpath(await mkdtemp(join(tmpdir(), "ss-git-")));
  process.env.SPRINTSAVER_HOME = join(root, "home");
  // Isole les tests de la config git de la machine (hooks globaux, gpgsign...).
  const globalCfg = join(root, "gitconfig");
  await writeFile(globalCfg, "[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  originPath = join(root, "origin.git");
  await execa("git", ["init", "-q", "--bare", "--initial-branch=main", originPath]);
  seed = join(root, "seed");
  await execa("git", ["init", "-q", "--initial-branch=main", seed]);
  await g(seed, "remote", "add", "origin", originPath);
  await writeFile(join(seed, ".gitignore"), ".env\nnode_modules/\nsetup-done.txt\nlocal/\n");
  await writeFile(join(seed, "README.md"), "hello\n");
  await writeFile(join(seed, "shared.txt"), "line1\nline2\nline3\n");
  await g(seed, "add", "-A");
  await g(seed, "commit", "-q", "-m", "init");
  await g(seed, "push", "-q", "-u", "origin", "main");
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  counter++;
});

describe("ensureReferenceClone", () => {
  it("clone puis fetch, sans jamais écrire le token", async () => {
    const p = project();
    const repo = await ops.ensureReferenceClone(p);
    expect(repo).toBe(paths.repo(p.name));
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    const url = (await g(repo, "remote", "get-url", "origin")).trim();
    expect(url).toBe(p.httpUrl);
    expect(await readFile(join(repo, ".git", "config"), "utf8")).not.toContain(TOKEN);

    const sha = await seedCommit("later.txt", "x\n", "later");
    await ops.ensureReferenceClone(p);
    expect((await g(repo, "rev-parse", "origin/main")).trim()).toBe(sha);
  });

  it("envoie le token en en-tête HTTP (jamais dans l'URL)", async () => {
    const seen: { auth?: string; url?: string } = {};
    const server = createServer((req, res) => {
      seen.auth = req.headers.authorization;
      seen.url = req.url;
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const p = project({ httpUrl: `http://127.0.0.1:${port}/group/p.git` });
      await expect(ops.remoteBranchExists(p, "main")).rejects.toThrow();
    } finally {
      server.close();
    }
    expect(seen.auth).toBe(`Basic ${Buffer.from(`oauth2:${TOKEN}`).toString("base64")}`);
    expect(seen.url).not.toContain(TOKEN);
  });

  it("remoteBranchExists", async () => {
    const p = project();
    expect(await ops.remoteBranchExists(p, "main")).toBe(true);
    expect(await ops.remoteBranchExists(p, "sprintsaver/none")).toBe(false);
  });
});

describe("worktrees", () => {
  it("crée un worktree neuf depuis origin/main puis le réutilise", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-1`);
    expect(await ops.createOrReuseWorktree(p, "sprintsaver/1-new", wt)).toEqual({ reused: false });
    expect((await g(wt, "symbolic-ref", "--short", "HEAD")).trim()).toBe("sprintsaver/1-new");
    expect(await ops.headSha(wt)).toBe((await g(wt, "rev-parse", "origin/main")).trim());
    expect(await ops.createOrReuseWorktree(p, "sprintsaver/1-new", wt)).toEqual({ reused: true });

    // .sprintsaver/ est exclu
    await mkdir(join(wt, ".sprintsaver"), { recursive: true });
    await writeFile(join(wt, ".sprintsaver", "img.png"), "png");
    expect(await ops.isDirty(wt)).toBe(false);
    expect(await ops.commitAll(wt, "rien")).toBeNull();
  });

  it("reprend une branche existante sur le remote avec upstream", async () => {
    const p = project();
    const branch = `sprintsaver/${counter}-resume`;
    const sha = await seedCommit("feature.txt", "wip\n", "wip", branch);
    await ops.ensureReferenceClone(p);
    expect(await ops.remoteBranchExists(p, branch)).toBe(true);
    const wt = paths.worktree(`${p.name}-2`);
    expect(await ops.createOrReuseWorktree(p, branch, wt)).toEqual({ reused: false });
    expect(await ops.headSha(wt)).toBe(sha);
    expect((await g(wt, "rev-parse", "--abbrev-ref", "@{u}")).trim()).toBe(`origin/${branch}`);
  });

  it("gère une branche locale orpheline (worktree supprimé à la main)", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-3`);
    const branch = "sprintsaver/3-orphan";
    await ops.createOrReuseWorktree(p, branch, wt);
    await writeFile(join(wt, "a.txt"), "a\n");
    await ops.commitAll(wt, "feat: a");
    await rm(wt, { recursive: true, force: true }); // sans git worktree remove
    expect(await ops.createOrReuseWorktree(p, branch, wt)).toEqual({ reused: false });
    expect(await ops.headSha(wt)).toBe((await g(wt, "rev-parse", "origin/main")).trim());
  });

  it("prepareWorktree : fichiers ignorés, cowDirs, setupCommand", async () => {
    const p = project({
      worktreeInclude: [".env", "local/", "node_modules/"],
      cowDirs: ["node_modules/"],
      setupCommand: 'echo "setup $CI" > setup-done.txt',
    });
    const repo = await ops.ensureReferenceClone(p);
    await writeFile(join(repo, ".env"), "SECRET=1\n");
    await mkdir(join(repo, "local", "deep"), { recursive: true });
    await writeFile(join(repo, "local", "deep", "conf.json"), "{}\n");
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    const wt = paths.worktree(`${p.name}-4`);
    await ops.createOrReuseWorktree(p, "sprintsaver/4-prep", wt);
    await ops.prepareWorktree(p, wt, 30_000);
    expect(await readFile(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await readFile(join(wt, "local", "deep", "conf.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(wt, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect((await readFile(join(wt, "setup-done.txt"), "utf8")).trim()).toBe("setup true");
    expect(await ops.isDirty(wt)).toBe(false); // tout est ignoré

    // .worktreeinclude de l'arbre de travail du clone de référence (jamais mis à jour par fetch) : ignoré
    await writeFile(join(repo, ".worktreeinclude"), ".env\n");
    const wt1 = paths.worktree(`${p.name}-4a`);
    await ops.createOrReuseWorktree(p, "sprintsaver/4a-prep", wt1);
    await ops.prepareWorktree({ ...p, setupCommand: undefined, cowDirs: [] }, wt1, 30_000);
    expect(existsSync(join(wt1, "local", "deep", "conf.json"))).toBe(true); // config utilisée

    // .worktreeinclude de origin/<defaultBranch> prioritaire sur la config
    await seedCommit(".worktreeinclude", "# commentaire\nlocal/\n", "chore: worktreeinclude");
    await ops.ensureReferenceClone(p);
    const wt2 = paths.worktree(`${p.name}-4b`);
    await ops.createOrReuseWorktree(p, "sprintsaver/4b-prep", wt2);
    await ops.prepareWorktree({ ...p, setupCommand: undefined, cowDirs: [] }, wt2, 30_000);
    expect(existsSync(join(wt2, "local", "deep", "conf.json"))).toBe(true);
    expect(existsSync(join(wt2, ".env"))).toBe(false);

    await expect(
      ops.prepareWorktree({ ...p, setupCommand: "echo boom-output; exit 3", cowDirs: [] }, wt2, 30_000),
    ).rejects.toThrow(/boom-output/);
  });

  it("prepareWorktree : localCheckout sert de source aux fichiers ignorés et aux cowDirs", async () => {
    const p0 = project({ worktreeInclude: ["local/"], cowDirs: ["node_modules/"] });
    const repo = await ops.ensureReferenceClone(p0);
    // Checkout « personnel » de l'utilisateur : un clone distinct avec son .env et ses node_modules.
    const mine = join(await mkdtemp(join(tmpdir(), "ss-mine-")), "mine");
    await g(repo, "worktree", "list"); // repo valide
    await execa("git", ["clone", "-q", repo, mine]);
    await mkdir(join(mine, "local"), { recursive: true });
    await writeFile(join(mine, "local", "conf"), "MINE=1\n");
    await mkdir(join(mine, "node_modules", "dep"), { recursive: true });
    await writeFile(join(mine, "node_modules", "dep", "i.js"), "x\n");
    await mkdir(join(repo, "local"), { recursive: true });
    await writeFile(join(repo, "local", "conf"), "REF=1\n");

    const p = { ...p0, localCheckout: mine };
    const wt = paths.worktree(`${p.name}-4c`);
    await ops.createOrReuseWorktree(p, "sprintsaver/4c-local", wt);
    await ops.prepareWorktree(p, wt, 30_000);
    expect(await readFile(join(wt, "local", "conf"), "utf8")).toBe("MINE=1\n");
    expect(existsSync(join(wt, "node_modules", "dep", "i.js"))).toBe(true);
  });

  it("removeWorktree supprime le worktree", async () => {
    const p = project();
    const repo = await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-5`);
    await ops.createOrReuseWorktree(p, "sprintsaver/5-rm", wt);
    await writeFile(join(wt, "untracked.txt"), "x");
    await ops.removeWorktree(p, wt);
    expect(existsSync(wt)).toBe(false);
    expect(await g(repo, "worktree", "list", "--porcelain")).not.toContain(wt);
  });

  it("createBaseWorktree : worktree détaché sur la base du ticket, recréé s'il existe ; discardChanges nettoie", async () => {
    const p = project();
    const repo = await ops.ensureReferenceClone(p);
    const baseSha = (await g(repo, "rev-parse", "origin/main")).trim();
    const wt = paths.worktree(`${p.name}-6`);
    await ops.createOrReuseWorktree(p, "sprintsaver/6-ui", wt);
    await writeFile(join(wt, "ticket.txt"), "travail du ticket");
    await ops.commitAll(wt, "feat: écran");

    const base = `${wt}.avant`;
    await ops.createBaseWorktree(p, wt, base);
    expect((await g(base, "rev-parse", "HEAD")).trim()).toBe(baseSha);
    expect(existsSync(join(base, "ticket.txt"))).toBe(false);
    await writeFile(join(base, "build.log"), "x");
    await ops.createBaseWorktree(p, wt, base);
    expect(existsSync(join(base, "build.log"))).toBe(false);
    await ops.removeWorktree(p, base);
    expect(await g(repo, "worktree", "list", "--porcelain")).not.toContain(base);

    await writeFile(join(wt, "ticket.txt"), "modifié par une session");
    await writeFile(join(wt, "stray.txt"), "x");
    await mkdir(join(wt, ".sprintsaver", "captures"), { recursive: true });
    await writeFile(join(wt, ".sprintsaver", "captures", "1-apres.png"), "png");
    await ops.discardChanges(wt);
    expect(await readFile(join(wt, "ticket.txt"), "utf8")).toBe("travail du ticket");
    expect(existsSync(join(wt, "stray.txt"))).toBe(false);
    expect(existsSync(join(wt, ".sprintsaver", "captures", "1-apres.png"))).toBe(true);
    expect(await ops.isDirty(wt)).toBe(false);
  });
});

describe("commit, push, diff", () => {
  it("commit à l'identité configurée, sans trailer, puis push et force-push", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-6`);
    const branch = `sprintsaver/${counter}-push`;
    await ops.createOrReuseWorktree(p, branch, wt);
    await writeFile(join(wt, "new.txt"), "new\n");
    expect(await ops.isDirty(wt)).toBe(true);

    const diff = await ops.diffAgainstBase(p, wt);
    expect(diff).toContain("new.txt"); // fichier non suivi inclus
    expect(await ops.isDirty(wt)).toBe(true);
    expect(await g(wt, "diff", "--cached", "--name-only")).toBe(""); // index réel intact

    const sha = await ops.commitAll(wt, "feat: new\n\nCo-Authored-By: Someone <x@y.z>");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const msg = await g(wt, "log", "-1", "--format=%B");
    expect(msg).not.toMatch(/co-authored-by/i);
    expect((await g(wt, "log", "-1", "--format=%an <%ae>")).trim()).toBe("Bot Tester <bot@example.com>");
    expect(await ops.isDirty(wt)).toBe(false);

    await ops.push(wt, branch);
    expect((await g(seed, "ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0]).toBe(sha);
    expect((await g(wt, "rev-parse", "--abbrev-ref", "@{u}")).trim()).toBe(`origin/${branch}`);

    await g(wt, "commit", "-q", "--amend", "-m", "feat: new (amended)");
    const amended = await ops.headSha(wt);
    await expect(ops.push(wt, branch)).rejects.toThrow();
    await ops.push(wt, branch, { force: true });
    expect((await g(seed, "ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0]).toBe(amended);

    const range = await ops.diffRange(wt, "origin/main", "HEAD");
    expect(range).toContain("+new");
  });
});

describe("rebase", () => {
  it("push forcé refusé si un commit étranger a été poussé sur la branche puis récupéré par fetch", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-fil`);
    const branch = `sprintsaver/${counter}-foreign`;
    await ops.createOrReuseWorktree(p, branch, wt);
    await writeFile(join(wt, `mine-${counter}.txt`), "mine\n");
    await ops.commitAll(wt, "feat: mine");
    await ops.push(wt, branch);

    await g(seed, "fetch", "-q", "origin");
    const human = await seedCommit(`human-${counter}.txt`, "human\n", "fix: humain", branch);
    await seedCommit(`up-${counter}.txt`, "up\n", "amont");
    expect(await ops.rebaseOnDefault(p, wt)).toEqual({ ok: true }); // fetch : origin/<branche> = commit humain
    await expect(ops.push(wt, branch, { force: true })).rejects.toThrow(/commits? que SprintSaver n'a pas/);
    expect((await g(seed, "ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0]).toBe(human);
  });

  it("rebaseContinue : conflit résolu en gardant l'amont (index vide) → commit sauté", async () => {
    const p = project();
    const repo = await ops.ensureReferenceClone(p);
    // Backend « apply » (config utilisateur possible, ancien défaut) : `--continue` y échoue sur un index vide.
    await g(repo, "config", "rebase.backend", "apply");
    const wt = paths.worktree(`${p.name}-skip`);
    await ops.createOrReuseWorktree(p, `sprintsaver/${counter}-skip`, wt);
    const file = `skip-${counter}.txt`;
    const other = `skip2-${counter}.txt`;
    await seedCommit(file, "base\n", "base");
    await seedCommit(other, "base\n", "base2");
    await ops.rebaseOnDefault(p, wt);
    await writeFile(join(wt, file), "mine\n");
    await ops.commitAll(wt, "feat: mine 1");
    await writeFile(join(wt, other), "mine2\n");
    await ops.commitAll(wt, "feat: mine 2");
    await seedCommit(file, "theirs\n", "theirs");
    await seedCommit(other, "theirs2\n", "theirs2");

    expect(await ops.rebaseOnDefault(p, wt)).toEqual({ ok: false, conflictedFiles: [file] });
    await writeFile(join(wt, file), "theirs\n"); // on garde l'amont : plus rien à appliquer
    expect(await ops.rebaseContinue(wt)).toEqual({ ok: false, conflictedFiles: [other] }); // conflit suivant
    await writeFile(join(wt, other), "theirs2\n");
    expect(await ops.rebaseContinue(wt)).toEqual({ ok: true });
    expect((await g(wt, "log", "-1", "--format=%s")).trim()).toBe("theirs2");
    expect(await ops.isDirty(wt)).toBe(false);
  });


  it("rebaseContinue : marqueurs de conflit restants → pas de continue, même conflit renvoyé", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-markers`);
    await ops.createOrReuseWorktree(p, `sprintsaver/${counter}-markers`, wt);
    const file = `markers-${counter}.txt`;
    await seedCommit(file, "base\n", "base");
    await ops.rebaseOnDefault(p, wt);
    await writeFile(join(wt, file), "mine\n");
    await writeFile(join(wt, "notes.md"), "Titre\n=======\n");
    await ops.commitAll(wt, "feat: mine");
    await seedCommit(file, "theirs\n", "theirs");

    expect(await ops.rebaseOnDefault(p, wt)).toEqual({ ok: false, conflictedFiles: [file] });
    expect(await readFile(join(wt, file), "utf8")).toMatch(/^<<<<<<< /m);
    // Fichier en conflit laissé tel quel : rien n'est marqué résolu, le rebase reste arrêté.
    expect(await ops.rebaseContinue(wt)).toEqual({ ok: false, conflictedFiles: [file] });
    expect((await g(wt, "diff", "--name-only", "--diff-filter=U")).trim()).toBe(file);
    // Conflit résolu, mais marqueurs collés dans un autre fichier modifié.
    await writeFile(join(wt, file), "merged\n");
    await writeFile(join(wt, `other-${counter}.txt`), "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> theirs\n");
    expect(await ops.rebaseContinue(wt)).toEqual({ ok: false, conflictedFiles: [`other-${counter}.txt`] });
    // Tout est propre (le « ======= » d'un titre Markdown n'est pas un marqueur) : le rebase se termine.
    await rm(join(wt, `other-${counter}.txt`));
    expect(await ops.rebaseContinue(wt)).toEqual({ ok: true });
    expect(await readFile(join(wt, file), "utf8")).toBe("merged\n");
    expect((await g(wt, "log", "-1", "--format=%s")).trim()).toBe("feat: mine");
  });

  it("rebase sans conflit", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-7`);
    await ops.createOrReuseWorktree(p, "sprintsaver/7-rb", wt);
    await writeFile(join(wt, "mine.txt"), "mine\n");
    await ops.commitAll(wt, "feat: mine");
    const upstream = await seedCommit(`other-${counter}.txt`, "other\n", "other");
    expect(await ops.rebaseOnDefault(p, wt)).toEqual({ ok: true });
    expect((await g(wt, "rev-parse", "HEAD~1")).trim()).toBe(upstream);
    const diff = await ops.diffAgainstBase(p, wt);
    expect(diff).toContain("mine.txt");
    expect(diff).not.toContain(`other-${counter}.txt`);
  });

  it("rebase avec conflit, résolution puis continue ; et abort", async () => {
    const p = project();
    await ops.ensureReferenceClone(p);
    const wt = paths.worktree(`${p.name}-8`);
    await ops.createOrReuseWorktree(p, "sprintsaver/8-conflict", wt);
    const file = `conflict-${counter}.txt`;
    await seedCommit(file, "base\n", "base");
    await ops.rebaseOnDefault(p, wt);
    await writeFile(join(wt, file), "mine\n");
    await ops.commitAll(wt, "feat: mine");
    await seedCommit(file, "theirs\n", "theirs");

    const res = await ops.rebaseOnDefault(p, wt);
    expect(res).toEqual({ ok: false, conflictedFiles: [file] });
    await writeFile(join(wt, file), "merged\n");
    expect(await ops.rebaseContinue(wt)).toEqual({ ok: true });
    expect(await readFile(join(wt, file), "utf8")).toBe("merged\n");
    expect((await g(wt, "log", "-1", "--format=%s")).trim()).toBe("feat: mine");

    await seedCommit(file, "theirs again\n", "theirs again");
    const before = await ops.headSha(wt);
    expect((await ops.rebaseOnDefault(p, wt)).ok).toBe(false);
    await ops.rebaseAbort(wt);
    await ops.rebaseAbort(wt); // idempotent
    expect(await ops.headSha(wt)).toBe(before);
    expect(await ops.isDirty(wt)).toBe(false);
  });
});

describe("run", () => {
  it("renvoie code, sortie entrelacée et CI=true sans lever", async () => {
    const res = await ops.run(root, 'echo out; echo err 1>&2; echo "ci=$CI"; exit 4', 10_000);
    expect(res.exitCode).toBe(4);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain("out");
    expect(res.output).toContain("err");
    expect(res.output).toContain("ci=true");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tronque la sortie aux 30 000 derniers caractères", async () => {
    const res = await ops.run(root, `node -e "process.stdout.write('a'.repeat(40000) + 'END')"`, 10_000);
    expect(res.exitCode).toBe(0);
    expect(res.output.length).toBe(30_000);
    expect(res.output.endsWith("END")).toBe(true);
  });

  it("timeout : tue tout l'arbre de processus", async () => {
    const res = await ops.run(root, "sleep 20 & sleep 20; echo never", 500);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(res.output).not.toContain("never");
    expect(res.durationMs).toBeLessThan(10_000);
  });
});

describe("jeton glab (ADR, amendement 2)", () => {
  it("relit le jeton du fournisseur et l'envoie en en-tête Basic", async () => {
    const auths: string[] = [];
    const server = createServer((req, res) => {
      auths.push(String(req.headers.authorization ?? ""));
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    let reads = 0;
    const provider = {
      label: "glab (test)",
      get: async () => {
        reads++;
        return "glab-oauth-token";
      },
      refresh: async () => "glab-oauth-token",
    };
    try {
      const viaGlab = createGitOps({ token: provider });
      await expect(viaGlab.remoteBranchExists(project({ httpUrl: `http://127.0.0.1:${port}/group/p.git` }), "main")).rejects.toThrow();
    } finally {
      server.close();
    }
    expect(reads).toBeGreaterThan(0);
    expect(auths.length).toBeGreaterThan(0);
    expect(auths.every((a) => a === `Basic ${Buffer.from("oauth2:glab-oauth-token").toString("base64")}`)).toBe(true);
  });
});
