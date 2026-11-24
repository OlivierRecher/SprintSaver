/**
 * Vérification réelle des commandes proposées par `init` (ADR, amendement 5).
 *
 * C'est l'orchestrateur qui exécute, pas l'agent : worktree jetable détaché sur la branche par défaut, préparé comme
 * celui d'un ticket (fichiers ignorés copiés, dossiers de dépendances clonés en copy-on-write), puis setup → test →
 * build → test relancé, chacun avec un timeout. Le test passe juste après le setup, comme dans un ticket (le moteur ne lance jamais le
 * build) : les sorties d'un build ne peuvent pas fausser le test. Le build vient en dernier, à titre indicatif. Le résultat garde un extrait utile de la sortie (erreurs, résumé final) et un
 * diagnostic indicatif : commande cassée, environnement, ou tests rouges sur la branche par défaut (ligne de base).
 *
 * Avant toute exécution, chaque commande passe la politique de `commandPolicyViolation` : rien qui écrive hors du
 * worktree, touche au remote ou installe quelque chose globalement sur la machine.
 */
import type { ProjectConfig } from "../config/schema.js";
import type { CommandResult, GitOps } from "../contracts.js";
import { evaluateToolCall, parseShell, stripHeredocs } from "../agent/guard-hook.js";
import { errorMessage } from "../engine/util.js";

/**
 * `rerun` relance la commande de test dans le même worktree, après le build : dans un ticket, la boucle test/fix la
 * relance plusieurs fois au même endroit, après des builds lancés par les agents. Une commande qui ne passe qu'une fois
 * (sorties qu'elle laisse ou que le build laisse, analysées au passage suivant) bloquerait le ticket.
 */
export const VERIFY_STEPS = ["setup", "test", "build", "rerun"] as const;
export type VerifyStep = (typeof VERIFY_STEPS)[number];

/** Nom affiché de chaque étape. */
export const STEP_NAME: Record<VerifyStep, string> = { setup: "setup", test: "test", build: "build", rerun: "test relancé" };

export interface VerifyInput {
  setupCommand?: string;
  buildCommand?: string;
  testCommand?: string;
  worktreeInclude: string[];
  cowDirs: string[];
  /** Checkout de l'utilisateur d'où copier les fichiers ignorés et les dossiers de dépendances. */
  localCheckout?: string;
}

/**
 * Diagnostic indicatif d'un échec :
 * - `command_not_found` : exécutable introuvable (code 127, « command not found ») ;
 * - `environment` : version de runtime, module ou dépendance manquants, incompatibilité de toolchain ;
 * - `tests_failed` : le lanceur de tests a tourné et signale des tests en échec ;
 * - `not_rerunnable` : la commande de test a passé une fois mais échoue relancée dans le même worktree ;
 * - `timeout` ; `error` : autre échec.
 */
export type Diagnosis = "command_not_found" | "environment" | "tests_failed" | "not_rerunnable" | "timeout" | "error";

export interface StepResult {
  step: VerifyStep;
  command?: string;
  status: "passed" | "failed" | "skipped" | "not_run";
  exitCode?: number;
  durationMs?: number;
  diagnosis?: Diagnosis;
  /** Extrait utile de la sortie (vide si l'étape a réussi). */
  excerpt?: string;
}

/**
 * Verdict de l'orchestrateur :
 * - `passed` : setup, test et build passent ;
 * - `baseline_red` : setup et build passent, le lanceur de tests tourne mais des tests échouent sur la branche par
 *   défaut (ligne de base). Des tests rouges n'arrêtent pas la vérification : le build est quand même lancé ;
 * - `broken` : une commande ne marche pas (préparation, setup, build, lanceur de tests introuvable ou cassé) ;
 * - `refused` : une commande enfreint la politique d'exécution, rien n'a été lancé.
 */
export type Verdict = "passed" | "baseline_red" | "broken" | "refused";

export interface VerificationReport {
  attempt: number;
  input: VerifyInput;
  verdict: Verdict;
  steps: StepResult[];
  /** Échec de la préparation du worktree, ou raison du refus. */
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Politique d'exécution
// ---------------------------------------------------------------------------

/** Préfixes à sauter pour trouver la vraie commande d'un segment. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TRANSPARENT = new Set(["env", "command", "exec", "time", "nice", "nohup"]);

function commandWords(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ENV_ASSIGN.test(w) || TRANSPARENT.has(w)) {
      i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function base(word: string): string {
  return word.split("/").pop() ?? word;
}

const SYSTEM_PACKAGE_MANAGERS = new Set(["brew", "port", "apt", "apt-get", "yum", "dnf", "apk", "pacman", "zypper", "snap", "choco", "winget", "scoop", "nix-env"]);
const VERSION_MANAGER_INSTALL: Record<string, Set<string>> = {
  mise: new Set(["install", "i", "global", "g", "upgrade", "up", "plugins", "plugin", "self-update", "implode", "trust"]),
  asdf: new Set(["install", "global", "set", "plugin", "plugin-add", "update", "reshim"]),
  nvm: new Set(["install", "alias", "unalias", "uninstall", "reinstall-packages"]),
  fnm: new Set(["install", "default", "alias", "uninstall"]),
  volta: new Set(["install", "pin", "uninstall", "setup"]),
  nodenv: new Set(["install", "global", "rehash"]),
  n: new Set(["install", "latest", "lts", "stable"]),
  pyenv: new Set(["install", "global", "rehash", "uninstall"]),
  rbenv: new Set(["install", "global", "rehash", "uninstall"]),
  goenv: new Set(["install", "global", "rehash", "uninstall"]),
  jenv: new Set(["add", "global", "rehash", "remove"]),
  sdk: new Set(["install", "i", "default", "d", "uninstall", "selfupdate", "update"]),
  rustup: new Set(["install", "default", "update", "toolchain", "target", "component", "self", "set", "override"]),
  pipx: new Set(["install", "inject", "upgrade", "ensurepath", "reinstall"]),
  corepack: new Set(["enable", "disable", "install"]),
  conda: new Set(["install", "create", "update", "remove", "env"]),
};

/** Raison du refus d'une commande, ou null si elle peut être exécutée dans le worktree jetable. */
export function commandPolicyViolation(command: string, worktreePath: string): string | null {
  if (/\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(command)) {
    return "un script téléchargé et passé à un shell (… | sh) n'est pas accepté.";
  }
  const guard = evaluateToolCall("Bash", { command }, worktreePath);
  if (!guard.allow) return guard.reason;

  for (const seg of parseShell(stripHeredocs(command))) {
    const words = commandWords(seg.words);
    if (words.length === 0) continue;
    const cmd = base(words[0]!);
    const rest = words.slice(1);
    const sub = rest.find((w) => !w.startsWith("-"));
    const has = (...flags: string[]) => rest.some((w) => flags.includes(w));
    const global = `installation globale refusée (${words.slice(0, 3).join(" ")}) : les commandes ne doivent rien installer hors du worktree. Utilise une version déjà présente sur la machine, ou déclare-la comme prérequis.`;

    if (cmd === "sudo" || cmd === "doas" || cmd === "su") return `${cmd} est refusé : les commandes tournent sans privilège.`;
    if (SYSTEM_PACKAGE_MANAGERS.has(cmd) && sub && /^(install|reinstall|upgrade|update|add|tap|link|unlink|-S|-i)$/.test(sub)) return global;
    if ((cmd === "npm" || cmd === "pnpm" || cmd === "bun" || cmd === "yarn") && (has("-g", "--global", "--location=global") || sub === "global" || (cmd === "npm" && sub === "link"))) return global;
    if ((cmd === "pip" || cmd === "pip3" || /^pip3\.\d+$/.test(cmd)) && sub === "install" && words[0] === cmd) {
      return "pip du PATH refusé : il installerait dans l'interpréteur de la machine. Crée un environnement virtuel dans le worktree et utilise son pip (ex. .venv/bin/pip).";
    }
    if (/^python[\d.]*$/.test(cmd) && words[0] === cmd && rest[0] === "-m" && rest[1] === "pip" && rest.includes("install") && !has("--target", "-t", "--prefix")) {
      return "python -m pip du PATH refusé : il installerait dans l'interpréteur de la machine. Utilise le pip d'un environnement virtuel du worktree.";
    }
    if ((cmd === "pip" || cmd === "pip3" || /^python/.test(cmd)) && has("--user", "--break-system-packages")) return global;
    if (cmd === "gem" && (sub === "install" || sub === "update") && !has("--install-dir", "-i")) return global;
    if ((cmd === "go" || cmd === "cargo") && sub === "install") return global;
    if (cmd === "dotnet" && ((sub === "tool" && has("-g", "--global")) || sub === "workload")) return global;
    if (cmd === "uv" && (sub === "tool" || (sub === "python" && rest.some((w) => w === "install" || w === "pin" || w === "uninstall")))) return global;
    const vm = VERSION_MANAGER_INSTALL[cmd];
    if (vm && sub && vm.has(sub)) return global;
    // `mise use` installe la version et écrit un fichier de config : ni l'un ni l'autre n'est voulu.
    if (cmd === "mise" && sub === "use") return global;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lecture de la sortie
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const IMPORTANT_RE =
  /\b(error|errors|erreur|err!|fail|failed|failure|failures|failing|exception|traceback|fatal|panic|not found|cannot|can't|could not|unable|denied|missing|unsupported|incompatible|requires?|required|expected|assert\w*|mismatch|undefined|refused|timeout|timed out|killed)\b|✗|✘|×/i;
const NOISE_RE =
  /^\s*(npm (warn|notice) |warning: |downloading|downloaded|fetching|resolving|collecting|using cached|requirement already satisfied|progress|\[?\d{1,3}%\]?|[-=#>.\s]*\d{1,3}%|[━─█▉▊▋▌▍▎▏░▒▓|/\\-]+\s*$)/i;

/** Lignes nettoyées : séquences ANSI retirées, barres de progression (\r) réduites à leur dernier état. */
function cleanLines(output: string): string[] {
  return output
    .replace(ANSI_RE, "")
    .split("\n")
    .map((l) => (l.split("\r").filter((x) => x.trim().length > 0).pop() ?? "").trimEnd());
}

/**
 * Extrait utile d'une sortie de commande : les lignes d'erreur avec un peu de contexte, et la fin de la sortie
 * (où les lanceurs de tests et les gestionnaires de paquets écrivent leur résumé). Le bruit (progression,
 * téléchargements, avertissements de dépréciation) et les lignes répétées sont retirés.
 */
export function usefulExcerpt(output: string, maxChars = 3_500, tailLines = 25): string {
  const raw = cleanLines(output);
  const lines: string[] = [];
  for (const l of raw) {
    if (l.trim() === "") continue;
    if (NOISE_RE.test(l) && !/\b(error|err!|fail)/i.test(l)) continue;
    if (lines.length > 0 && lines[lines.length - 1] === l) continue;
    lines.push(l.length > 400 ? `${l.slice(0, 400)}…` : l);
  }
  if (lines.length === 0) return "";
  const keep = new Set<number>();
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep.add(i);
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORTANT_RE.test(lines[i]!)) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
  }
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (prev !== -1 && i > prev + 1) out.push("…");
    if (prev === -1 && i > 0) out.push("…");
    out.push(lines[i]!);
    prev = i;
  }
  const text = out.join("\n");
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}

const NOT_FOUND_RE = /command not found|: not found\b|No such file or directory|is not recognized as an internal or external command|ENOENT.*spawn/i;
const ENVIRONMENT_RE =
  /ModuleNotFoundError|No module named|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|EBADENGINE|Unsupported engine|engine ".*" is incompatible|requires a different Python|requires-python|Python \d+\.\d+ (?:or|is) (?:newer|required)|UnsupportedClassVersionError|class file version|invalid (?:target|source) release|release version \d+ not supported|Unsupported class file major version|requires go >=|go: go\.mod requires go|toolchain not available|The current \.NET SDK does not support|NETSDK\d+|A compatible \.NET SDK was not found|Your Ruby version is|requires Ruby version|rustc \d+\.\d+.* is not supported|requires rustc|your php version|requires php|SyntaxError: Unexpected token|unsupported (?:operand|syntax)|java_home|JAVA_HOME|version mismatch|incompatible version/i;
const TESTS_FAILED_RE = [
  /\bTests?:?\s+\d+ failed/i, // jest, vitest
  /^\s*Test Files\s+\d+ failed/im, // vitest
  /=+ .*\b\d+ (?:failed|errors?)\b.* =+/i, // pytest
  /^FAILED \((?:failures|errors)=\d+/m, // unittest
  /^--- FAIL:/m, // go
  /^FAIL\s+\S+/m, // go, jest
  /Tests run: \d+, Failures: [1-9]|Tests run: \d+, Failures: \d+, Errors: [1-9]|There are test failures/i, // maven
  /\d+ tests? completed, \d+ failed/i, // gradle
  /Failed!\s+-\s+Failed:\s+[1-9]/i, // dotnet
  /\d+ examples?, [1-9]\d* failures?/i, // rspec
  /test result: FAILED/i, // cargo
  /^# fail [1-9]/m, // node:test (TAP)
  /^ℹ fail [1-9]/m, // node:test (spec)
  /FAILURES!/, // phpunit
  /\b[1-9]\d* failing\b/i, // mocha
  /\d+ tests?, [1-9]\d* failures?/i, // ExUnit
];

/** Diagnostic indicatif d'un échec de commande, d'après son code de sortie et sa sortie. */
export function diagnose(step: VerifyStep, res: CommandResult): Diagnosis {
  if (res.timedOut) return "timeout";
  if (step === "rerun") return "not_rerunnable";
  const out = res.output.replace(ANSI_RE, "");
  if (res.exitCode === 127 || NOT_FOUND_RE.test(out.slice(-4_000))) return "command_not_found";
  if (ENVIRONMENT_RE.test(out)) return "environment";
  if (step === "test" && TESTS_FAILED_RE.some((re) => re.test(out))) return "tests_failed";
  return "error";
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

export interface VerifyDeps {
  gitops: GitOps;
  /** Projet tel qu'il sera configuré (nom du clone de référence, URL, branche par défaut). */
  project: ProjectConfig;
  /** Worktree jetable (supprimé à la fin). */
  worktreePath: string;
  timeoutMs: number;
  say?: (s: string) => void;
  now?: () => number;
}

function commandFor(input: VerifyInput, step: VerifyStep): string | undefined {
  const c = step === "setup" ? input.setupCommand : step === "build" ? input.buildCommand : input.testCommand; // test et rerun
  return c?.trim() ? c.trim() : undefined;
}

export function verdictOf(steps: StepResult[]): Verdict {
  let baselineRed = false;
  for (const s of steps) {
    if (s.status !== "failed") continue;
    if (s.step === "test" && s.diagnosis === "tests_failed") baselineRed = true;
    else return "broken";
  }
  return baselineRed ? "baseline_red" : "passed";
}

const fmtMs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

/** Exécute setup → test → build → test relancé dans un worktree jetable. Ne lève pas : les échecs sont dans le rapport. */
export async function verifyCommands(input: VerifyInput, attempt: number, deps: VerifyDeps): Promise<VerificationReport> {
  const now = deps.now ?? Date.now;
  const say = deps.say ?? (() => {});
  const started = now();
  const steps: StepResult[] = [];
  const done = (verdict: Verdict, error?: string): VerificationReport => ({
    attempt,
    input,
    verdict,
    steps,
    ...(error ? { error } : {}),
    durationMs: now() - started,
  });

  for (const step of VERIFY_STEPS) {
    const cmd = commandFor(input, step);
    if (!cmd) continue;
    const why = commandPolicyViolation(cmd, deps.worktreePath);
    if (why) {
      say(`    ${step} refusé : ${why}`);
      return done("refused", `${step} « ${cmd} » : ${why}`);
    }
  }

  const project: ProjectConfig = {
    ...deps.project,
    setupCommand: undefined,
    worktreeInclude: input.worktreeInclude,
    cowDirs: input.cowDirs,
    localCheckout: input.localCheckout?.trim() || undefined,
  };
  try {
    try {
      await deps.gitops.createDetachedWorktree(project, deps.worktreePath);
      await deps.gitops.prepareWorktree(project, deps.worktreePath, deps.timeoutMs);
    } catch (err) {
      const msg = errorMessage(err);
      say(`    préparation du worktree impossible : ${msg.split("\n")[0]}`);
      return done("broken", `préparation du worktree impossible : ${usefulExcerpt(msg, 1_500)}`);
    }

    let stop = false;
    for (const step of VERIFY_STEPS) {
      const command = commandFor(input, step);
      if (!command) {
        steps.push({ step, status: "skipped" });
        continue;
      }
      // La relance n'a de sens que si le premier passage du test a réussi.
      const testPassed = steps.some((s) => s.step === "test" && s.status === "passed");
      if (stop || (step === "rerun" && !testPassed)) {
        steps.push({ step, command, status: "not_run" });
        continue;
      }
      say(`    ${STEP_NAME[step]} : ${step === "rerun" ? "même commande, même worktree" : command}`);
      const res = await deps.gitops.run(deps.worktreePath, command, deps.timeoutMs);
      if (res.exitCode === 0 && !res.timedOut) {
        say(`      ok (${fmtMs(res.durationMs)})`);
        steps.push({ step, command, status: "passed", exitCode: 0, durationMs: res.durationMs });
        continue;
      }
      const diagnosis = diagnose(step, res);
      say(`      échec (${res.timedOut ? "timeout" : `code ${res.exitCode}`}, ${fmtMs(res.durationMs)})`);
      steps.push({
        step,
        command,
        status: "failed",
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        diagnosis,
        excerpt: usefulExcerpt(res.output),
      });
      // Des tests rouges sur la branche par défaut n'empêchent pas de vérifier le build ; tout autre échec arrête.
      if (!(step === "test" && diagnosis === "tests_failed")) stop = true;
    }
    return done(verdictOf(steps));
  } finally {
    await deps.gitops.removeWorktree(project, deps.worktreePath).catch(() => undefined);
  }
}

const STEP_LABEL: Record<StepResult["status"], string> = {
  passed: "ok",
  failed: "échec",
  skipped: "aucune commande",
  not_run: "non lancé",
};

const DIAGNOSIS_LABEL: Record<Diagnosis, string> = {
  command_not_found: "commande introuvable",
  environment: "problème d'environnement probable (version, module ou dépendance manquants)",
  tests_failed: "des tests échouent",
  not_rerunnable: "passe une fois mais échoue relancée dans le même worktree (sorties d'un passage précédent ou du build analysées ?)",
  timeout: "délai dépassé",
  error: "erreur",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  passed: "commandes vérifiées : setup, tests, build et relance des tests passent",
  baseline_red: "commandes vérifiées, mais des tests échouent déjà sur la branche par défaut",
  broken: "commande cassée",
  refused: "commande refusée avant exécution",
};

/** Rapport lisible (pour l'agent et pour l'affichage), avec les extraits de sortie. */
export function formatReport(r: VerificationReport, opts: { excerpts?: boolean } = {}): string {
  const lines = [`Vérification ${r.attempt} : ${VERDICT_LABEL[r.verdict]} (${fmtMs(r.durationMs)}).`];
  if (r.error) lines.push(`  ${r.error}`);
  for (const s of r.steps) {
    const detail = s.status === "failed" ? ` — ${s.exitCode === -1 ? "tuée" : `code ${s.exitCode}`}, ${DIAGNOSIS_LABEL[s.diagnosis ?? "error"]}` : "";
    lines.push(`  ${STEP_NAME[s.step]} : ${STEP_LABEL[s.status]}${s.command ? ` (${s.command})` : ""}${detail}`);
    if (opts.excerpts !== false && s.excerpt) {
      lines.push(...s.excerpt.split("\n").map((l) => `      ${l}`));
    }
  }
  return lines.join("\n");
}
