/**
 * Sondes de toolchain en lecture seule pour l'agent de configuration (ADR, amendement 5).
 *
 * L'agent n'a pas de Bash : il choisit des outils dans une liste fermée et l'orchestrateur lance lui-même des
 * commandes de version fixes (`node --version`, `java -version`, `pyenv versions --bare`…). Rien n'est installé ni
 * modifié. Pour chaque outil, on rapporte toutes les copies trouvées dans le PATH (la première est celle qu'une
 * commande non qualifiée utiliserait), les installations versionnées de Homebrew, et les versions connues des
 * gestionnaires de versions installés.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { projectCommandEnv } from "../process-env.js";

/** Arguments de la sonde de version de chaque outil connu. */
export const KNOWN_TOOLS: Record<string, string[][]> = {
  node: [["--version"]],
  npm: [["--version"]],
  pnpm: [["--version"]],
  yarn: [["--version"]],
  bun: [["--version"]],
  deno: [["--version"]],
  corepack: [["--version"]],
  python3: [["--version"]],
  python: [["--version"]],
  pip: [["--version"]],
  pip3: [["--version"]],
  pipx: [["--version"]],
  uv: [["--version"]],
  poetry: [["--version"]],
  pipenv: [["--version"]],
  pdm: [["--version"]],
  hatch: [["--version"]],
  tox: [["--version"]],
  java: [["-version"]],
  javac: [["-version"]],
  mvn: [["--version"]],
  gradle: [["--version", "--quiet"]],
  kotlin: [["-version"]],
  sbt: [["--script-version"]],
  dotnet: [["--version"], ["--list-sdks"]],
  go: [["version"]],
  ruby: [["--version"]],
  bundle: [["--version"]],
  rustc: [["--version"]],
  cargo: [["--version"]],
  php: [["--version"]],
  composer: [["--version", "--no-interaction"]],
  elixir: [["--version"]],
  erl: [["-noshell", "-eval", "io:format(\"~s~n\", [erlang:system_info(otp_release)]), halt()."]],
  swift: [["--version"]],
  dart: [["--version"]],
  flutter: [["--version", "--machine"]],
  zig: [["version"]],
  make: [["--version"]],
  cmake: [["--version"]],
  gcc: [["--version"]],
  clang: [["--version"]],
  docker: [["--version"]],
  git: [["--version"]],
};

/** Formules Homebrew dont les installations versionnées (`<formule>@<version>`) fournissent l'outil. */
const BREW_FORMULAE: Record<string, string[]> = {
  node: ["node"],
  npm: ["node"],
  python3: ["python"],
  python: ["python"],
  java: ["openjdk"],
  javac: ["openjdk"],
  mvn: ["maven"],
  gradle: ["gradle"],
  go: ["go"],
  ruby: ["ruby"],
  php: ["php"],
  dotnet: ["dotnet"],
  elixir: ["elixir"],
  erl: ["erlang"],
  kotlin: ["kotlin"],
};

export interface ProbeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProbeDeps {
  exec: (file: string, args: string[], cwd: string) => Promise<ProbeExecResult>;
  pathDirs: string[];
  isExecutable: (p: string) => boolean;
  realpath: (p: string) => string;
  listDir: (p: string) => string[];
  home: string;
  platform: NodeJS.Platform;
}

const PROBE_TIMEOUT_MS = 20_000;

export function defaultProbeDeps(env: NodeJS.ProcessEnv = process.env): ProbeDeps {
  return {
    exec: (file, args, cwd) =>
      new Promise((resolve) => {
        execFile(file, args, { cwd, timeout: PROBE_TIMEOUT_MS, env: { ...projectCommandEnv(env), CI: "true", NO_COLOR: "1" }, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
      }),
    pathDirs: (projectCommandEnv(env).PATH ?? "").split(delimiter).filter(Boolean),
    isExecutable: (p) => {
      try {
        if (!statSync(p).isFile()) return false;
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    home: homedir(),
    platform: process.platform,
  };
}

/** Premières lignes non vides de la sortie d'une sonde (stdout puis stderr : `java -version` écrit sur stderr). */
function firstLines(r: ProbeExecResult, max = 3): string {
  const text = `${r.stdout}\n${r.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max)
    .join(" | ");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function versionOf(tool: string, bin: string, cwd: string, deps: ProbeDeps): Promise<string> {
  const parts: string[] = [];
  for (const args of KNOWN_TOOLS[tool] ?? [["--version"]]) {
    const r = await deps.exec(bin, args, cwd);
    const text = firstLines(r, args.includes("--list-sdks") ? 12 : 3);
    parts.push(r.code === 0 ? text || "(sortie vide)" : `échec (code ${r.code})${text ? ` : ${text}` : ""}`);
  }
  return parts.join(" ; ");
}

/** Toutes les copies de `tool` dans le PATH, dans l'ordre de résolution (dédoublonnées par chemin réel). */
export function whichAll(tool: string, deps: ProbeDeps): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of deps.pathDirs) {
    const p = join(dir, tool);
    if (!deps.isExecutable(p)) continue;
    const real = deps.realpath(p);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  return out;
}

function brewKegs(tool: string, deps: ProbeDeps): string[] {
  const formulae = BREW_FORMULAE[tool];
  if (!formulae) return [];
  const out: string[] = [];
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt", "/home/linuxbrew/.linuxbrew/opt"]) {
    for (const entry of deps.listDir(prefix)) {
      if (!formulae.some((f) => entry === f || entry.startsWith(`${f}@`))) continue;
      const bin = join(prefix, entry, "bin", tool);
      if (deps.isExecutable(bin)) out.push(bin);
    }
  }
  return out;
}

/**
 * Rapport texte des outils demandés : copies du PATH (la première est le défaut), installations versionnées
 * Homebrew, et pour Java sur macOS la liste de `/usr/libexec/java_home -V`.
 */
export async function probeToolchains(tools: string[], cwd: string, deps: ProbeDeps = defaultProbeDeps()): Promise<string> {
  const sections: string[] = [];
  for (const tool of [...new Set(tools)]) {
    if (!(tool in KNOWN_TOOLS)) {
      sections.push(`${tool}\n  outil inconnu des sondes (outils possibles : ${Object.keys(KNOWN_TOOLS).join(", ")})`);
      continue;
    }
    const lines = [tool];
    const onPath = whichAll(tool, deps);
    if (onPath.length === 0) lines.push("  absent du PATH");
    for (const [i, bin] of onPath.entries()) {
      const real = deps.realpath(bin);
      lines.push(`  ${bin}${real !== bin ? ` → ${real}` : ""} : ${await versionOf(tool, bin, cwd, deps)}${i === 0 ? " (défaut du PATH)" : ""}`);
    }
    const known = new Set(onPath.map((p) => deps.realpath(p)));
    for (const bin of brewKegs(tool, deps)) {
      if (known.has(deps.realpath(bin))) continue;
      known.add(deps.realpath(bin));
      lines.push(`  ${bin} : ${await versionOf(tool, bin, cwd, deps)} (Homebrew, hors PATH)`);
    }
    if ((tool === "java" || tool === "javac") && deps.platform === "darwin" && deps.isExecutable("/usr/libexec/java_home")) {
      const r = await deps.exec("/usr/libexec/java_home", ["-V"], cwd);
      const jdks = `${r.stderr}\n${r.stdout}`
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d/.test(l));
      lines.push(jdks.length ? `  JDK connus de /usr/libexec/java_home (utilisable : JAVA_HOME=$(/usr/libexec/java_home -v <version>)) :\n${jdks.map((j) => `    ${j}`).join("\n")}` : "  /usr/libexec/java_home : aucun JDK");
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

interface ManagerProbe {
  name: string;
  bin: string;
  args: string[][];
  /** Comment l'utiliser dans une commande non interactive (/bin/sh). */
  usage: string;
}

export const VERSION_MANAGERS: ManagerProbe[] = [
  { name: "mise", bin: "mise", args: [["--version"], ["ls", "--installed"]], usage: "mise exec <outil>@<version> -- <commande>" },
  { name: "asdf", bin: "asdf", args: [["--version"], ["list"]], usage: "fichier .tool-versions du dépôt, ou ASDF_<OUTIL>_VERSION=<version> <commande> via les shims" },
  { name: "fnm", bin: "fnm", args: [["--version"], ["list"]], usage: "fnm exec --using=<version> -- <commande>" },
  { name: "volta", bin: "volta", args: [["--version"], ["list", "all", "--format", "plain"]], usage: "volta run --node <version> [--npm|--yarn|--pnpm <version>] <commande>" },
  { name: "nodenv", bin: "nodenv", args: [["versions", "--bare"]], usage: "NODENV_VERSION=<version> nodenv exec <commande>" },
  { name: "pyenv", bin: "pyenv", args: [["versions", "--bare"]], usage: "PYENV_VERSION=<version> pyenv exec <commande>, ou \"$(pyenv root)/versions/<version>/bin/python\"" },
  { name: "uv", bin: "uv", args: [["--version"], ["python", "list", "--only-installed"]], usage: "uv venv --python <version> .venv ; uv run --python <version> … (versions déjà installées)" },
  { name: "rbenv", bin: "rbenv", args: [["versions", "--bare"]], usage: "RBENV_VERSION=<version> rbenv exec <commande>" },
  { name: "goenv", bin: "goenv", args: [["versions", "--bare"]], usage: "GOENV_VERSION=<version> goenv exec <commande>" },
  { name: "jenv", bin: "jenv", args: [["versions", "--bare"]], usage: "JENV_VERSION=<version> jenv exec <commande>" },
  { name: "rustup", bin: "rustup", args: [["toolchain", "list"]], usage: "cargo +<toolchain> <commande>, ou rust-toolchain.toml du dépôt" },
  { name: "conda", bin: "conda", args: [["env", "list"]], usage: "conda run -n <env> <commande>" },
  { name: "nix", bin: "nix", args: [["--version"]], usage: "nix develop / nix-shell si le dépôt fournit flake.nix ou shell.nix" },
];

/** Gestionnaires de versions installés et versions qu'ils connaissent déjà (lecture seule). */
export async function listVersionManagers(cwd: string, deps: ProbeDeps = defaultProbeDeps()): Promise<string> {
  const sections: string[] = [];
  for (const m of VERSION_MANAGERS) {
    const bin = whichAll(m.bin, deps)[0];
    if (!bin) continue;
    const lines = [`${m.name} (${bin}) — usage : ${m.usage}`];
    for (const args of m.args) {
      const r = await deps.exec(bin, args, cwd);
      const text = `${r.stdout}\n${r.stderr}`
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim())
        .slice(0, 40);
      lines.push(`  $ ${m.bin} ${args.join(" ")}${r.code !== 0 ? ` (code ${r.code})` : ""}`);
      lines.push(...text.map((l) => `    ${l}`));
    }
    sections.push(lines.join("\n"));
  }
  // Gestionnaires sous forme de fonctions shell : absents du PATH, repérés par leur dossier.
  const nvmDir = join(deps.home, ".nvm");
  const nvmVersions = deps.listDir(join(nvmDir, "versions", "node"));
  if (nvmVersions.length) {
    sections.push(
      `nvm (${nvmDir}, fonction shell : à sourcer dans la commande) — usage : . "$HOME/.nvm/nvm.sh" && nvm exec <version> <commande>, ou PATH="$HOME/.nvm/versions/node/<version>/bin:$PATH" <commande>\n` +
        nvmVersions.map((v) => `    ${v}`).join("\n"),
    );
  }
  const sdkman = join(deps.home, ".sdkman", "candidates");
  const candidates = deps.listDir(sdkman);
  if (candidates.length) {
    const lines = [`sdkman (${sdkman}) — usage : JAVA_HOME="$HOME/.sdkman/candidates/java/<version>" <commande> (et de même pour les autres candidats)`];
    for (const c of candidates) {
      const versions = deps.listDir(join(sdkman, c)).filter((v) => v !== "current");
      if (versions.length) lines.push(`    ${c} : ${versions.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }
  if (sections.length === 0) return "Aucun gestionnaire de versions trouvé (mise, asdf, fnm, volta, nvm, pyenv, uv, rbenv, jenv, sdkman, rustup…).";
  return sections.join("\n\n");
}
