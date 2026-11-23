import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config/load.js";
import { paths } from "../config/paths.js";
import { runAgentSmokeTest } from "../app.js";
import type { Config } from "../config/schema.js";
import { glabToken, glabVersion, hostOf, type TokenProvider } from "../gitlab/glab-auth.js";
import { checkProjectAccess, getUserDetails, InvalidTokenError } from "../gitlab/discovery.js";
import { createGitLabRest, type GitLabRest } from "../gitlab/rest.js";
import { errorMessage } from "../engine/util.js";
import { resolveClaudeExecutable } from "../agent/claude-path.js";
import { resolveHome } from "../git/gitops.js";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

type Level = "ok" | "warn" | "fail";
const ICON: Record<Level, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };

/** "git version 2.43.0" → [2, 43]. */
export function parseGitVersion(v: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

async function version(cmd: string): Promise<string> {
  const { stdout } = await exec(cmd, ["--version"], { timeout: 30_000 });
  return stdout.trim().split("\n")[0] ?? "";
}

export interface DoctorLine {
  level: Level;
  msg: string;
}

/**
 * Contrôle de la connexion GitLab, qui est celle de glab (ADR, amendements 1 et 2).
 * - glab connecté à l'hôte configuré (sinon rien d'autre n'est vérifié).
 * - Utilisateur : un Personal Access Token doit appartenir à l'utilisateur de la config ; un jeton de projet (bot)
 *   n'est pas comparé, puisque `gitlab.username` désigne l'humain à qui les MR sont assignées.
 * - Chaque projet suivi : accessible avec cette connexion, et scope `api` présent.
 */
export async function checkGitLabConnection(
  config: Config,
  token: TokenProvider = glabToken(hostOf(config.gitlab.url)),
  makeRest: (token: TokenProvider) => GitLabRest = (t) => createGitLabRest(config.gitlab.url, t),
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  try {
    await token.get();
    lines.push({ level: "ok", msg: `${token.label} : connecté` });
  } catch (err) {
    lines.push({ level: "fail", msg: errorMessage(err) });
    return lines;
  }
  const rest = makeRest(token);

  try {
    const id = await getUserDetails(rest);
    if (id.kind === "project") {
      lines.push({ level: "ok", msg: `glab utilise un jeton de projet (bot) : utilisateur non comparé, MR assignées à @${config.gitlab.username}` });
    } else if (id.user.username !== config.gitlab.username || id.user.id !== config.gitlab.userId) {
      lines.push({
        level: "warn",
        msg: `glab est connecté en tant que ${id.user.username} (id ${id.user.id}), différent de la config (${config.gitlab.username}, id ${config.gitlab.userId})`,
      });
    } else {
      lines.push({ level: "ok", msg: `glab est connecté en tant que @${id.user.username}` });
    }
  } catch (err) {
    lines.push({ level: "fail", msg: err instanceof InvalidTokenError ? err.message : `GitLab injoignable : ${errorMessage(err)}` });
    return lines;
  }

  for (const p of config.projects) {
    try {
      const check = await checkProjectAccess(rest, p.id);
      if (!check.accessible) {
        lines.push({ level: "fail", msg: `${p.name} : projet ${p.path} inaccessible avec la connexion glab (HTTP ${check.status ?? "?"})` });
      } else if (check.scopes && !check.scopes.includes("api")) {
        lines.push({ level: "fail", msg: `${p.name} : le jeton glab n'a pas le scope « api » (scopes : ${check.scopes.join(", ") || "aucun"})` });
      } else if (!check.scopes) {
        lines.push({ level: "warn", msg: `${p.name} : projet accessible, scope « api » non vérifiable (connexion OAuth ?)` });
      } else {
        lines.push({ level: "ok", msg: `${p.name} : projet accessible, scope « api » présent` });
      }
    } catch (err) {
      lines.push({ level: "fail", msg: `${p.name} : GitLab injoignable : ${errorMessage(err)}` });
    }
  }
  return lines;
}

export async function doctorCommand(opts: { smoke?: boolean } = {}): Promise<void> {
  let failed = false;
  const report = (level: Level, msg: string) => {
    if (level === "fail") failed = true;
    console.log(`${ICON[level]} ${msg}`);
  };

  // 1. Config (une ConfigError remonte jusqu'à index.ts, qui l'affiche proprement).
  const config = await loadConfig();
  report("ok", `config valide (${paths.config()}), ${config.projects.length} projet(s) : ${config.projects.map((p) => p.name).join(", ") || "aucun"}`);

  // 2. git
  try {
    const v = await version("git");
    const parsed = parseGitVersion(v);
    if (parsed && (parsed[0] < 2 || (parsed[0] === 2 && parsed[1] < 30))) {
      report("fail", `${v} : git ≥ 2.30 requis (push --force-if-includes)`);
    } else {
      report("ok", v);
    }
  } catch (err) {
    report("fail", `git introuvable : ${errorMessage(err)}`);
  }

  // 3. glab, puis connexion GitLab et projets
  const glab = await glabVersion();
  if (!glab) {
    report("fail", "glab introuvable : installe la CLI GitLab (`brew install glab`), puis `glab auth login`");
  } else {
    report("ok", glab);
    for (const line of await checkGitLabConnection(config)) report(line.level, line.msg);
  }

  // 4. Claude Code
  try {
    const bin = resolveClaudeExecutable();
    report("ok", `claude ${await version(bin)} (${bin})`);
  } catch (err) {
    report("fail", `CLI claude introuvable (installez Claude Code et connectez-vous) : ${errorMessage(err)}`);
  }

  // 4b. Checkouts locaux déclarés
  for (const p of config.projects) {
    if (p.localCheckout && !existsSync(resolveHome(p.localCheckout))) {
      report("warn", `${p.name} : localCheckout introuvable (${p.localCheckout}), les fichiers non versionnés ne seront pas copiés`);
    }
  }

  // 5. Pas de clé API (ADR § 2)
  if (process.env.ANTHROPIC_API_KEY) {
    report("warn", "ANTHROPIC_API_KEY est défini : SprintSaver doit utiliser le login Claude Code, retirez cette variable");
  } else {
    report("ok", "ANTHROPIC_API_KEY non défini");
  }

  // 6. Session agent de test
  if (opts.smoke) {
    const dir = await mkdtemp(join(tmpdir(), "sprintsaver-smoke-"));
    try {
      const res = await runAgentSmokeTest(dir);
      report("ok", `session agent de test réussie${res === undefined ? "" : ` : ${typeof res === "string" ? res : JSON.stringify(res)}`}`);
    } catch (err) {
      report("fail", `session agent de test en échec : ${errorMessage(err)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (failed) process.exitCode = 1;
}
