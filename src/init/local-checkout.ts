/**
 * Recherche bornée d'un checkout local d'un dépôt GitLab, pour `init` (ADR, amendement 5).
 *
 * Le checkout de l'utilisateur sert de source aux fichiers ignorés (.env…) et aux dossiers de dépendances copiés
 * dans chaque worktree. On parcourt quelques dossiers usuels du dossier personnel, en profondeur limitée, avec un
 * plafond de dossiers visités et de durée, sans suivre les liens symboliques. Un dépôt est retenu si l'un de ses
 * remotes désigne le projet. Les remotes sont lus dans la config git (aucun processus git n'est lancé).
 */
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import { projectCommandEnv } from "../process-env.js";

/** Dossiers jamais parcourus (dépendances, sorties de build, bibliothèques système). */
const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "Library",
  "Applications",
  "Pictures",
  "Music",
  "Movies",
  "target",
  "build",
  "dist",
  "out",
  "bin",
  "obj",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  "site-packages",
]);

/** Dossiers usuels de code sous le dossier personnel. `SPRINTSAVER_CHECKOUT_ROOTS` (séparés par `:`) les remplace. */
export function defaultCheckoutRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = env.SPRINTSAVER_CHECKOUT_ROOTS?.split(delimiter).map((s) => s.trim()).filter(Boolean);
  if (fromEnv?.length) return fromEnv.map((r) => (r.startsWith("~/") ? join(home, r.slice(2)) : resolve(r)));
  return [
    "code",
    "Code",
    "dev",
    "Dev",
    "Developer",
    "src",
    "projects",
    "Projects",
    "workspace",
    "Workspace",
    "work",
    "git",
    "repos",
    "Documents",
    "Desktop",
  ].map((d) => join(home, d)).concat(home);
}

/**
 * Forme comparable d'une URL de remote : `hôte/chemin` en minuscules, sans `.git`, sans utilisateur ni port.
 * Accepte https://, ssh://, git@hôte:chemin, file:// et un chemin absolu (remote local).
 */
export function normalizeRemote(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    host = parsed.protocol === "file:" ? "file" : parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else if (u.startsWith("/")) {
    // Remote local (git clone d'un chemin) : même forme qu'une URL file://.
    host = "file";
    path = u;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

/** Deux remotes désignent-ils le même projet ? Même hôte et même chemin (ou l'un suffixe de l'autre : instance sous un sous-chemin). */
export function sameRemote(a: string, b: string): boolean {
  const na = normalizeRemote(a);
  const nb = normalizeRemote(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [ha, ...pa] = na.split("/");
  const [hb, ...pb] = nb.split("/");
  if (ha !== hb) return false;
  const sa = pa.join("/");
  const sb = pb.join("/");
  return sa.endsWith(`/${sb}`) || sb.endsWith(`/${sa}`);
}

/** URLs des remotes d'un dépôt, lues dans sa config git (dépôt classique ou worktree). [] si ce n'est pas un dépôt. */
export async function readGitRemotes(dir: string): Promise<string[]> {
  const dotGit = join(dir, ".git");
  let gitDir: string;
  try {
    const st = await stat(dotGit);
    if (st.isDirectory()) gitDir = dotGit;
    else {
      const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
      if (!m) return [];
      gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(dir, m[1]!.trim());
      try {
        const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
        gitDir = isAbsolute(common) ? common : resolve(gitDir, common);
      } catch {
        // pas un worktree lié : la config est dans gitDir
      }
    }
  } catch {
    return [];
  }
  let config: string;
  try {
    config = await readFile(join(gitDir, "config"), "utf8");
  } catch {
    return [];
  }
  const urls: string[] = [];
  let inRemote = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inRemote = /^remote\s+"/.test(section[1]!.trim());
      continue;
    }
    if (!inRemote) continue;
    const kv = /^\s*(url|pushurl)\s*=\s*(.+?)\s*$/i.exec(line);
    if (kv) urls.push(kv[2]!.replace(/^"|"$/g, ""));
  }
  return urls;
}

/** Le dossier est-il un checkout (racine de dépôt) du projet ? */
export async function isCheckoutOf(dir: string, projectUrl: string): Promise<boolean> {
  return (await readGitRemotes(dir)).some((u) => sameRemote(u, projectUrl));
}

export interface CheckoutSearch {
  matches: string[];
  roots: string[];
  scanned: number;
  /** Recherche arrêtée par un plafond (dossiers ou durée) : un checkout plus profond a pu échapper. */
  truncated: boolean;
}

export interface CheckoutSearchOptions {
  roots?: string[];
  /** Profondeur max sous chaque racine (défaut 4). */
  maxDepth?: number;
  /** Plafond de dossiers visités (défaut 20 000). */
  maxDirs?: number;
  /** Durée max (défaut 8 s). */
  timeBudgetMs?: number;
  /** Dossiers exclus (ex. le clone de référence de SprintSaver). */
  exclude?: string[];
  now?: () => number;
}

/** Cherche les checkouts du projet sous les racines données (parcours en largeur, borné). */
export async function findLocalCheckouts(projectUrl: string, opts: CheckoutSearchOptions = {}): Promise<CheckoutSearch> {
  const roots = opts.roots ?? defaultCheckoutRoots();
  const maxDepth = opts.maxDepth ?? 4;
  const maxDirs = opts.maxDirs ?? 20_000;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeBudgetMs ?? 8_000);
  const exclude = new Set<string>();
  for (const e of opts.exclude ?? []) exclude.add(await realpath(e).catch(() => resolve(e)));

  const seen = new Set<string>();
  const matches: string[] = [];
  let scanned = 0;
  let truncated = false;
  const queue: { dir: string; depth: number }[] = [];
  for (const r of roots) queue.push({ dir: r, depth: 0 });

  while (queue.length > 0) {
    if (scanned >= maxDirs || now() > deadline) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift()!;
    const real = await realpath(dir).catch(() => null);
    if (!real || seen.has(real) || exclude.has(real)) continue;
    seen.add(real);
    scanned++;
    const st = await lstat(dir).catch(() => null);
    if (!st || (!st.isDirectory() && !(depth === 0 && st.isSymbolicLink()))) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === ".git")) {
      if (await isCheckoutOf(dir, projectUrl)) matches.push(real);
      continue; // on ne descend pas dans un dépôt (sous-modules, dépendances)
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return { matches, roots, scanned, truncated };
}

// ---------------------------------------------------------------------------
// Fichiers ignorés du checkout local (noms seulement)
// ---------------------------------------------------------------------------

/**
 * Dossiers et fichiers ignorés qui ne sont ni de la config ni des secrets : dépendances, sorties de build, caches,
 * réglages d'éditeur. Ils relèvent des `cowDirs` ou de rien du tout.
 */
const NOT_CONFIG_SEGMENTS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  "out",
  "bin",
  "obj",
  "vendor",
  "coverage",
  "tmp",
  "temp",
  "log",
  "logs",
  "Pods",
  "DerivedData",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".angular",
  ".dart_tool",
  ".gradle",
  ".m2",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".terraform",
  ".idea",
  ".vscode",
  ".sprintsaver",
  ".DS_Store",
]);
const NOT_CONFIG_FILE_RE = /\.(log|pyc|pyo|class|o|so|dylib|dll|exe|tsbuildinfo|swp|lock)$|\.egg-info\/?$/i;

/** Marque d'un fichier d'exemple versionné : `.env.example`, `config.sample.json`, `settings.py.template`, `.env-dist`… */
const EXAMPLE_TOKEN_RE = /[.\-_](example|sample|template|dist|tpl)(?=\.|$)/i;

/** Pendant attendu d'un fichier d'exemple (`.env.example` → `.env`), ou null si ce n'en est pas un. */
export function exampleCounterpart(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  if (!EXAMPLE_TOKEN_RE.test(name)) return null;
  const real = name.replace(EXAMPLE_TOKEN_RE, "");
  return real && real !== name ? `${dir}${real}` : null;
}

export function isDependencyOrBuildPath(entry: string): boolean {
  const segments = entry.replace(/\/+$/, "").split("/");
  return segments.some((s) => NOT_CONFIG_SEGMENTS.has(s)) || NOT_CONFIG_FILE_RE.test(entry);
}

export interface IgnoredListing {
  /** Fichiers (et dossiers entièrement ignorés, terminés par `/`) candidats à `worktreeInclude`. */
  entries: string[];
  /** Entrées écartées : dépendances, build, caches. */
  excluded: number;
  /** Liste coupée à `maxEntries`. */
  truncated: boolean;
  /** Pendants ignorés présents de fichiers d'exemple versionnés : [pendant, exemple]. */
  examplePairs: [string, string][];
}

export type GitListFn = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultGitList: GitListFn = async (cwd, args) => {
  const res = await execa("git", args, { cwd, reject: false, stdin: "ignore", extendEnv: false, env: projectCommandEnv() });
  return { code: res.exitCode ?? -1, stdout: String(res.stdout), stderr: String(res.stderr) };
};

/** Au-delà, un dossier qui ne contient que des fichiers ignorés reste listé comme dossier. */
const MAX_EXPANDED = 2_000;

/**
 * Fichiers ignorés par git présents dans le checkout (`git ls-files --others --ignored --directory`), sans les
 * dépendances ni les sorties de build. Seuls les NOMS sont lus, jamais le contenu. Un dossier entièrement ignoré
 * reste une entrée (`certs/`) ; un dossier qui ne contient que des fichiers ignorés sans l'être lui-même (`apps/`
 * sans fichier suivi) est développé. Les pendants ignorés de fichiers d'exemple versionnés (`.env` pour
 * `.env.example`) sont signalés à part.
 */
export async function listIgnoredFiles(checkout: string, opts: { maxEntries?: number; git?: GitListFn } = {}): Promise<IgnoredListing> {
  const run = opts.git ?? defaultGitList;
  const git = async (args: string[]): Promise<string[]> => {
    const res = await run(checkout, args);
    if (res.code !== 0) throw new Error(`git ${args.join(" ")} : ${res.stderr.trim() || `code ${res.code}`}`);
    return res.stdout.split("\0").filter(Boolean);
  };
  const maxEntries = opts.maxEntries ?? 150;
  const LIST = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
  const ignored: string[] = [];
  for (const entry of await git([...LIST, "--directory", "--no-empty-directory"])) {
    if (!entry.endsWith("/") || isDependencyOrBuildPath(entry)) {
      ignored.push(entry);
      continue;
    }
    // Dossier ignoré en entier : une entrée. Sinon (il ne contient que des fichiers ignorés), on le développe.
    const wholeDirIgnored = (await run(checkout, ["check-ignore", "-q", "--no-index", entry])).code === 0;
    const files = wholeDirIgnored ? [] : await git([...LIST, "--", entry]);
    if (wholeDirIgnored || files.length === 0 || files.length > MAX_EXPANDED) ignored.push(entry);
    else ignored.push(...files);
  }
  const tracked = await git(["ls-files", "-z"]);
  const kept = ignored.filter((e) => !isDependencyOrBuildPath(e)).sort();
  const present = new Set(ignored);
  const examplePairs: [string, string][] = [];
  for (const t of tracked) {
    const counterpart = exampleCounterpart(t);
    if (counterpart && present.has(counterpart)) examplePairs.push([counterpart, t]);
  }
  return {
    entries: kept.slice(0, maxEntries),
    excluded: ignored.length - kept.length,
    truncated: kept.length > maxEntries,
    examplePairs,
  };
}
