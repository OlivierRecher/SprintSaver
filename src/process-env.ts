/**
 * Environnement des commandes du projet (ADR, amendement 5) : setup, build et test des tickets, vérification de
 * `init`, sondes de version, sessions agent qui lancent des commandes.
 *
 * Lancé par `npm run …` (ou yarn, pnpm), SprintSaver hérite des variables que le gestionnaire de paquets injecte
 * dans ses scripts : `npm_config_*` (dont `npm_config_prefix`, qui empêche nvm.sh de se charger), `npm_lifecycle_*`,
 * `npm_package_*`, `npm_execpath`, `INIT_CWD`… et d'un PATH précédé des `node_modules/.bin` de SprintSaver et de ses
 * dossiers parents. Les transmettre ferait dépendre les commandes du projet de la façon dont SprintSaver est lancé.
 * Une seule fonction les retire, pour qu'`init` et les tickets exécutent dans le même environnement.
 */
import { dirname, sep } from "node:path";

/** Variables propres aux scripts npm, yarn et pnpm (jamais posées par l'utilisateur lui-même). */
const PACKAGE_MANAGER_VARS = new Set(["INIT_CWD", "PROJECT_CWD", "BERRY_BIN_FOLDER"]);
/** Variables que npm pose dans un script ; retirées seulement si l'environnement vient d'un script npm. */
const NPM_SCRIPT_VARS = new Set(["NODE", "COLOR"]);

function fromPackageScript(env: NodeJS.ProcessEnv): boolean {
  return env.npm_lifecycle_event !== undefined || env.npm_execpath !== undefined || env.npm_command !== undefined;
}

/** Dossier du paquet dont le script a lancé SprintSaver, et ses parents : npm a mis leurs `node_modules/.bin` dans le PATH. */
function scriptBinDirs(env: NodeJS.ProcessEnv): Set<string> {
  const dirs = new Set<string>();
  const pkgDir = env.npm_config_local_prefix ?? (env.npm_package_json ? dirname(env.npm_package_json) : undefined) ?? env.INIT_CWD;
  if (!pkgDir) return dirs;
  let cur = pkgDir;
  for (;;) {
    dirs.add(`${cur === sep ? "" : cur}${sep}node_modules${sep}.bin`);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** PATH sans les entrées ajoutées par le script npm (`node_modules/.bin` du paquet et de ses parents, `node-gyp-bin`). */
export function cleanPath(path: string, env: NodeJS.ProcessEnv): string {
  const injected = scriptBinDirs(env);
  const seen = new Set<string>();
  return path
    .split(":")
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      if (injected.has(p.replace(/\/+$/, ""))) return false;
      return !/[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin\/?$/.test(p);
    })
    .join(":");
}

/** Environnement à transmettre aux commandes du projet : celui de l'utilisateur, sans les traces du gestionnaire de paquets qui a lancé SprintSaver. */
export function projectCommandEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const script = fromPackageScript(base);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("npm_") || PACKAGE_MANAGER_VARS.has(k)) continue;
    if (script && NPM_SCRIPT_VARS.has(k)) continue;
    env[k] = v;
  }
  if (script && env.PATH) env.PATH = cleanPath(env.PATH, base);
  return env;
}
