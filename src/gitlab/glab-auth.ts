/**
 * Connexion GitLab déléguée à la CLI glab (ADR, amendement 2) : SprintSaver ne stocke aucun jeton. L'utilisateur se
 * connecte avec `glab auth login` ; glab range le jeton où il le souhaite (trousseau du système par défaut).
 * SprintSaver le relit à la demande par `glab auth status --show-token` et ne le garde qu'en mémoire.
 *
 * Le jeton est envoyé en `Authorization: Bearer`, accepté par GitLab pour un Personal/Project Access Token comme pour
 * un jeton OAuth (`glab auth login --web`). Un jeton OAuth expire : sur un 401, le client REST relit glab une fois.
 */
import { execFile } from "node:child_process";

export class GlabAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlabAuthError";
  }
}

/** Fournit le jeton à la demande. `refresh` relit la source (jeton OAuth expiré, nouvelle connexion glab). */
export interface TokenProvider {
  /** Description de la source, sans le jeton (messages d'erreur, doctor). */
  readonly label: string;
  get(): Promise<string>;
  refresh(): Promise<string>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // Commande absente (ENOENT) : code 127, comme un shell.
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Jeton fixe (tests, banc d'essai). */
export function staticToken(token: string, label = "jeton fourni"): TokenProvider {
  return { label, get: async () => token, refresh: async () => token };
}

/** Jeton de la connexion glab pour `host`, lu une fois puis gardé en mémoire ; `refresh` relit glab. */
export function glabToken(host: string, exec: ExecFn = defaultExec): TokenProvider {
  let value: Promise<string> | undefined;
  const load = (): Promise<string> => {
    const p = readGlabToken(host, exec);
    value = p;
    p.catch(() => {
      if (value === p) value = undefined; // un échec n'est pas mis en cache
    });
    return p;
  };
  return { label: `connexion glab (${host})`, get: () => value ?? load(), refresh: load };
}

/**
 * Extrait le jeton de la sortie de `glab auth status --show-token`. Le format n'est pas documenté par glab ; constaté
 * avec glab 1.131 : « ✓ Token found in environment variable GITLAB_TOKEN: <jeton> ». Selon la source, la ligne peut
 * aussi s'écrire « Token: <jeton> » ou « Token found: <jeton> ».
 * Règle : une ligne qui contient le mot « Token » (avec majuscule), puis un deux-points, puis UNE seule valeur en fin
 * de ligne qui a la forme d'un jeton. Les autres lignes (« ! To see the token value in use, run: env | grep … »,
 * « No token found (…) ») ne correspondent pas. Une valeur masquée (`****`) est ignorée.
 */
export function parseGlabToken(output: string): string | null {
  for (const m of output.matchAll(/\bToken\b[^\n:]*:\s*([A-Za-z0-9_.\-]{8,})[ \t]*$/gm)) {
    return m[1]!;
  }
  return null;
}

export async function glabVersion(exec: ExecFn = defaultExec): Promise<string | null> {
  const res = await exec("glab", ["--version"]);
  return res.code === 0 ? (res.stdout.trim().split("\n")[0] ?? "glab") : null;
}

export async function readGlabToken(host: string, exec: ExecFn = defaultExec): Promise<string> {
  const res = await exec("glab", ["auth", "status", "--hostname", host, "--show-token"]);
  if (res.code === 127) {
    throw new GlabAuthError("glab introuvable : installe la CLI GitLab (`brew install glab`), puis `glab auth login`.");
  }
  // Selon les versions, glab écrit son statut sur stdout ou sur stderr : on lit les deux.
  const token = parseGlabToken(`${res.stdout}\n${res.stderr}`);
  if (!token) {
    throw new GlabAuthError(`glab n'est pas connecté à ${host} : lance \`glab auth login --hostname ${host}\`, puis relance.`);
  }
  return token;
}

export function hostOf(url: string): string {
  return new URL(url).host;
}
