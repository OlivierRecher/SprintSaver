import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultCheckoutRoots,
  exampleCounterpart,
  isDependencyOrBuildPath,
  listIgnoredFiles,
  findLocalCheckouts,
  isCheckoutOf,
  normalizeRemote,
  readGitRemotes,
  sameRemote,
} from "../../src/init/local-checkout.js";

const URL_ = "https://gitlab.example.com/team/shop.git";

async function fakeRepo(dir: string, remotes: string[]): Promise<void> {
  await mkdir(join(dir, ".git"), { recursive: true });
  const sections = remotes.map((u, i) => `[remote "r${i}"]\n\turl = ${u}\n\tfetch = +refs/heads/*:refs/remotes/r${i}/*`).join("\n");
  await writeFile(join(dir, ".git", "config"), `[core]\n\tbare = false\n${sections}\n`);
}

let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ss-checkout-")));
  await fakeRepo(join(root, "code", "shop"), ["git@gitlab.example.com:team/shop.git"]);
  await fakeRepo(join(root, "code", "other"), ["https://gitlab.example.com/team/other.git"]);
  await fakeRepo(join(root, "work", "clients", "acme", "shop-copy"), ["https://gitlab.example.com/team/shop"]);
  // Dépôt dans node_modules : jamais parcouru.
  await fakeRepo(join(root, "code", "app", "node_modules", "shop"), [URL_]);
  // Worktree lié : .git est un fichier qui renvoie au dépôt principal.
  const wt = join(root, "code", "shop-wt");
  await mkdir(join(root, "code", "shop", ".git", "worktrees", "shop-wt"), { recursive: true });
  await writeFile(join(root, "code", "shop", ".git", "worktrees", "shop-wt", "commondir"), "../..\n");
  await mkdir(wt, { recursive: true });
  await writeFile(join(wt, ".git"), `gitdir: ${join(root, "code", "shop", ".git", "worktrees", "shop-wt")}\n`);
  // Trop profond pour la recherche (profondeur 4 par défaut sous la racine).
  await fakeRepo(join(root, "deep", "a", "b", "c", "d", "shop"), [URL_]);
  // Lien symbolique vers un dossier déjà parcouru : pas de doublon.
  await symlink(join(root, "code"), join(root, "code-link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("remotes git", () => {
  it("normalise https, ssh, scp et file", () => {
    expect(normalizeRemote("https://user@GitLab.example.com/Team/Shop.git")).toBe("gitlab.example.com/team/shop");
    expect(normalizeRemote("git@gitlab.example.com:team/shop.git")).toBe("gitlab.example.com/team/shop");
    expect(normalizeRemote("ssh://git@gitlab.example.com:2222/team/shop.git")).toBe("gitlab.example.com/team/shop");
    expect(normalizeRemote("file:///tmp/origin.git")).toBe("file/tmp/origin");
    expect(normalizeRemote("/tmp/origin.git")).toBe("file/tmp/origin");
    expect(sameRemote("/tmp/origin.git", "file:///tmp/origin.git")).toBe(true);
    expect(normalizeRemote("pas une url")).toBeNull();
  });

  it("même projet : même hôte et même chemin, ou instance sous un sous-chemin", () => {
    expect(sameRemote("git@gitlab.example.com:team/shop.git", URL_)).toBe(true);
    expect(sameRemote("https://exemple.fr/gitlab/team/shop.git", "git@exemple.fr:team/shop.git")).toBe(true);
    expect(sameRemote("https://gitlab.example.com/team/shop2.git", URL_)).toBe(false);
    expect(sameRemote("https://gitlab.com/team/shop.git", URL_)).toBe(false);
  });

  it("lit les remotes d'un dépôt et d'un worktree lié ; rien pour un dossier ordinaire", async () => {
    expect(await readGitRemotes(join(root, "code", "shop"))).toEqual(["git@gitlab.example.com:team/shop.git"]);
    expect(await readGitRemotes(join(root, "code", "shop-wt"))).toEqual(["git@gitlab.example.com:team/shop.git"]);
    expect(await readGitRemotes(join(root, "deep"))).toEqual([]);
    expect(await isCheckoutOf(join(root, "code", "shop"), URL_)).toBe(true);
    expect(await isCheckoutOf(join(root, "code", "other"), URL_)).toBe(false);
  });
});

describe("findLocalCheckouts", () => {
  it("trouve les checkouts du projet, sans descendre dans les dépôts, node_modules ni au-delà de la profondeur", async () => {
    const res = await findLocalCheckouts(URL_, { roots: [root] });
    expect(res.matches.sort()).toEqual(
      [join(root, "code", "shop"), join(root, "code", "shop-wt"), join(root, "work", "clients", "acme", "shop-copy")].sort(),
    );
    expect(res.truncated).toBe(false);
  });

  it("exclut les dossiers demandés (clones de SprintSaver)", async () => {
    const res = await findLocalCheckouts(URL_, { roots: [root], exclude: [join(root, "work")] });
    expect(res.matches).not.toContain(join(root, "work", "clients", "acme", "shop-copy"));
  });

  it("s'arrête au plafond de dossiers ou de durée et le signale", async () => {
    expect((await findLocalCheckouts(URL_, { roots: [root], maxDirs: 2 })).truncated).toBe(true);
    let t = 0;
    const res = await findLocalCheckouts(URL_, { roots: [root], timeBudgetMs: 5, now: () => (t += 10) });
    expect(res.truncated).toBe(true);
  });

  it("racines : SPRINTSAVER_CHECKOUT_ROOTS les remplace, sinon dossiers usuels puis dossier personnel", () => {
    expect(defaultCheckoutRoots("/Users/me", { SPRINTSAVER_CHECKOUT_ROOTS: "~/src:/opt/code" })).toEqual(["/Users/me/src", "/opt/code"]);
    const roots = defaultCheckoutRoots("/Users/me", {});
    expect(roots).toContain("/Users/me/code");
    expect(roots.at(-1)).toBe("/Users/me");
  });
});

describe("fichiers ignorés du checkout local", () => {
  it("pendant d'un fichier d'exemple versionné", () => {
    expect(exampleCounterpart(".env.example")).toBe(".env");
    expect(exampleCounterpart("apps/web/.env.local.sample")).toBe("apps/web/.env.local");
    expect(exampleCounterpart("config/settings.example.json")).toBe("config/settings.json");
    expect(exampleCounterpart("settings.py.template")).toBe("settings.py");
    expect(exampleCounterpart(".env-dist")).toBe(".env");
    expect(exampleCounterpart("src/examples.ts")).toBeNull();
    expect(exampleCounterpart("README.md")).toBeNull();
  });

  it("dépendances, build et caches écartés", () => {
    for (const p of ["node_modules/", "apps/web/node_modules/", ".venv/", "dist/", "build/x.js", ".next/", "app.log", "shop.egg-info/", ".DS_Store", "coverage/"]) {
      expect(isDependencyOrBuildPath(p), p).toBe(true);
    }
    for (const p of [".env", "apps/web/.env.local", "certs/", "config/local.yml", "secrets.json"]) expect(isDependencyOrBuildPath(p), p).toBe(false);
  });

  it("liste les noms des fichiers ignorés d'un vrai dépôt git, sans contenu, avec les pendants d'exemples", async () => {
    const repo = join(root, "ignored-repo");
    await mkdir(join(repo, "apps", "web"), { recursive: true });
    await mkdir(join(repo, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(repo, "certs"), { recursive: true });
    await mkdir(join(repo, "dist"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), ".env\n.env.local\nnode_modules/\ndist/\ncerts/\n*.log\n");
    await writeFile(join(repo, ".env.example"), "API_KEY=changeme\n");
    await writeFile(join(repo, ".env"), "API_KEY=vraie-cle-secrete\n");
    await writeFile(join(repo, "apps", "web", ".env.local"), "TOKEN=secret\n");
    await writeFile(join(repo, "certs", "dev.pem"), "PEM");
    await writeFile(join(repo, "node_modules", "left-pad", "index.js"), "");
    await writeFile(join(repo, "dist", "app.js"), "");
    await writeFile(join(repo, "debug.log"), "");
    await execa("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await execa("git", ["add", "-A"], { cwd: repo });
    const res = await listIgnoredFiles(repo);
    expect(res.entries).toEqual([".env", "apps/web/.env.local", "certs/"]);
    expect(res.excluded).toBe(3); // node_modules/, dist/, debug.log
    expect(res.examplePairs).toEqual([[".env", ".env.example"]]);
    expect(JSON.stringify(res)).not.toContain("vraie-cle-secrete");
    const capped = await listIgnoredFiles(repo, { maxEntries: 1 });
    expect(capped).toMatchObject({ entries: [".env"], truncated: true });
  });
});
