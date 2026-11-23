/**
 * Garde-fou PreToolUse des sessions agent (ADR § 11).
 *
 * Les sessions tournent en `bypassPermissions` : ce hook est le seul garde-fou. Il refuse :
 * - sur `Bash` : toute commande git qui touche au réseau ou au remote, `git -C <ailleurs>`, `git commit`
 *   et `git rebase` dans le worktree (c'est l'orchestrateur qui commite et rebase), `glab`, les appels
 *   réseau (curl, wget, ssh…) vers GitLab, et les écritures/suppressions manifestement hors du worktree ;
 * - sur `Write` / `Edit` / `MultiEdit` / `NotebookEdit` : tout chemin résolu hors du worktree.
 * `/tmp` et `os.tmpdir()` sont autorisés, ainsi que les racines supplémentaires d'une phase (worktree « avant »
 * de la phase de captures d'écran).
 *
 * Les chemins sont vérifiés après résolution des liens symboliques (realpath du plus long préfixe existant) :
 * un lien du worktree qui pointe ailleurs ne permet pas d'écrire hors du worktree. Pour les suppressions et
 * déplacements (`rm`, `mv`, `find -delete`), c'est le lien lui-même qui est touché : seul son dossier parent
 * est résolu (sauf `chemin/` avec barre finale, qui traverse le lien).
 *
 * L'analyse shell est volontairement simple (pas un vrai parseur bash) : elle vise les erreurs et les
 * dérives du modèle, pas un adversaire (la défense contre l'injection de prompt est hors périmètre v1).
 *
 * LIMITE CONNUE — interpréteurs : le code passé à `python -c`, `node -e`, `ruby -e`, `perl -e`, un script
 * lancé (`python x.py`, `npm run …`), un Makefile, etc. n'est pas analysé : il peut écrire n'importe où ou
 * accéder au réseau. On ne tente pas de le parser (illusoire). Ce garde-fou n'est donc PAS une sandbox
 * (ADR § 11 : seul garde-fou en v1 ; sandbox reportée, cf. « Hors périmètre v1 »).
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { HookCallback, HookCallbackMatcher, HookEvent, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../log.js";

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const ALLOW: GuardDecision = { allow: true };
const PREFIX = "Refusé par le garde-fou SprintSaver : ";

function deny(reason: string): GuardDecision {
  return { allow: false, reason: PREFIX + reason };
}

// ---------------------------------------------------------------------------
// Chemins
// ---------------------------------------------------------------------------

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Chemin réel d'un chemin absolu qui n'existe peut-être pas encore : realpath du plus long préfixe existant,
 * suivi du reste tel quel. Un lien symbolique cassé est suivi vers sa cible (l'écriture la créerait).
 */
export function realpathLongestPrefix(abs: string, depth = 0): string {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const real = safeRealpath(cur);
    if (real !== null) return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    if (depth < 8) {
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          const target = resolve(dirname(cur), readlinkSync(cur));
          const resolvedTarget = realpathLongestPrefix(target, depth + 1);
          return rest.length > 0 ? join(resolvedTarget, ...rest.reverse()) : resolvedTarget;
        }
      } catch {
        // n'existe pas : on remonte
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.push(basename(cur));
    cur = parent;
  }
}

/**
 * Chemin réellement touché. `followLast` : l'opération traverse le dernier composant s'il s'agit d'un lien
 * (écriture, chmod…) ; sinon (rm, mv) c'est le lien lui-même qui est touché, seul le parent est résolu.
 */
function effectivePath(abs: string, followLast: boolean): string {
  if (followLast) return realpathLongestPrefix(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathLongestPrefix(parent), basename(abs));
}

/** Racines où l'écriture est autorisée : le worktree, les dossiers temporaires et les racines supplémentaires. */
function allowedRoots(worktreePath: string, extraRoots: string[] = []): string[] {
  const roots = new Set<string>();
  for (const r of [resolve(worktreePath), "/tmp", "/private/tmp", resolve(tmpdir()), ...extraRoots.map((e) => resolve(e))]) {
    roots.add(r);
    const real = safeRealpath(r);
    if (real) roots.add(real);
  }
  return [...roots];
}

function isInside(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isAllowedPath(abs: string, roots: string[]): boolean {
  return roots.some((r) => isInside(abs, r));
}

/** Le chemin est-il modifiable, liens symboliques résolus ? Retourne le chemin fautif, ou null. */
function forbiddenTarget(abs: string, roots: string[], followLast: boolean): string | null {
  const real = effectivePath(abs, followLast);
  if (!isAllowedPath(real, roots)) return real === abs ? abs : `${abs} (lien vers ${real})`;
  return null;
}

/**
 * Résout un chemin tel qu'écrit dans une commande. Retourne null si on ne peut pas le résoudre
 * (variable inconnue, cwd inconnu) : dans le doute, on n'interdit pas.
 */
function resolveShellPath(raw: string, cwd: string | null): string | null {
  let p = raw;
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  p = p.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b) as string;
    if (name === "HOME") return homedir();
    if (name === "PWD" && cwd) return cwd;
    return process.env[name] ?? m;
  });
  if (p.includes("$") || p.startsWith("~")) return null;
  if (isAbsolute(p)) return resolve(p);
  if (cwd === null) return null;
  return resolve(cwd, p);
}

// ---------------------------------------------------------------------------
// Découpage shell minimal
// ---------------------------------------------------------------------------

interface Segment {
  words: string[];
  /** Cibles de redirection en écriture (`>`, `>>`, `&>`). */
  redirects: string[];
}

/** Découpe une commande en segments simples (séparés par ; && || | & ( ) et retours à la ligne). */
export function parseShell(cmd: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let cur = "";
  let inWord = false;
  let pendingRedirect = false;

  const pushWord = (): void => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push(cur);
      pendingRedirect = false;
    } else {
      words.push(cur);
    }
    cur = "";
    inWord = false;
  };
  const endSegment = (): void => {
    pushWord();
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects });
    words = [];
    redirects = [];
    pendingRedirect = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    const next = cmd[i + 1];
    if (c === "\\") {
      if (next !== undefined && next !== "\n") {
        cur += next;
        inWord = true;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const j = end === -1 ? cmd.length : end;
      cur += cmd.slice(i + 1, j);
      inWord = true;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          cur += cmd[j + 1];
          j += 2;
          continue;
        }
        cur += cmd[j];
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = cmd.indexOf("\n", i);
      i = nl === -1 ? cmd.length : nl - 1;
      continue;
    }
    if (c === " " || c === "\t") {
      pushWord();
      continue;
    }
    if (c === ">" || (c === "&" && next === ">")) {
      // fd éventuel collé (2>) : on le jette.
      if (inWord && /^\d+$/.test(cur)) {
        cur = "";
        inWord = false;
      } else {
        pushWord();
      }
      let j = c === "&" ? i + 1 : i;
      if (cmd[j + 1] === ">") j++;
      if (cmd[j + 1] === "&") {
        // duplication de descripteur (2>&1) : pas de fichier cible.
        j++;
        while (j + 1 < cmd.length && /\d|-/.test(cmd[j + 1] as string)) j++;
      } else {
        pendingRedirect = true;
      }
      i = j;
      continue;
    }
    if (c === "<") {
      pushWord();
      // Redirection en lecture : on ignore la cible (lecture autorisée partout).
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      endSegment();
      if ((c === "|" || c === "&") && next === c) i++;
      continue;
    }
    if (c === "$" && next === "(") {
      endSegment();
      i++;
      continue;
    }
    cur += c;
    inWord = true;
  }
  endSegment();
  return segments;
}

/** Retire le corps des heredocs (`<<EOF ... EOF`) : c'est du contenu, pas des commandes. */
export function stripHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending = pending.slice(1);
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/(?<!<)<<-?\s*(['"]?)([\w.-]+)\1/g)) pending.push(m[2] as string);
  }
  return out.join("\n");
}

/** Contenus des substitutions de commande, y compris entre guillemets doubles. */
function commandSubstitutions(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/\$\(([^()]*)\)/g)) if (m[1]) out.push(m[1]);
  for (const m of cmd.matchAll(/`([^`]*)`/g)) if (m[1]) out.push(m[1]);
  return out;
}

const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time"]);

/** Retire mots-clés, affectations d'environnement et enveloppes (sudo, env, xargs…). */
function stripPrefixes(words: string[]): string[] {
  let w = words;
  for (;;) {
    const first = w[0];
    if (first === undefined) return w;
    if (SHELL_KEYWORDS.has(first) || /^[A-Za-z_]\w*=/.test(first)) {
      w = w.slice(1);
      continue;
    }
    const name = basename(first);
    if (["sudo", "env", "command", "exec", "nohup", "nice", "builtin"].includes(name)) {
      w = w.slice(1);
      while (w[0] !== undefined && (w[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(w[0]))) w = w.slice(1);
      continue;
    }
    if (name === "timeout") {
      w = w.slice(1);
      while (w[0] !== undefined && w[0].startsWith("-")) w = w.slice(1);
      w = w.slice(1); // durée
      continue;
    }
    if (name === "xargs") {
      w = w.slice(1);
      while (w[0] !== undefined && w[0].startsWith("-")) {
        const opt = w[0];
        w = w.slice(1);
        if (["-I", "-n", "-L", "-P", "-d", "-E", "-s"].includes(opt)) w = w.slice(1);
      }
      continue;
    }
    return w;
  }
}

/** Arguments non optionnels (après `--`, tout est argument). */
function positional(args: string[]): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Règles git
// ---------------------------------------------------------------------------

const GIT_NETWORK_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "remote", "ls-remote", "send-email"]);
const REMOTE_REF = /^(?:origin|upstream)\/|^refs\/remotes\/|@\{(?:u|upstream|push)\}/;
const REMOTE_CONFIG_KEY = /^(?:remote\.|url\.|credential|http\.|core\.sshcommand|branch\.[^.]+\.(?:remote|pushremote|merge))/i;
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"]);

function evaluateGit(args: string[], cwd: string | null, worktree: string, roots: string[]): GuardDecision {
  let gitCwd = cwd;
  let i = 0;
  // Options globales de git.
  while (i < args.length) {
    const a = args[i] as string;
    if (!a.startsWith("-")) break;
    if (a === "-C") {
      const target = args[i + 1];
      if (target === undefined) break;
      gitCwd = gitCwd === null && !isAbsolute(target) ? null : resolveShellPath(target, gitCwd);
      i += 2;
      continue;
    }
    if (a === "-c") {
      const kv = args[i + 1] ?? "";
      if (REMOTE_CONFIG_KEY.test(kv)) {
        return deny(`\`git -c ${kv}\` modifie la configuration d'un remote. Le remote est géré par l'orchestrateur.`);
      }
      i += 2;
      continue;
    }
    const m = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(a);
    if (m) {
      const value = m[2] ?? args[i + 1];
      if (value !== undefined) {
        const abs = resolveShellPath(value, gitCwd);
        if (abs !== null && !isAllowedPath(abs, roots)) {
          return deny(`\`git --${m[1]} ${value}\` vise un dépôt hors du worktree (${worktree}). Travaille uniquement dans le worktree.`);
        }
      }
      i += m[2] === undefined ? 2 : 1;
      continue;
    }
    i++;
  }

  if (gitCwd !== null && !isAllowedPath(gitCwd, roots)) {
    return deny(`git est lancé sur ${gitCwd}, hors du worktree (${worktree}). Travaille uniquement dans le worktree.`);
  }

  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return ALLOW;
  const inWorktree = gitCwd === null || isInside(gitCwd, resolve(worktree)) || isInside(gitCwd, safeRealpath(worktree) ?? resolve(worktree));

  if (GIT_NETWORK_SUBCOMMANDS.has(sub)) {
    return deny(
      `\`git ${sub}\` touche au remote ou au réseau. Seul l'orchestrateur communique avec le remote (fetch, push). Travaille sur l'état local du worktree.`,
    );
  }
  if (sub === "submodule" && !["status", "summary", undefined].includes(positional(rest)[0])) {
    return deny("`git submodule` (hors status/summary) peut accéder au réseau. Utilise l'état local.");
  }
  if (sub === "lfs" && ["push", "pull", "fetch", "clone"].includes(positional(rest)[0] ?? "")) {
    return deny("`git lfs` en accès réseau est interdit.");
  }
  if (sub === "archive" && rest.some((a) => a.startsWith("--remote"))) {
    return deny("`git archive --remote` accède au réseau.");
  }
  if (sub === "config") {
    const readOnly = rest.some((a) => CONFIG_READ_FLAGS.has(a)) || ["get", "list"].includes(rest[0] ?? "");
    if (!readOnly) {
      if (rest.some((a) => a === "--global" || a === "--system")) {
        return deny("modifier la configuration git globale ou système est interdit (écriture hors du worktree).");
      }
      const key = positional(rest).find((a) => REMOTE_CONFIG_KEY.test(a));
      if (key) return deny(`\`git config ${key}\` modifie la configuration d'un remote. Le remote est géré par l'orchestrateur.`);
    }
  }
  if (sub === "branch" && rest.some((a) => a === "-u" || a.startsWith("--set-upstream") || a === "--unset-upstream")) {
    return deny("modifier la branche amont (upstream) est interdit : le suivi du remote est géré par l'orchestrateur.");
  }
  if (sub === "worktree" && positional(rest)[0] !== "list") {
    return deny("`git worktree` (hors list) est interdit : les worktrees sont gérés par l'orchestrateur.");
  }
  if ((sub === "reset" || sub === "merge") && rest.some((a) => REMOTE_REF.test(a))) {
    return deny(
      `\`git ${sub}\` vers une branche distante est interdit : la synchronisation avec la branche par défaut est faite par l'orchestrateur.`,
    );
  }
  if (inWorktree && sub === "rebase") {
    return deny("`git rebase` est interdit : le rebase est piloté par l'orchestrateur. Résous seulement les fichiers demandés.");
  }
  if (inWorktree && sub === "commit") {
    return deny("`git commit` est interdit : l'orchestrateur commite lui-même à la fin de la phase. Laisse tes modifications dans l'arbre de travail.");
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Règles Bash
// ---------------------------------------------------------------------------

const NETWORK_TOOLS = new Set(["curl", "wget", "http", "https", "xh", "httpie", "ssh", "scp", "sftp", "nc", "ncat", "telnet"]);
/** Commandes qui écrivent ou suppriment chacun de leurs arguments. */
const WRITE_ALL_ARGS = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "chmod", "chown", "chgrp", "touch", "mkdir", "tee", "mv"]);
/** Commandes dont seule la destination (dernier argument, ou `-t <dossier>`) est écrite. */
const WRITE_LAST_ARG = new Set(["cp", "ln", "install", "rsync"]);
/** Commandes qui acceptent `-t <dossier>` / `--target-directory` (rsync : -t = conserver les dates). */
const TARGET_DIR_COMMANDS = new Set(["cp", "mv", "ln", "install"]);
/** Commandes qui touchent le lien lui-même, pas sa cible. */
const NO_FOLLOW_COMMANDS = new Set(["rm", "rmdir", "unlink", "mv", "find"]);

/** Valeur de `-t <dir>`, `-t<dir>`, `--target-directory=<dir>` ou `--target-directory <dir>`. */
export function targetDirectoryOption(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    if (a === "-t" || a === "--target-directory") return args[i + 1];
    if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
    if (/^-t./.test(a)) return a.slice(2);
  }
  return undefined;
}
const SAFE_REDIRECTS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function outsideMessage(cmd: string, target: string, worktree: string): GuardDecision {
  return deny(`\`${cmd}\` écrirait ou supprimerait ${target}, hors du worktree (${worktree}). Seuls le worktree, /tmp et le dossier temporaire du système sont modifiables.`);
}

function evaluateBash(fullCommand: string, worktree: string, roots: string[], depth = 0): GuardDecision {
  if (depth > 4) return ALLOW;
  const command = stripHeredocs(fullCommand);

  // Filet : formes directes de git réseau, même dans des constructions que le découpage rate.
  const raw = /\bgit\s+(?:-[-\w.]+(?:[ =][^\s;&|]+)?\s+)*(push|pull|fetch|clone|ls-remote)\b/.exec(command);
  if (raw) {
    return deny(`\`git ${raw[1]}\` touche au remote ou au réseau. Seul l'orchestrateur communique avec le remote (fetch, push).`);
  }

  for (const sub of commandSubstitutions(command)) {
    const d = evaluateBash(sub, worktree, roots, depth + 1);
    if (!d.allow) return d;
  }

  let cwd: string | null = resolve(worktree);
  for (const seg of parseShell(command)) {
    for (const r of seg.redirects) {
      if (SAFE_REDIRECTS.has(r)) continue;
      const abs = resolveShellPath(r, cwd);
      const bad = abs === null ? null : forbiddenTarget(abs, roots, true);
      if (bad !== null) return outsideMessage(`> ${r}`, bad, worktree);
    }

    const words = stripPrefixes(seg.words);
    const head = words[0];
    if (head === undefined) continue;
    const name = basename(head);
    const args = words.slice(1);

    if (name === "cd" || name === "pushd") {
      const target = positional(args)[0] ?? "~";
      cwd = target === "-" ? null : resolveShellPath(target, cwd);
      continue;
    }
    if ((name === "sh" || name === "bash" || name === "zsh" || name === "dash") && args.includes("-c")) {
      const script = args[args.indexOf("-c") + 1];
      if (script !== undefined) {
        const d = evaluateBash(script, worktree, roots, depth + 1);
        if (!d.allow) return d;
      }
      continue;
    }
    if (name === "eval") {
      const d = evaluateBash(args.join(" "), worktree, roots, depth + 1);
      if (!d.allow) return d;
      continue;
    }
    if (name === "git") {
      const d = evaluateGit(args, cwd, worktree, roots);
      if (!d.allow) return d;
      continue;
    }
    if (name === "glab") {
      return deny("`glab` est interdit : les sessions ont un accès GitLab en lecture seule via les outils MCP `gitlab` (search_issues, get_issue, get_issue_closing_mrs, get_mr_diff).");
    }
    if (NETWORK_TOOLS.has(name) && args.some((a) => /gitlab/i.test(a))) {
      return deny(`\`${name}\` vers GitLab est interdit : utilise les outils MCP \`gitlab\` en lecture seule. Seul l'orchestrateur écrit sur GitLab.`);
    }

    let targets: string[] = [];
    const targetDir = TARGET_DIR_COMMANDS.has(name) ? targetDirectoryOption(args) : undefined;
    if (name === "mv" && targetDir !== undefined) targets = [...positional(args), targetDir];
    else if (WRITE_ALL_ARGS.has(name)) targets = positional(args);
    else if (targetDir !== undefined) targets = [targetDir];
    else if (name === "install" && args.some((a) => a === "-d" || a === "--directory")) targets = positional(args);
    else if (WRITE_LAST_ARG.has(name)) targets = positional(args).slice(-1);
    else if (name === "dd") targets = args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    else if (name === "find" && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir")) {
      const idx = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
      targets = idx === -1 ? args : args.slice(0, idx);
    } else if (name === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"))) {
      const pos = positional(args);
      const hasScriptOpt = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file"));
      targets = hasScriptOpt ? pos : pos.slice(1);
    }
    for (const t of targets) {
      const abs = resolveShellPath(t, cwd);
      if (abs === null) continue;
      // `rm lien` supprime le lien ; `rm -r lien/` (barre finale) traverse le lien ; `mv -t dossier` écrit dedans.
      const followLast = !NO_FOLLOW_COMMANDS.has(name) || t.endsWith("/") || t === targetDir;
      const bad = forbiddenTarget(abs, roots, followLast);
      if (bad !== null) return outsideMessage(name, bad, worktree);
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Point d'entrée pur
// ---------------------------------------------------------------------------

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Décide si un appel d'outil est autorisé. Pure (hors lecture de os.tmpdir / realpath des racines).
 * Les outils non listés (Read, Grep, MCP…) sont toujours autorisés.
 */
export function evaluateToolCall(
  toolName: string,
  input: unknown,
  worktreePath: string,
  extraRoots: string[] = [],
): GuardDecision {
  const roots = allowedRoots(worktreePath, extraRoots);
  const obj = (input ?? {}) as Record<string, unknown>;

  if (toolName === "Bash") {
    const command = obj.command;
    if (typeof command !== "string") return ALLOW;
    return evaluateBash(command, worktreePath, roots);
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const p = obj.file_path ?? obj.notebook_path;
    if (typeof p !== "string" || p.length === 0) return ALLOW;
    const abs = isAbsolute(p) ? resolve(p) : resolve(worktreePath, p);
    const bad = forbiddenTarget(abs, roots, true);
    if (bad !== null) {
      return deny(`${toolName} sur ${bad} est hors du worktree (${worktreePath}). Seuls le worktree, /tmp et le dossier temporaire du système sont modifiables.`);
    }
    return ALLOW;
  }

  return ALLOW;
}

// ---------------------------------------------------------------------------
// Hook SDK
// ---------------------------------------------------------------------------

/** Callback PreToolUse : renvoie `permissionDecision: "deny"` avec une raison lisible par le modèle. */
export function createGuardCallback(worktreePath: string, extraRoots: string[] = []): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let decision: GuardDecision;
    try {
      decision = evaluateToolCall(input.tool_name, input.tool_input, worktreePath, extraRoots);
    } catch (err) {
      decision = deny(`erreur interne du garde-fou (${(err as Error).message}). Reformule la commande plus simplement.`);
    }
    if (decision.allow) return {};
    log.warn({ tool: input.tool_name, input: input.tool_input, reason: decision.reason }, "garde-fou : appel d'outil refusé");
    const out: SyncHookJSONOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    };
    return out;
  };
}

/** Hooks à passer tels quels dans `Options.hooks`. */
export function createGuardHooks(
  worktreePath: string,
  extraRoots: string[] = [],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ hooks: [createGuardCallback(worktreePath, extraRoots)], onFailure: "block" }],
  };
}
