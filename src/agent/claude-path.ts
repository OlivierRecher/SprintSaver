/**
 * Résolution du binaire `claude` de l'utilisateur, passé au SDK via `pathToClaudeCodeExecutable`
 * (le binaire embarqué optionnel du SDK n'est pas installé ; l'auth passe par le login Claude Code, ADR § 2).
 *
 * Ordre : `SPRINTSAVER_CLAUDE_PATH`, puis `claude` dans le PATH, puis les emplacements d'installation usuels.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface ResolveClaudeOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test d'exécutabilité (injectable pour les tests). */
  isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Résolution sans cache. Lève une erreur explicite si `claude` est introuvable. */
export function findClaudeExecutable(opts: ResolveClaudeOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const isExec = opts.isExecutable ?? defaultIsExecutable;

  const override = env.SPRINTSAVER_CLAUDE_PATH?.trim();
  if (override) {
    const p = isAbsolute(override) ? override : resolve(override);
    if (!isExec(p)) {
      throw new Error(`SPRINTSAVER_CLAUDE_PATH=${override} ne désigne pas un exécutable. Corrige la variable ou retire-la.`);
    }
    return p;
  }

  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  const fallbacks = [join(home, ".claude", "local"), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of [...dirs, ...fallbacks]) {
    const candidate = join(dir, "claude");
    if (isExec(candidate)) return candidate;
  }

  throw new Error(
    "Binaire `claude` (Claude Code) introuvable dans le PATH. Installe Claude Code et connecte-toi (`claude` puis /login), " +
      "ou indique son chemin dans la variable SPRINTSAVER_CLAUDE_PATH.",
  );
}

let cached: string | undefined;

/** Résolution mise en cache pour le processus. */
export function resolveClaudeExecutable(): string {
  cached ??= findClaudeExecutable();
  return cached;
}

/** Pour les tests. */
export function resetClaudeExecutableCache(): void {
  cached = undefined;
}
