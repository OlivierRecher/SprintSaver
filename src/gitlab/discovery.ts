/**
 * Découverte GitLab pour `sprintsaver init` : projets, fichiers du dépôt, détection de stack,
 * source CI, statuts natifs, labels. Les fonctions de détection sont pures (testables sans réseau).
 */
import { log } from "../log.js";
import { listAllowedStatuses, type NativeStatus } from "./graphql.js";
import { GitLabHttpError, pid, type GitLabRest } from "./rest.js";

export { listAllowedStatuses, type NativeStatus };

// ---------------------------------------------------------------------------
// Utilisateur / projets / labels
// ---------------------------------------------------------------------------

export interface UserDetails {
  id: number;
  username: string;
  name: string;
  /** commit_email, sinon public_email (peut être vide). */
  email?: string;
}

/**
 * Identité portée par le jeton (ADR, amendement 1) :
 * - `personal` : Personal Access Token, `GET /user` renvoie son propriétaire ;
 * - `project` : Project Access Token. Son utilisateur est un bot : `GET /user` répond 404 ou 403 (ou renvoie un
 *   compte marqué `bot`). L'humain à qui assigner les MR doit alors être demandé à l'utilisateur.
 */
export type TokenIdentity = { kind: "personal"; user: UserDetails } | { kind: "project" };

/** Jeton refusé par GitLab (401) : invalide, expiré ou révoqué. */
export class InvalidTokenError extends Error {
  constructor() {
    super(
      "Jeton GitLab refusé (HTTP 401) : il est invalide, expiré ou révoqué. " +
        "Crée un Personal Access Token ou un Project Access Token avec le scope « api », puis relance `sprintsaver init`.",
    );
    this.name = "InvalidTokenError";
  }
}

export async function getUserDetails(rest: GitLabRest): Promise<TokenIdentity> {
  let u: {
    id: number;
    username: string;
    name: string;
    bot?: boolean;
    commit_email?: string | null;
    public_email?: string | null;
  };
  try {
    u = await rest.get("/user");
  } catch (err) {
    if (err instanceof GitLabHttpError) {
      if (err.status === 401) throw new InvalidTokenError();
      if (err.status === 404 || err.status === 403) return { kind: "project" };
    }
    throw err;
  }
  if (u.bot === true) return { kind: "project" };
  const email = u.commit_email || u.public_email || undefined;
  return { kind: "personal", user: { id: u.id, username: u.username, name: u.name, email } };
}

/** La recherche d'utilisateurs (`GET /users`) est refusée par l'instance. */
export class UserLookupUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`Recherche d'utilisateurs refusée par l'instance GitLab (GET /users → HTTP ${status}).`);
    this.name = "UserLookupUnavailableError";
  }
}

/**
 * Résout un utilisateur humain par son username (`GET /users?username=`). `null` s'il n'existe pas.
 * Un 401 signale un jeton invalide.
 */
export async function findUserByUsername(rest: GitLabRest, username: string): Promise<UserDetails | null> {
  const wanted = username.trim().replace(/^@/, "");
  if (!wanted) return null;
  let users: { id: number; username: string; name: string; public_email?: string | null }[];
  try {
    users = await rest.get("/users", { username: wanted });
  } catch (err) {
    if (err instanceof GitLabHttpError && err.status === 401) throw new InvalidTokenError();
    // Certaines instances restreignent la recherche d'utilisateurs : l'appelant demandera l'id directement.
    if (err instanceof GitLabHttpError && (err.status === 403 || err.status === 404)) throw new UserLookupUnavailableError(err.status);
    throw err;
  }
  const u = users.find((x) => x.username.toLowerCase() === wanted.toLowerCase()) ?? users[0];
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, email: u.public_email || undefined };
}

export interface ProjectInfo {
  id: number;
  name: string;
  pathWithNamespace: string;
  httpUrl: string;
  webUrl: string;
  defaultBranch: string;
}

export async function listMemberProjects(rest: GitLabRest): Promise<ProjectInfo[]> {
  const raw = await rest.paginate<{
    id: number;
    name: string;
    path_with_namespace: string;
    http_url_to_repo: string;
    web_url: string;
    default_branch?: string | null;
  }>("/projects", { membership: true, archived: false, simple: true, order_by: "path", sort: "asc" });
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    pathWithNamespace: p.path_with_namespace,
    httpUrl: p.http_url_to_repo,
    webUrl: p.web_url,
    defaultBranch: p.default_branch || "main",
  }));
}

/** Un projet par id ou par chemin (`groupe/projet`). */
export async function getProject(rest: GitLabRest, idOrPath: number | string): Promise<ProjectInfo> {
  const p = await rest.get<{
    id: number;
    name: string;
    path_with_namespace: string;
    http_url_to_repo: string;
    web_url: string;
    default_branch?: string | null;
  }>(`/projects/${pid(idOrPath)}`);
  return {
    id: p.id,
    name: p.name,
    pathWithNamespace: p.path_with_namespace,
    httpUrl: p.http_url_to_repo,
    webUrl: p.web_url,
    defaultBranch: p.default_branch || "main",
  };
}

export interface LabelInfo {
  name: string;
  color: string;
}

/** Labels du projet, y compris ceux des groupes parents. */
export async function listLabels(rest: GitLabRest, projectId: number): Promise<LabelInfo[]> {
  const raw = await rest.paginate<{ name: string; color: string }>(`/projects/${pid(projectId)}/labels`, {
    include_ancestor_groups: true,
  });
  return raw.map((l) => ({ name: l.name, color: l.color }));
}

export async function createLabel(
  rest: GitLabRest,
  projectId: number,
  name: string,
  color = "#6699cc",
  description?: string,
): Promise<void> {
  await rest.post(`/projects/${pid(projectId)}/labels`, { name, color, ...(description ? { description } : {}) });
}

// ---------------------------------------------------------------------------
// Dépôt
// ---------------------------------------------------------------------------

/** Noms des entrées à la racine du dépôt (fichiers et dossiers). [] si dépôt vide. */
export async function listRootTree(rest: GitLabRest, projectId: number, ref: string): Promise<string[]> {
  try {
    const tree = await rest.paginate<{ name: string; type: "blob" | "tree" }>(
      `/projects/${pid(projectId)}/repository/tree`,
      { ref },
      5,
    );
    return tree.map((t) => t.name);
  } catch (err) {
    if (err instanceof GitLabHttpError && err.status === 404) return [];
    throw err;
  }
}

/** Contenu brut d'un fichier, ou null s'il n'existe pas. */
export async function readRepoFile(
  rest: GitLabRest,
  projectId: number,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    return await rest.text(`/projects/${pid(projectId)}/repository/files/${encodeURIComponent(path)}/raw`, { ref });
  } catch (err) {
    if (err instanceof GitLabHttpError && err.status === 404) return null;
    throw err;
  }
}

export interface CiConfig {
  /**
   * `merged` : config complète, includes développés (`GET /projects/:id/ci/lint`) ; `raw` : `.gitlab-ci.yml` seul
   * (includes non développés) ; `none` : pas de CI.
   */
  source: "merged" | "raw" | "none";
  yaml: string;
}

/**
 * Config CI de la branche `ref`, en lecture seule. On essaie d'abord la config fusionnée renvoyée par l'API de
 * validation (includes développés, rôle Developer requis), sinon le `.gitlab-ci.yml` brut.
 */
export async function getCiConfig(rest: GitLabRest, projectId: number, ref: string): Promise<CiConfig> {
  try {
    const lint = await rest.get<{ valid?: boolean; merged_yaml?: string | null }>(`/projects/${pid(projectId)}/ci/lint`, {
      content_ref: ref,
    });
    if (typeof lint.merged_yaml === "string" && lint.merged_yaml.trim()) return { source: "merged", yaml: lint.merged_yaml };
  } catch (err) {
    if (!(err instanceof GitLabHttpError)) throw err;
    log.debug({ projectId, status: err.status }, "config CI fusionnée indisponible, lecture du fichier brut");
  }
  const raw = await readRepoFile(rest, projectId, ".gitlab-ci.yml", ref);
  return raw === null ? { source: "none", yaml: "" } : { source: "raw", yaml: raw };
}

// ---------------------------------------------------------------------------
// Détection (pure)
// ---------------------------------------------------------------------------

export interface StackDetection {
  stack: string;
  setupCommand?: string;
  buildCommand?: string;
  testCommand?: string;
  cowDirs: string[];
}

/** Fichiers dont le contenu sert à la détection (lus s'ils existent à la racine). */
export const FILES_TO_READ = ["package.json", ".gitlab-ci.yml"] as const;

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

function parsePackageJson(content: string | undefined): PackageJson {
  if (!content) return {};
  try {
    return JSON.parse(content) as PackageJson;
  } catch {
    return {};
  }
}

function detectNode(files: Set<string>, pkg: PackageJson): StackDetection {
  const scripts = pkg.scripts ?? {};
  const pmField = pkg.packageManager ?? "";
  let setup: string;
  let run: (s: string) => string;
  let testCmd: string;
  if (files.has("pnpm-lock.yaml") || pmField.startsWith("pnpm@")) {
    setup = "pnpm i --frozen-lockfile";
    run = (s) => `pnpm run ${s}`;
    testCmd = "pnpm test";
  } else if (files.has("yarn.lock") || pmField.startsWith("yarn@")) {
    const berry = files.has(".yarnrc.yml") || /^yarn@[2-9]/.test(pmField);
    setup = berry ? "yarn install --immutable" : "yarn --frozen-lockfile";
    run = (s) => `yarn ${s}`;
    testCmd = "yarn test";
  } else if (files.has("bun.lockb") || files.has("bun.lock") || pmField.startsWith("bun@")) {
    setup = "bun install --frozen-lockfile";
    run = (s) => `bun run ${s}`;
    testCmd = "bun run test";
  } else {
    setup = files.has("package-lock.json") || files.has("npm-shrinkwrap.json") ? "npm ci" : "npm install";
    run = (s) => `npm run ${s}`;
    testCmd = "npm test";
  }
  return {
    stack: files.has("tsconfig.json") ? "node-typescript" : "node",
    setupCommand: setup,
    buildCommand: scripts.build ? run("build") : undefined,
    testCommand: scripts.test ? testCmd : undefined,
    cowDirs: ["node_modules"],
  };
}

function detectPython(files: Set<string>): StackDetection {
  if (files.has("uv.lock")) {
    return { stack: "python", setupCommand: "uv sync", testCommand: "uv run pytest", cowDirs: [] };
  }
  if (files.has("poetry.lock")) {
    return { stack: "python", setupCommand: "poetry install", testCommand: "poetry run pytest", cowDirs: [] };
  }
  const install = files.has("requirements.txt")
    ? ".venv/bin/pip install -r requirements.txt" + (files.has("requirements-dev.txt") ? " -r requirements-dev.txt" : "")
    : ".venv/bin/pip install -e .";
  return {
    stack: "python",
    setupCommand: `python3 -m venv .venv && ${install}`,
    testCommand: ".venv/bin/python -m pytest",
    cowDirs: [],
  };
}

/**
 * Détecte les stacks possibles à partir des noms de fichiers racine et du contenu de quelques fichiers.
 * Renvoie les candidats par ordre de priorité (le premier est la proposition par défaut) ; [] si rien de reconnu.
 */
export function detectStacks(rootFiles: string[], contents: Record<string, string | undefined> = {}): StackDetection[] {
  const files = new Set(rootFiles);
  const out: StackDetection[] = [];
  const has = (re: RegExp) => rootFiles.some((f) => re.test(f));

  if (has(/\.(sln|slnx|csproj|fsproj)$/i)) {
    out.push({
      stack: "dotnet",
      setupCommand: "dotnet restore",
      buildCommand: "dotnet build --no-restore",
      testCommand: "dotnet test",
      cowDirs: [],
    });
  }
  if (files.has("pom.xml")) {
    const mvn = files.has("mvnw") ? "./mvnw" : "mvn";
    out.push({
      stack: "maven",
      buildCommand: `${mvn} -q -B -DskipTests package`,
      testCommand: `${mvn} -q -B test`,
      cowDirs: [],
    });
  }
  if (files.has("build.gradle") || files.has("build.gradle.kts")) {
    const gradle = files.has("gradlew") ? "./gradlew" : "gradle";
    out.push({ stack: "gradle", buildCommand: `${gradle} assemble`, testCommand: `${gradle} test`, cowDirs: [] });
  }
  if (files.has("go.mod")) {
    out.push({
      stack: "go",
      setupCommand: "go mod download",
      buildCommand: "go build ./...",
      testCommand: "go test ./...",
      cowDirs: [],
    });
  }
  if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("setup.py")) {
    out.push(detectPython(files));
  }
  if (files.has("package.json")) {
    const node = detectNode(files, parsePackageJson(contents["package.json"]));
    // Un package.json avec script de test est le signal le plus fort ; sans test, il passe après les autres stacks.
    if (node.testCommand) out.unshift(node);
    else out.push(node);
  }
  return out;
}

/**
 * merge_request si la CI déclenche réellement sur `merge_request_event` (ou inclut le template
 * MergeRequest-Pipelines, ou `only: merge_requests`), sinon branch.
 *
 * Heuristique ligne à ligne (pas de parse YAML : ancres, `!reference`, includes…) :
 * - lignes commentées ignorées ;
 * - une condition `!= / !~ merge_request_event` (seule) ne compte pas ;
 * - une règle (élément de liste `- if: …`) dont le `when:` vaut `never` ne compte pas ;
 * - `merge_requests` sous `except:` ne compte pas.
 * Dans le doute, on penche vers merge_request : l'attente de pipeline retombe sur le pipeline de branche
 * si aucun pipeline de MR n'apparaît (l'inverse ne serait pas rattrapé).
 */
export function detectCiSource(ciYaml: string | null | undefined): "merge_request" | "branch" {
  if (!ciYaml) return "branch";
  const lines = ciYaml.split(/\r?\n/).map(stripYamlComment);
  if (lines.some((l) => /MergeRequest-Pipelines/i.test(l))) return "merge_request";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/merge_request_event/.test(line) && ruleTriggersOnMrEvent(lines, i)) return "merge_request";
    // Ancienne syntaxe `only: [merge_requests]` / `- merge_requests`.
    if (/(?:^|[\s[,-])merge_requests\s*(?:\]|,|$)/.test(line) && !underExcept(lines, i)) return "merge_request";
  }
  return "branch";
}

function stripYamlComment(line: string): string {
  if (/^\s*#/.test(line)) return "";
  return line.replace(/\s+#.*$/, "");
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

/** Colonne du contenu (après l'indentation et un éventuel `- `). */
function contentIndentOf(line: string): number {
  return /^[ \t]*(?:-[ \t]+)?/.exec(line)![0].length;
}

function ruleTriggersOnMrEvent(lines: string[], i: number): boolean {
  const line = lines[i]!;
  const comparisons = [...line.matchAll(/(==|!=|=~|!~)\s*["'/]?[^"'\s/]*merge_request_event/g)].map((m) => m[1]);
  if (comparisons.length > 0 && comparisons.every((op) => op === "!=" || op === "!~")) return false;
  return !ruleWhenNever(lines, i);
}

/** La règle (élément de liste) contenant la ligne i a-t-elle `when: never` ? */
function ruleWhenNever(lines: string[], i: number): boolean {
  const isNever = (l: string) => /(?:^|[\s{,])when:\s*["']?never["']?\s*(?:[,}]|$)/.test(l);
  if (isNever(lines[i]!)) return true;
  // Début de l'élément : la ligne i elle-même si elle commence par `- `, sinon le `- ` englobant.
  let start = -1;
  const limit = contentIndentOf(lines[i]!);
  for (let j = i; j >= 0; j--) {
    const l = lines[j]!;
    if (l.trim() === "") continue;
    if (/^[ \t]*-[ \t]/.test(l) && (j === i || indentOf(l) < limit)) {
      start = j;
      break;
    }
    if (j !== i && indentOf(l) < limit) break; // sorti de l'élément sans trouver de puce
  }
  if (start === -1) return false;
  const dash = indentOf(lines[start]!);
  for (let j = start; j < lines.length; j++) {
    const l = lines[j]!;
    if (j > start && l.trim() !== "" && indentOf(l) <= dash) break;
    if (isNever(l)) return true;
  }
  return false;
}

/** `merge_requests` à la ligne i est-il sous une clé `except:` (directement ou via `refs:`) ? */
function underExcept(lines: string[], i: number): boolean {
  const own = /^[ \t]*(?:-[ \t]+)?([\w-]+):/.exec(lines[i]!);
  if (own) return own[1] === "except";
  let threshold = indentOf(lines[i]!);
  for (let j = i - 1; j >= 0 && threshold > 0; j--) {
    const l = lines[j]!;
    if (l.trim() === "" || indentOf(l) >= threshold) continue;
    const key = /^[ \t]*(?:-[ \t]+)?([\w-]+):/.exec(l)?.[1];
    if (key === "except") return true;
    if (key === "only") return false;
    threshold = indentOf(l);
  }
  return false;
}

/** Nom court par défaut d'un projet : dernier segment du path, slugifié. */
export function defaultProjectName(pathWithNamespace: string): string {
  const last = pathWithNamespace.split("/").pop() ?? pathWithNamespace;
  const slug = last
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "");
  return slug || "projet";
}

export type StatusRoleName = "inProgress" | "inReview" | "blocked";

const ROLE_PATTERNS: Record<StatusRoleName, RegExp> = {
  inProgress: /progress|en cours|doing|wip/i,
  inReview: /review|revue|relecture/i,
  blocked: /block|bloqu|on hold|attente/i,
};

/** Devine, parmi des noms, celui qui correspond le mieux à un rôle (ou undefined). */
export function guessForRole(role: StatusRoleName, names: string[]): string | undefined {
  return names.find((n) => ROLE_PATTERNS[role].test(n));
}

/** Labels existants proposés pour un type de ticket. */
export function guessTypeLabels(type: "bug" | "feature", labels: string[]): string[] {
  const re = type === "bug" ? /bug|defect|anomal/i : /feature|enhancement|story|évolution|evolution/i;
  return labels.filter((l) => re.test(l));
}

// ---------------------------------------------------------------------------
// Analyse d'un projet (réseau)
// ---------------------------------------------------------------------------

export interface ProjectAnalysis {
  rootFiles: string[];
  stacks: StackDetection[];
  ciSource: "merge_request" | "branch";
  hasCi: boolean;
  hasWorktreeInclude: boolean;
}

export async function analyseProject(rest: GitLabRest, projectId: number, ref: string): Promise<ProjectAnalysis> {
  const rootFiles = await listRootTree(rest, projectId, ref);
  const contents: Record<string, string | undefined> = {};
  for (const f of FILES_TO_READ) {
    if (!rootFiles.includes(f)) continue;
    try {
      contents[f] = (await readRepoFile(rest, projectId, f, ref)) ?? undefined;
    } catch (err) {
      log.warn({ projectId, file: f, err: err instanceof Error ? err.message : String(err) }, "Lecture impossible");
    }
  }
  return {
    rootFiles,
    stacks: detectStacks(rootFiles, contents),
    ciSource: detectCiSource(contents[".gitlab-ci.yml"]),
    hasCi: rootFiles.includes(".gitlab-ci.yml"),
    hasWorktreeInclude: rootFiles.includes(".worktreeinclude"),
  };
}

// ---------------------------------------------------------------------------
// Contrôle d'un jeton sur un projet (doctor)
// ---------------------------------------------------------------------------

export interface ProjectAccessCheck {
  /** Le projet est lisible avec ce jeton. */
  accessible: boolean;
  /** Statut HTTP de l'échec d'accès au projet. */
  status?: number;
  /** Scopes du jeton (`GET /personal_access_tokens/self`), absents s'ils ne sont pas lisibles. */
  scopes?: string[];
}

/** Vérifie qu'un jeton accède au projet et lit ses scopes. Ne lève que sur une erreur réseau. */
export async function checkProjectAccess(rest: GitLabRest, projectId: number): Promise<ProjectAccessCheck> {
  let accessible = true;
  let status: number | undefined;
  try {
    await rest.get(`/projects/${pid(projectId)}`);
  } catch (err) {
    if (!(err instanceof GitLabHttpError)) throw err;
    accessible = false;
    status = err.status;
  }
  let scopes: string[] | undefined;
  try {
    const self = await rest.get<{ scopes?: string[] }>("/personal_access_tokens/self");
    scopes = Array.isArray(self.scopes) ? self.scopes : undefined;
  } catch (err) {
    if (!(err instanceof GitLabHttpError)) throw err;
    log.debug({ projectId, status: err.status }, "Scopes du jeton illisibles");
  }
  return { accessible, ...(status !== undefined ? { status } : {}), ...(scopes ? { scopes } : {}) };
}

// ---------------------------------------------------------------------------
// Adresse de l'instance
// ---------------------------------------------------------------------------

export interface ApiBase {
  /** Adresse de l'instance, sans `/` final (ex. https://gitlab.example.com, ou https://exemple.fr/gitlab). */
  base: string;
  /** Chemin du projet si l'URL saisie pointait vers un projet (ou un de ses tickets, MR…). */
  projectPath?: string;
}

/**
 * Trouve l'adresse de l'instance GitLab à partir de ce que l'utilisateur a collé : adresse de l'instance, URL d'un
 * projet (https://gitlab.example.com/groupe/projet) ou d'une page du projet (…/-/issues/12).
 * On essaie chaque préfixe du chemin, du plus long au plus court, en appelant `<préfixe>/api/v4/version` sans jeton :
 * une API GitLab répond 401 (ou 200 en JSON) ; un mauvais préfixe répond 404 ou une page HTML.
 */
export async function resolveApiBase(
  url: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (i, o) => fetch(i, o),
): Promise<ApiBase> {
  const u = new URL(url.trim());
  const segments = u.pathname
    .split("/-/")[0]! // …/groupe/projet/-/issues/12 → …/groupe/projet
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/\.git$/, ""));
  for (let i = segments.length; i >= 0; i--) {
    const base = `${u.origin}${i > 0 ? `/${segments.slice(0, i).join("/")}` : ""}`;
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/v4/version`, { headers: { Accept: "application/json" }, redirect: "manual" });
    } catch (err) {
      throw new Error(`GitLab injoignable à ${u.origin} : ${err instanceof Error ? err.message : String(err)}`);
    }
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || (res.status === 200 && isJson)) {
      const rest = segments.slice(i).join("/");
      return rest ? { base, projectPath: rest } : { base };
    }
  }
  throw new Error(
    `Aucune API GitLab trouvée à partir de ${url} : indique l'adresse de l'instance (ex. https://gitlab.com ou https://gitlab.mon-ecole.fr).`,
  );
}
