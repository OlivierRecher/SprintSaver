import { staticToken, type TokenProvider } from "../gitlab/glab-auth.js";
import { constants as fsConstants } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { execa } from "execa";
import type { ProjectConfig } from "../config/schema.js";
import { paths } from "../config/paths.js";
import { ProjectCommandError, type CommandResult, type GitOps, type RebaseResult } from "../contracts.js";
import { log } from "../log.js";
import { killProcessGroup, trackProcessGroup } from "../process-groups.js";
import { projectCommandEnv } from "../process-env.js";

/** Taille max de la sortie conservée par `run` (fin de la sortie). */
const MAX_OUTPUT_CHARS = 30_000;
/** Délai entre SIGTERM et SIGKILL quand une commande dépasse son timeout. */
const KILL_GRACE_MS = 5_000;
/** Marqueurs de conflit git (début, séparateur, fin), en début de ligne. */
const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)( |\r?$)/m;
/** Marqueurs de début et de fin seulement (fichiers modifiés hors conflit). */
const CONFLICT_EDGE_MARKER_RE = /^(<<<<<<<|>>>>>>>)( |\r?$)/m;
/** Taille au-delà de laquelle un fichier n'est pas inspecté pour les marqueurs de conflit. */
const MAX_MARKER_SCAN_BYTES = 5_000_000;
/** Dossier de travail de l'outil dans chaque worktree, jamais commité. */
const TOOL_DIR_EXCLUDE = "/.sprintsaver/";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} a échoué (code ${exitCode ?? "?"}) : ${tail(stderr, 2_000).trim()}`);
    this.name = "GitError";
  }
}

export interface GitOpsOptions {
  /** Jeton envoyé aux remotes HTTPS : la connexion glab en production (ADR, amendement 2), une chaîne en test. */
  token: string | TokenProvider;
  authorName?: string;
  authorEmail?: string;
}

interface GitRunOpts {
  cwd: string;
  /** Ajoute l'en-tête d'authentification (clone/fetch/push/ls-remote). */
  net?: boolean;
  /** Ajoute `-c user.name/user.email` (commit, rebase). */
  identity?: boolean;
  /** Variables d'environnement supplémentaires. */
  env?: Record<string, string>;
}

interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function createGitOps(opts: GitOpsOptions): GitOps {
  const identityArgs: string[] = [];
  if (opts.authorName) identityArgs.push("-c", `user.name=${opts.authorName}`);
  if (opts.authorEmail) identityArgs.push("-c", `user.email=${opts.authorEmail}`);

  /**
   * L'en-tête est passé par GIT_CONFIG_COUNT/KEY/VALUE : il n'apparaît ni dans `ps`, ni dans une URL,
   * ni dans .git/config.
   */
  const tokens: TokenProvider = typeof opts.token === "string" ? staticToken(opts.token) : opts.token;

  function authEnv(token: string): Record<string, string> {
    if (!token) return {};
    const base = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    const header = `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`;
    return {
      GIT_CONFIG_COUNT: String(base + 1),
      [`GIT_CONFIG_KEY_${base}`]: "http.extraHeader",
      [`GIT_CONFIG_VALUE_${base}`]: header,
    };
  }

  async function gitRaw(args: string[], o: GitRunOpts): Promise<GitRunResult> {
    const fullArgs = [...(o.identity ? identityArgs : []), ...args];
    const auth = o.net ? authEnv(await tokens.get()) : {};
    const res = await execa("git", fullArgs, {
      cwd: o.cwd,
      reject: false,
      stdin: "ignore",
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        ...auth,
        ...o.env,
      },
    });
    return { exitCode: res.exitCode ?? -1, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
  }

  async function git(args: string[], o: GitRunOpts): Promise<string> {
    const res = await gitRaw(args, o);
    if (res.exitCode !== 0) throw new GitError(args, res.exitCode, res.stderr || res.stdout);
    return res.stdout;
  }

  async function refExists(cwd: string, ref: string): Promise<boolean> {
    const res = await gitRaw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
    return res.exitCode === 0;
  }

  /** Résout `git rev-parse --git-path <p>` (relatif au cwd) en chemin absolu. */
  async function gitPath(cwd: string, p: string): Promise<string> {
    const out = (await git(["rev-parse", "--git-path", p], { cwd })).trim();
    return isAbsolute(out) ? out : resolve(cwd, out);
  }

  async function ensureToolDirExcluded(wtPath: string): Promise<void> {
    const excludeFile = await gitPath(wtPath, "info/exclude");
    let content = "";
    try {
      content = await readFile(excludeFile, "utf8");
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    if (content.split(/\r?\n/).some((l) => l.trim() === TOOL_DIR_EXCLUDE)) return;
    await mkdir(dirname(excludeFile), { recursive: true });
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await appendFile(excludeFile, `${prefix}# SprintSaver : données de travail de l'outil\n${TOOL_DIR_EXCLUDE}\n`);
  }

  async function isValidWorktree(refRepo: string, wtPath: string): Promise<boolean> {
    if (!(await exists(wtPath))) return false;
    const inside = await gitRaw(["rev-parse", "--is-inside-work-tree"], { cwd: wtPath });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return false;
    const top = await gitRaw(["rev-parse", "--show-toplevel"], { cwd: wtPath });
    if (top.exitCode !== 0) return false;
    const wtReal = await realpath(wtPath);
    if ((await realpath(top.stdout.trim())) !== wtReal) return false;
    const listed = await listWorktrees(refRepo);
    return listed.includes(wtReal);
  }

  async function listWorktrees(refRepo: string): Promise<string[]> {
    const out = await git(["worktree", "list", "--porcelain"], { cwd: refRepo });
    const result: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice("worktree ".length);
      result.push(await realpath(p).catch(() => p));
    }
    return result;
  }

  async function rebaseInProgress(wtPath: string): Promise<boolean> {
    return (await exists(await gitPath(wtPath, "rebase-merge"))) || (await exists(await gitPath(wtPath, "rebase-apply")));
  }

  async function conflictedFiles(wtPath: string): Promise<string[]> {
    const out = await git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: wtPath });
    return out.split("\0").filter(Boolean);
  }

  /** Interprète le résultat d'un `rebase` / `rebase --continue`. */
  async function rebaseOutcome(wtPath: string, res: GitRunResult, args: string[]): Promise<RebaseResult> {
    if (res.exitCode === 0) return { ok: true };
    if (await rebaseInProgress(wtPath)) {
      const files = await conflictedFiles(wtPath);
      if (files.length > 0) return { ok: false, conflictedFiles: files };
    }
    throw new GitError(args, res.exitCode, `${res.stderr}\n${res.stdout}`);
  }

  async function ensureReferenceClone(project: ProjectConfig): Promise<string> {
    const repo = paths.repo(project.name);
    if (await exists(repo)) {
      const check = await gitRaw(["rev-parse", "--is-inside-work-tree"], { cwd: repo });
      const top = check.exitCode === 0 ? await gitRaw(["rev-parse", "--show-toplevel"], { cwd: repo }) : null;
      const isOwnRepo = top !== null && top.exitCode === 0 && (await realpath(top.stdout.trim())) === (await realpath(repo));
      if (!isOwnRepo) {
        log.warn({ repo }, "clone de référence invalide, suppression et re-clonage");
        await rm(repo, { recursive: true, force: true });
      }
    }
    if (!(await exists(repo))) {
      await mkdir(dirname(repo), { recursive: true });
      log.info({ project: project.name }, "clonage du dépôt de référence");
      await git(["clone", "--no-recurse-submodules", project.httpUrl, repo], { cwd: dirname(repo), net: true });
      return repo;
    }
    // L'URL propre (sans token) reste la référence.
    const current = (await gitRaw(["remote", "get-url", "origin"], { cwd: repo })).stdout.trim();
    if (current !== project.httpUrl) {
      await git(["remote", "set-url", "origin", project.httpUrl], { cwd: repo });
    }
    await git(["fetch", "--prune", "origin"], { cwd: repo, net: true });
    return repo;
  }

  async function remoteBranchExists(project: ProjectConfig, branch: string): Promise<boolean> {
    const args = ["ls-remote", "--exit-code", "--heads", project.httpUrl, `refs/heads/${branch}`];
    const res = await gitRaw(args, { cwd: tmpdir(), net: true });
    if (res.exitCode === 0) return res.stdout.trim().length > 0;
    if (res.exitCode === 2) return false;
    throw new GitError(args, res.exitCode, res.stderr);
  }

  async function createOrReuseWorktree(
    project: ProjectConfig,
    branch: string,
    wtPath: string,
  ): Promise<{ reused: boolean }> {
    const repo = paths.repo(project.name);
    if (!(await exists(repo))) await ensureReferenceClone(project);

    if (await isValidWorktree(repo, wtPath)) {
      const current = (await gitRaw(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: wtPath })).stdout.trim();
      if (current && current !== branch) {
        log.warn({ wtPath, expected: branch, current }, "worktree réutilisé sur une autre branche que prévu");
      }
      await ensureToolDirExcluded(wtPath);
      return { reused: true };
    }

    if (await exists(wtPath)) {
      log.warn({ wtPath }, "dossier de worktree invalide, suppression");
      await rm(wtPath, { recursive: true, force: true });
    }
    // Nettoie les worktrees orphelins (dossier supprimé) qui verrouilleraient encore la branche.
    await git(["worktree", "prune"], { cwd: repo });
    await mkdir(dirname(wtPath), { recursive: true });

    const remoteRef = `refs/remotes/origin/${branch}`;
    const localRef = `refs/heads/${branch}`;
    if (await refExists(repo, remoteRef)) {
      const localAhead =
        (await refExists(repo, localRef)) &&
        (await gitRaw(["merge-base", "--is-ancestor", remoteRef, localRef], { cwd: repo })).exitCode === 0;
      if (localAhead) {
        // Branche locale orpheline contenant la distante (commits non poussés) : on la garde.
        await git(["worktree", "add", wtPath, branch], { cwd: repo });
        await git(["branch", "--set-upstream-to", `origin/${branch}`, branch], { cwd: repo });
      } else {
        await git(["worktree", "add", "--track", "-B", branch, wtPath, `origin/${branch}`], { cwd: repo });
      }
    } else {
      // -B : écrase une éventuelle branche locale orpheline (la branche distante a été supprimée = repartir de zéro).
      await git(["worktree", "add", "--no-track", "-B", branch, wtPath, `origin/${project.defaultBranch}`], {
        cwd: repo,
      });
    }
    await ensureToolDirExcluded(wtPath);
    return { reused: false };
  }

  async function prepareWorktree(project: ProjectConfig, wtPath: string, timeoutMs: number): Promise<void> {
    const repo = paths.repo(project.name);
    // Source des fichiers non versionnés : le checkout de l'utilisateur s'il est configuré, sinon le clone de référence.
    const source = project.localCheckout ? resolveHome(project.localCheckout) : repo;
    const cowDirs = project.cowDirs.map(normalizeRelDir).filter((d): d is string => d !== null);

    // (a) fichiers ignorés à copier.
    // La LISTE vient du `.worktreeinclude` versionné sur origin/<defaultBranch> (l'arbre de travail du clone de
    // référence n'est jamais mis à jour par fetch : il serait périmé), sinon de la config.
    // Les FICHIERS, eux, sont copiés depuis l'arbre de travail du clone de référence : c'est là que l'utilisateur
    // dépose ses fichiers non versionnés (.env, certificats…), comme le décrit l'installation.
    const included = await gitRaw(["show", `origin/${project.defaultBranch}:.worktreeinclude`], { cwd: repo });
    let patterns: string[];
    if (included.exitCode === 0) {
      patterns = included.stdout.split(/\r?\n/);
    } else {
      log.debug({ project: project.name }, "pas de .worktreeinclude sur la branche par défaut, liste de la config");
      patterns = project.worktreeInclude;
    }
    patterns = patterns.map((p) => p.trim()).filter((p) => p.length > 0 && !p.startsWith("#"));
    if (patterns.length > 0) {
      const tmp = await mkdtemp(join(tmpdir(), "sprintsaver-include-"));
      try {
        const patternFile = join(tmp, "patterns");
        await writeFile(patternFile, `${patterns.join("\n")}\n`);
        const out = await git(["ls-files", "--others", "--ignored", `--exclude-from=${patternFile}`, "-z"], {
          cwd: source,
        });
        const files = out
          .split("\0")
          .filter(Boolean)
          .filter((f) => !cowDirs.some((d) => f === d || f.startsWith(`${d}/`)));
        for (const f of files) {
          const src = join(source, f);
          const dst = join(wtPath, f);
          if (!isInside(source, src) || !isInside(wtPath, dst)) continue;
          await copyOne(src, dst);
        }
        log.debug({ wtPath, count: files.length }, "fichiers ignorés copiés dans le worktree");
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }

    // (b) dossiers lourds en copy-on-write
    for (const d of cowDirs) {
      const src = join(source, d);
      const dst = join(wtPath, d);
      if (!isInside(source, src) || !isInside(wtPath, dst)) {
        log.warn({ dir: d }, "cowDir hors du dépôt, ignoré");
        continue;
      }
      const st = await stat(src).catch(() => null);
      if (!st?.isDirectory()) continue;
      if (await exists(dst)) {
        log.debug({ dst }, "cowDir déjà présent dans le worktree, conservé");
        continue;
      }
      await mkdir(dirname(dst), { recursive: true });
      await cowCopyDir(src, dst);
    }

    // (c) setup
    if (project.setupCommand) {
      const res = await run(wtPath, project.setupCommand, timeoutMs);
      if (res.exitCode !== 0 || res.timedOut) {
        const why = res.timedOut ? `timeout après ${timeoutMs} ms` : `code ${res.exitCode}`;
        throw new ProjectCommandError("setup du projet", project.setupCommand, why, tail(res.output, 20_000));
      }
    }
  }

  async function removeWorktree(project: ProjectConfig, wtPath: string): Promise<void> {
    const repo = paths.repo(project.name);
    let branch = "";
    if (await exists(wtPath)) {
      branch = (await gitRaw(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: wtPath })).stdout.trim();
    }
    if (await exists(repo)) {
      const res = await gitRaw(["worktree", "remove", "--force", wtPath], { cwd: repo });
      if (res.exitCode !== 0) log.debug({ wtPath, stderr: res.stderr }, "git worktree remove a échoué, suppression manuelle");
    }
    await rm(wtPath, { recursive: true, force: true });
    if (!(await exists(repo))) return;
    await git(["worktree", "prune"], { cwd: repo });
    // Branche locale du clone de référence : supprimée seulement si tout est déjà sur le remote.
    if (branch && (await refExists(repo, `refs/remotes/origin/${branch}`))) {
      const pushed =
        (await gitRaw(["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`], { cwd: repo }))
          .exitCode === 0;
      if (pushed) await gitRaw(["branch", "-D", branch], { cwd: repo });
    }
  }

  async function createBaseWorktree(project: ProjectConfig, wtPath: string, basePath: string): Promise<void> {
    const repo = paths.repo(project.name);
    const base = (await git(["merge-base", `origin/${project.defaultBranch}`, "HEAD"], { cwd: wtPath })).trim();
    if (await exists(basePath)) await removeWorktree(project, basePath);
    await git(["worktree", "prune"], { cwd: repo });
    await mkdir(dirname(basePath), { recursive: true });
    await git(["worktree", "add", "--detach", basePath, base], { cwd: repo });
    await ensureToolDirExcluded(basePath);
  }

  async function createDetachedWorktree(project: ProjectConfig, wtPath: string): Promise<void> {
    const repo = paths.repo(project.name);
    if (!(await exists(repo))) await ensureReferenceClone(project);
    if (await exists(wtPath)) await removeWorktree(project, wtPath);
    await git(["worktree", "prune"], { cwd: repo });
    await mkdir(dirname(wtPath), { recursive: true });
    await git(["worktree", "add", "--detach", wtPath, `origin/${project.defaultBranch}`], { cwd: repo });
    await ensureToolDirExcluded(wtPath);
  }

  async function discardChanges(wtPath: string): Promise<void> {
    await git(["reset", "--hard", "-q", "HEAD"], { cwd: wtPath });
    // Sans -x : les fichiers ignorés (.sprintsaver/, dépendances, .env copiés) restent.
    await git(["clean", "-fdq"], { cwd: wtPath });
  }

  async function commitAll(wtPath: string, message: string): Promise<string | null> {
    await ensureToolDirExcluded(wtPath);
    await git(["add", "-A"], { cwd: wtPath });
    const staged = await gitRaw(["diff", "--cached", "--quiet"], { cwd: wtPath });
    if (staged.exitCode === 0) return null;
    if (staged.exitCode !== 1) throw new GitError(["diff", "--cached", "--quiet"], staged.exitCode, staged.stderr);
    const clean = stripCoAuthorTrailers(message);
    await git(["commit", "-m", clean], { cwd: wtPath, identity: true });
    return headSha(wtPath);
  }

  /**
   * Push forcé protégé : `--force-with-lease` seul ne protège plus après un `fetch` (la référence distante
   * suivie contient déjà le commit d'un tiers). `--force-if-includes` (git ≥ 2.30) exige en plus que le sommet
   * distant figure dans le reflog local, c.-à-d. qu'il ait été intégré par SprintSaver.
   */
  async function push(wtPath: string, branch: string, o?: { force?: boolean }): Promise<void> {
    const force = o?.force ? ["--force-with-lease", "--force-if-includes"] : [];
    const args = ["push", "-u", ...force, "origin", `HEAD:refs/heads/${branch}`];
    const res = await gitRaw(args, { cwd: wtPath, net: true });
    if (res.exitCode === 0) return;
    const out = `${res.stderr}\n${res.stdout}`;
    if (o?.force && /stale info|\(fetch first\)|rejected/i.test(out)) {
      throw new GitError(
        args,
        res.exitCode,
        `push forcé refusé : la branche distante ${branch} contient des commits que SprintSaver n'a pas intégrés ` +
          `(poussés par quelqu'un d'autre ?). Rien n'a été écrasé.\n${out}`,
      );
    }
    throw new GitError(args, res.exitCode, out);
  }

  async function headSha(wtPath: string): Promise<string> {
    return (await git(["rev-parse", "HEAD"], { cwd: wtPath })).trim();
  }

  async function diffAgainstBase(project: ProjectConfig, wtPath: string): Promise<string> {
    const base = (await git(["merge-base", `origin/${project.defaultBranch}`, "HEAD"], { cwd: wtPath })).trim();
    // Index temporaire : inclut les fichiers non suivis sans toucher à l'index réel du worktree.
    const tmp = await mkdtemp(join(tmpdir(), "sprintsaver-index-"));
    try {
      const tmpIndex = join(tmp, "index");
      const realIndex = await gitPath(wtPath, "index");
      if (await exists(realIndex)) await copyFile(realIndex, tmpIndex);
      const env = { GIT_INDEX_FILE: tmpIndex };
      await git(["add", "-A"], { cwd: wtPath, env });
      return await git(["diff", "--cached", "--no-color", "--no-ext-diff", base], { cwd: wtPath, env });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async function diffRange(wtPath: string, from: string, to: string): Promise<string> {
    return git(["diff", "--no-color", "--no-ext-diff", from, to], { cwd: wtPath });
  }

  async function isDirty(wtPath: string): Promise<boolean> {
    const out = await git(["status", "--porcelain"], { cwd: wtPath });
    return out.trim().length > 0;
  }

  async function rebaseOnDefault(project: ProjectConfig, wtPath: string): Promise<RebaseResult> {
    await git(["fetch", "--prune", "origin"], { cwd: wtPath, net: true });
    const args = ["rebase", `origin/${project.defaultBranch}`];
    const res = await gitRaw(args, { cwd: wtPath, identity: true });
    return rebaseOutcome(wtPath, res, args);
  }

  /**
   * Fichiers qui contiennent encore des marqueurs de conflit : fichiers en conflit (non fusionnés) et, plus
   * généralement, fichiers modifiés ou ajoutés par rapport à HEAD. Dans un fichier non fusionné, les trois
   * marqueurs comptent ; ailleurs, seuls `<<<<<<<` et `>>>>>>>` (une ligne `=======` seule peut être légitime,
   * ex. un titre souligné en Markdown ou en reStructuredText).
   */
  async function filesWithConflictMarkers(wtPath: string): Promise<string[]> {
    const unmerged = new Set(await conflictedFiles(wtPath));
    const changed = (await git(["diff", "--name-only", "-z", "HEAD"], { cwd: wtPath })).split("\0").filter(Boolean);
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: wtPath })).split("\0").filter(Boolean);
    const found: string[] = [];
    for (const f of [...new Set([...unmerged, ...changed, ...untracked])]) {
      const full = join(wtPath, f);
      if (!isInside(wtPath, full)) continue;
      const st = await lstat(full).catch(() => null);
      if (!st?.isFile() || st.size > MAX_MARKER_SCAN_BYTES) continue;
      const buf = await readFile(full);
      if (buf.includes(0)) continue; // binaire
      const re = unmerged.has(f) ? CONFLICT_MARKER_RE : CONFLICT_EDGE_MARKER_RE;
      if (re.test(buf.toString("utf8"))) found.push(f);
    }
    return found.sort();
  }

  async function rebaseContinue(wtPath: string): Promise<RebaseResult> {
    // Résolution incomplète : `add -A` marquerait comme résolus des fichiers qui contiennent encore des
    // marqueurs. Le rebase reste arrêté sur le même commit ; l'appelant compte une tentative ratée.
    const withMarkers = await filesWithConflictMarkers(wtPath);
    if (withMarkers.length > 0) {
      log.warn({ wtPath, files: withMarkers }, "marqueurs de conflit restants : rebase non continué");
      return { ok: false, conflictedFiles: withMarkers };
    }
    await git(["add", "-A"], { cwd: wtPath });
    // Conflit résolu en gardant l'amont : plus rien à appliquer pour ce commit. `--continue` échoue alors
    // (« No changes ») selon le backend : on saute le commit, puis on réinterprète (conflits suivants éventuels).
    const staged = await gitRaw(["diff", "--cached", "--quiet"], { cwd: wtPath });
    if (staged.exitCode !== 0 && staged.exitCode !== 1) {
      throw new GitError(["diff", "--cached", "--quiet"], staged.exitCode, staged.stderr);
    }
    const args =
      staged.exitCode === 0 && (await rebaseInProgress(wtPath))
        ? ["-c", "core.editor=true", "rebase", "--skip"]
        : ["-c", "core.editor=true", "rebase", "--continue"];
    const res = await gitRaw(args, { cwd: wtPath, identity: true });
    return rebaseOutcome(wtPath, res, args);
  }

  async function rebaseAbort(wtPath: string): Promise<void> {
    if (!(await rebaseInProgress(wtPath))) return;
    await git(["rebase", "--abort"], { cwd: wtPath });
  }

  return {
    ensureReferenceClone,
    remoteBranchExists,
    createOrReuseWorktree,
    prepareWorktree,
    removeWorktree,
    createBaseWorktree,
    createDetachedWorktree,
    discardChanges,
    commitAll,
    push,
    headSha,
    diffAgainstBase,
    diffRange,
    isDirty,
    rebaseOnDefault,
    rebaseContinue,
    rebaseAbort,
    run,
  };
}

// ---------------------------------------------------------------------------
// Exécution de commandes shell
// ---------------------------------------------------------------------------

/**
 * Exécute `command` dans un shell, dans son propre groupe de processus, pour pouvoir tuer tout l'arbre
 * (ex. `npm test` → node → workers) au timeout. Ne lève jamais pour un code de sortie ≠ 0.
 * `exitCode` vaut -1 si le processus a été tué par un signal.
 */
export async function run(wtPath: string, command: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  let timedOut = false;
  const sub = execa(command, {
    shell: true,
    cwd: wtPath,
    all: true,
    reject: false,
    detached: process.platform !== "win32",
    cleanup: true,
    stdin: "ignore",
    // Même environnement qu'à la vérification de `init` : sans les traces du gestionnaire de paquets qui a lancé SprintSaver.
    extendEnv: false,
    env: { ...projectCommandEnv(), CI: "true" },
  });
  const pid = sub.pid;
  // Groupe tué si SprintSaver quitte avant la fin de la commande (cf. process-groups.ts).
  const untrack = trackProcessGroup(pid);
  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    if (pid === undefined) return;
    killProcessGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => killProcessGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  }, timeoutMs);
  // Quand le shell se termine, on nettoie les processus d'arrière-plan restés dans le groupe
  // (sinon ils garderaient la sortie ouverte et bloqueraient l'attente).
  sub.nodeChildProcess.on("exit", () => {
    if (pid !== undefined && process.platform !== "win32") killProcessGroup(pid, "SIGTERM");
  });
  try {
    const res = await sub;
    return {
      exitCode: res.exitCode ?? -1,
      output: tail(String(res.all ?? ""), MAX_OUTPUT_CHARS),
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    untrack();
  }
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const target = resolve(p);
  return target === r || target.startsWith(r + sep);
}

/** "node_modules/" → "node_modules" ; refuse les chemins absolus ou remontants. */
function normalizeRelDir(d: string): string | null {
  const n = normalize(d.trim()).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!n || n === "." || isAbsolute(n) || n === ".." || n.startsWith("../")) return null;
  return n;
}

export function stripCoAuthorTrailers(message: string): string {
  return message
    .split("\n")
    .filter((l) => !/^\s*co-authored-by\s*:/i.test(l))
    .join("\n")
    .trimEnd();
}

/** Copie un fichier (clone COW si le FS le permet) ; recrée les liens symboliques tels quels. */
async function copyOne(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await rm(dst, { force: true });
    await symlink(await readlink(src), dst);
    return;
  }
  await copyFile(src, dst, fsConstants.COPYFILE_FICLONE);
}

/** Copie copy-on-write d'un dossier : `cp -c` (APFS), `cp --reflink=auto` (Linux), sinon copie classique. */
async function cowCopyDir(src: string, dst: string): Promise<void> {
  const attempts: string[][] =
    process.platform === "darwin"
      ? [["-c", "-R", src, dst]]
      : process.platform === "linux"
        ? [["-R", "--reflink=auto", src, dst]]
        : [];
  for (const args of attempts) {
    const res = await execa("cp", args, { reject: false, stdin: "ignore" });
    if (res.exitCode === 0) return;
    log.debug({ src, stderr: res.stderr }, "copie copy-on-write impossible, repli sur une copie classique");
    await rm(dst, { recursive: true, force: true });
  }
  const res = await execa("cp", ["-R", src, dst], { reject: false, stdin: "ignore" });
  if (res.exitCode !== 0) throw new Error(`copie de ${src} vers ${dst} échouée : ${res.stderr}`);
}

/** Développe `~` en tête de chemin. */
export function resolveHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
