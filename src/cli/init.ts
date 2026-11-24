/**
 * `sprintsaver init` : configuration de SprintSaver (ADR § 12, amendements 2 et 5).
 *
 * Partie déterministe : instance GitLab, connexion glab, identité, choix des projets, auteur des commits, et toutes
 * les écritures (labels créés sur GitLab, config). Pour chaque projet, un agent de configuration propose la config
 * complète (commandes vérifiées par une exécution réelle, statuts, labels…) ; le code l'affiche, l'utilisateur la
 * valide, en modifie un champ ou annule. Rien n'est écrit avant validation. Si l'agent échoue, la détection simple
 * et les questions champ par champ prennent le relais.
 *
 * `--yes` : aucune question, propositions acceptées. `--dry-run` : aucune écriture sur GitLab, config affichée ou
 * écrite dans `--output`, jamais dans la config de SprintSaver.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import YAML from "yaml";
import { loadConfig, saveConfig } from "../config/load.js";
import { paths } from "../config/paths.js";
import { ConfigSchema, type Config, type ProjectConfig, type StatusTarget } from "../config/schema.js";
import type { GitOps } from "../contracts.js";
import { configAgentModels, runConfigAgent } from "../agent/config-agent.js";
import { createInitServer, type InitToolsDeps, type InitToolsState } from "../agent/config-tools.js";
import type { QueryFn } from "../agent/runner.js";
import { createGitOps, resolveHome } from "../git/gitops.js";
import {
  analyseProject,
  createLabel,
  defaultProjectName,
  findUserByUsername,
  getCiConfig,
  getProject,
  getUserDetails,
  listAllowedStatuses,
  listLabels,
  listMemberProjects,
  resolveApiBase,
  UserLookupUnavailableError,
  type NativeStatus,
  type ProjectAnalysis,
  type ProjectInfo,
  type StatusRoleName,
  type UserDetails,
} from "../gitlab/discovery.js";
import { createGitLabRest, GitLabHttpError, type FetchFn, type GitLabRest } from "../gitlab/rest.js";
import { glabToken, glabVersion, GlabAuthError, hostOf, type ExecFn, type TokenProvider } from "../gitlab/glab-auth.js";
import { findLocalCheckouts, isCheckoutOf, listIgnoredFiles } from "../init/local-checkout.js";
import {
  CREATE_PREFIX,
  DEFAULT_STATUS_LABELS,
  ROLE_LABELS,
  currentVerification,
  formatProposal,
  labelsToCreate,
  proposalFromAgent,
  proposalFromDetection,
  statusChoices,
  suggestProjectName,
  validateProjectName,
  type LabelSpec,
  type ProjectProposal,
  type ProposalContext,
} from "../init/proposal.js";
import { defaultProbeDeps, listVersionManagers, probeToolchains, type ProbeDeps } from "../init/toolchains.js";
import { verifyCommands, type VerifyInput } from "../init/verify.js";
import { errorMessage } from "../engine/util.js";

export {
  DEFAULT_STATUS_LABELS,
  statusChoices,
  suggestProjectName,
  typeLabelChoices,
  validateProjectName,
  type StatusChoice,
} from "../init/proposal.js";

const NONE = "-";
const out = (s = "") => process.stdout.write(`${s}\n`);

// ---------------------------------------------------------------------------
// Options et dépendances
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Config de SprintSaver (défaut : `$SPRINTSAVER_HOME/config.yaml`). */
  configPath?: string;
  /** Aucune question : propositions acceptées, valeurs existantes ou par défaut pour le reste. */
  yes?: boolean;
  /** Aucune écriture sur GitLab ; config affichée, ou écrite dans `output`, jamais dans `configPath`. */
  dryRun?: boolean;
  /** Projets à configurer (chemin `groupe/projet` ou URL). */
  projects?: string[];
  /** Fichier où écrire la config produite, à la place de `configPath`. */
  output?: string;
  /** Instance GitLab. */
  url?: string;
  /** Username de l'humain à qui assigner les MR (jeton de projet, mode --yes). */
  username?: string;
  /** false : pas d'agent de configuration, détection simple (`--no-agent`). */
  agent?: boolean;
}

/** Questions posées à l'utilisateur (injectable pour les tests). */
export interface Prompter {
  input(o: { message: string; default?: string; required?: boolean; validate?: (v: string) => true | string }): Promise<string>;
  confirm(o: { message: string; default?: boolean }): Promise<boolean>;
  select<T>(o: { message: string; choices: { name: string; value: T }[]; default?: T; pageSize?: number }): Promise<T>;
  checkbox<T>(o: { message: string; choices: { name: string; value: T; checked?: boolean }[]; pageSize?: number; required?: boolean }): Promise<T[]>;
}

const inquirerPrompter: Prompter = {
  input: (o) => input(o),
  confirm: (o) => confirm(o),
  select: (o) => select(o),
  checkbox: (o) => checkbox(o),
};

/** En mode --yes, toute question est un bug : on échoue au lieu d'attendre une réponse. */
const noQuestions: Prompter = {
  input: (o) => Promise.reject(new Error(`question posée en mode --yes : ${o.message}`)),
  confirm: (o) => Promise.reject(new Error(`question posée en mode --yes : ${o.message}`)),
  select: (o) => Promise.reject(new Error(`question posée en mode --yes : ${o.message}`)),
  checkbox: (o) => Promise.reject(new Error(`question posée en mode --yes : ${o.message}`)),
};

export interface InitDeps {
  prompter?: Prompter;
  say?: (s: string) => void;
  /** `fetch` du client GitLab et de la découverte de l'instance. */
  fetch?: FetchFn;
  glabExec?: ExecFn;
  glabLogin?: (host: string) => Promise<boolean>;
  makeGitOps?: (token: TokenProvider) => GitOps;
  queryFn?: QueryFn;
  claudeExecutable?: string;
  probeDeps?: ProbeDeps;
  /** Racines de la recherche de checkout local (défaut : dossiers usuels du dossier personnel). */
  checkoutRoots?: string[];
  gitGlobal?: (key: string) => Promise<string | undefined>;
}

async function gitGlobalDefault(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["config", "--global", key]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x !== NONE);
}

/**
 * Noms des projets existants re-sélectionnés : réservés dès le départ, pour qu'un nouveau projet traité
 * avant eux ne prenne pas leur nom.
 */
export function reservedProjectNames(selectedIds: number[], priorById: Map<number, ProjectConfig>): Set<string> {
  const names = new Set<string>();
  for (const id of selectedIds) {
    const prior = priorById.get(id);
    if (prior) names.add(prior.name);
  }
  return names;
}

/** `groupe/projet`, ou chemin extrait d'une URL de projet (ou d'une de ses pages) sous l'instance `base`. */
export function normalizeProjectArg(arg: string, base?: string): string {
  const a = arg.trim();
  if (!/^https?:\/\//i.test(a)) return a.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const u = new URL(a);
  let path = decodeURIComponent(u.pathname.split("/-/")[0]!);
  const basePath = base ? new URL(base).pathname.replace(/\/+$/, "") : "";
  if (basePath && path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
}

async function readExisting(file: string, say: (s: string) => void): Promise<Config | null> {
  if (!existsSync(file)) return null;
  try {
    return await loadConfig(file);
  } catch (err) {
    say(`⚠ Config existante illisible, elle sera remplacée : ${errorMessage(err)}`);
    return null;
  }
}

/** Crée un label en tolérant qu'il existe déjà (409). */
async function ensureLabel(rest: GitLabRest, projectId: number, spec: LabelSpec, say: (s: string) => void): Promise<void> {
  try {
    await createLabel(rest, projectId, spec.name, spec.color, spec.description);
    say(`  Label « ${spec.name} » créé.`);
  } catch (err) {
    if (err instanceof GitLabHttpError && err.status === 409) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Connexion et identité
// ---------------------------------------------------------------------------

/**
 * Jeton de projet : demande le username GitLab de l'humain à qui assigner les MR et résout son id
 * (`GET /users?username=`). Redemande tant que le username est introuvable. Jamais le bot du jeton.
 */
export async function resolveHumanUser(
  rest: GitLabRest,
  ask: (defaultUsername: string | undefined) => Promise<string>,
  defaultUsername: string | undefined,
  say: (s: string) => void = out,
  askId: (username: string) => Promise<number> = (username) =>
    input({
      message: `Ton id utilisateur GitLab (nombre affiché sur ta page de profil, @${username})`,
      validate: (v) => (/^\d+$/.test(v.trim()) ? true : "Un nombre est attendu."),
    }).then((v) => Number(v.trim())),
): Promise<UserDetails> {
  for (;;) {
    const username = (await ask(defaultUsername)).trim().replace(/^@/, "");
    if (!username) continue;
    try {
      const user = await findUserByUsername(rest, username);
      if (user) return user;
    } catch (err) {
      if (!(err instanceof UserLookupUnavailableError)) throw err;
      say(`  ${err.message} Indique ton id directement.`);
      return { id: await askId(username), username, name: username };
    }
    say(`  Utilisateur GitLab « ${username} » introuvable. Vérifie l'orthographe de ton username.`);
    defaultUsername = undefined;
  }
}

/** Lance `glab auth login` dans le terminal de l'utilisateur (interactif). */
async function runGlabLogin(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("glab", ["auth", "login", "--hostname", host], { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Vérifie la connexion glab pour `host` (ADR, amendement 2) et propose de la créer si elle manque. Renvoie le
 * fournisseur de jeton ; SprintSaver ne voit le jeton qu'en mémoire et ne l'écrit nulle part.
 */
export async function ensureGlabConnection(
  host: string,
  deps: {
    exec?: ExecFn;
    confirmLogin?: () => Promise<boolean>;
    login?: (host: string) => Promise<boolean>;
    say?: (s: string) => void;
  } = {},
): Promise<TokenProvider> {
  const say = deps.say ?? out;
  const version = await glabVersion(deps.exec);
  if (!version) {
    throw new GlabAuthError(
      `glab introuvable : installe la CLI GitLab (\`brew install glab\`), connecte-toi avec \`glab auth login --hostname ${host}\`, puis relance \`sprintsaver init\`.`,
    );
  }
  const provider = glabToken(host, deps.exec);
  try {
    await provider.get();
    say(`Connexion glab trouvée pour ${host} (${version}). Aucun jeton n'est stocké par SprintSaver.`);
    return provider;
  } catch (err) {
    if (!(err instanceof GlabAuthError)) throw err;
    say(`glab n'est pas connecté à ${host}.`);
  }
  const wants = await (deps.confirmLogin ?? (() => confirm({ message: `Lancer \`glab auth login --hostname ${host}\` maintenant ?`, default: true })))();
  if (!wants || !(await (deps.login ?? runGlabLogin)(host))) {
    throw new GlabAuthError(`Connexion glab requise : lance \`glab auth login --hostname ${host}\`, puis relance \`sprintsaver init\`.`);
  }
  await provider.refresh();
  say(`Connexion glab établie pour ${host}.`);
  return provider;
}

// ---------------------------------------------------------------------------
// Édition d'un champ (validation, et questions du repli)
// ---------------------------------------------------------------------------

export const EDITABLE_FIELDS = [
  ["name", "Nom court"],
  ["localCheckout", "Checkout local"],
  ["setupCommand", "Commande de setup"],
  ["buildCommand", "Commande de build"],
  ["testCommand", "Commande de test"],
  ["testMode", "Mode de test"],
  ["ciSource", "Pipeline surveillé"],
  ["worktreeInclude", "Fichiers ignorés à copier (config locale, secrets de dev)"],
  ["cowDirs", "Dossiers de dépendances (copy-on-write)"],
  ["status.inProgress", "Statut « en cours »"],
  ["status.inReview", "Statut « livré en review »"],
  ["status.blocked", "Statut « bloqué »"],
  ["typeLabels.bug", "Labels « bug »"],
  ["typeLabels.feature", "Labels « feature »"],
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number][0];

const COMMAND_FIELDS = new Set<EditableField>(["setupCommand", "buildCommand", "testCommand", "worktreeInclude", "cowDirs", "localCheckout"]);

/**
 * Choix des labels d'un type pendant l'édition : labels existants (cochés s'ils sont retenus), labels retenus qui
 * n'existent pas encore (« à créer », cochés), et création du label au nom du type.
 */
export function typeLabelEditChoices(type: "bug" | "feature", labels: string[], current: string[]): { name: string; value: string; checked: boolean }[] {
  const missing = current.filter((l) => !labels.includes(l));
  return [
    ...labels.map((l) => ({ name: l, value: l, checked: current.includes(l) })),
    ...missing.map((l) => ({ name: `Créer le label « ${l} »`, value: `${CREATE_PREFIX}${l}`, checked: true })),
    ...(labels.includes(type) || missing.includes(type) ? [] : [{ name: `Créer le label « ${type} »`, value: `${CREATE_PREFIX}${type}`, checked: false }]),
  ];
}

async function optionalInput(ask: Prompter, message: string, def: string | undefined): Promise<string | undefined> {
  const v = await ask.input({ message: `${message} (« ${NONE} » pour aucune)`, default: def ?? NONE });
  const t = v.trim();
  return t && t !== NONE ? t : undefined;
}

async function askStatusTarget(ask: Prompter, role: StatusRoleName, natives: NativeStatus[], labels: string[], current: StatusTarget): Promise<StatusTarget> {
  const { choices, defaultValue } = statusChoices(role, natives, labels, current);
  const value = await ask.select({
    message: `Statut « ${ROLE_LABELS[role]} » (un label absent sera créé après validation)`,
    choices: choices.map(({ name, value }) => ({ name, value })),
    default: defaultValue,
    pageSize: 15,
  });
  const choice = choices.find((c) => c.value === value)!.choice;
  if (choice.kind === "native") return choice;
  if (choice.kind === "label" || choice.kind === "create") return { kind: "label", name: choice.name };
  const name = (await ask.input({ message: `Nom du label « ${ROLE_LABELS[role]} »`, default: DEFAULT_STATUS_LABELS[role].name, required: true })).trim();
  return { kind: "label", name };
}

interface FieldContext {
  ask: Prompter;
  labels: string[];
  natives: NativeStatus[];
  usedNames: Set<string>;
  priorName?: string;
}

/** Pose la question d'un champ et met à jour la config proposée. */
export async function editField(field: EditableField, c: ProjectConfig, fc: FieldContext): Promise<void> {
  const { ask } = fc;
  switch (field) {
    case "name":
      c.name = (await ask.input({ message: "Nom court du projet", default: c.name, validate: (v) => validateProjectName(v.trim(), fc.usedNames, fc.priorName) })).trim();
      return;
    case "localCheckout":
      c.localCheckout = (await optionalInput(ask, "Ton checkout local de ce projet, d'où copier .env et dossiers de dépendances (ex. ~/code/projet)", c.localCheckout)) ?? undefined;
      return;
    case "setupCommand":
      c.setupCommand = await optionalInput(ask, "Commande de setup", c.setupCommand);
      return;
    case "buildCommand":
      c.buildCommand = await optionalInput(ask, "Commande de build", c.buildCommand);
      return;
    case "testCommand":
      c.testCommand = await optionalInput(ask, "Commande de test", c.testCommand);
      return;
    case "testMode":
      c.testMode = await ask.select({
        message: "Mode de test",
        choices: [
          { name: "local (tests lancés dans le worktree)", value: "local" as const },
          { name: "ci-only (les tests passent par la CI)", value: "ci-only" as const },
        ],
        default: c.testMode,
      });
      return;
    case "ciSource":
      c.ciSource = await ask.select({
        message: "Pipeline à surveiller après un push",
        choices: [
          { name: "pipeline de merge request", value: "merge_request" as const },
          { name: "pipeline de branche", value: "branch" as const },
        ],
        default: c.ciSource,
      });
      return;
    case "worktreeInclude":
    case "cowDirs": {
      const message =
        field === "worktreeInclude"
          ? `Fichiers ignorés par git nécessaires pour lancer les tests et l'application (config d'environnement locale, secrets de dev), copiés depuis le checkout local (séparés par des virgules, « ${NONE} » pour aucun)`
          : `Dossiers de dépendances à cloner en copy-on-write (séparés par des virgules, « ${NONE} » pour aucun)`;
      const current = c[field];
      c[field] = splitList(await ask.input({ message, default: current.length ? current.join(", ") : NONE }));
      return;
    }
    case "status.inProgress":
    case "status.inReview":
    case "status.blocked": {
      const role = field.slice("status.".length) as StatusRoleName;
      c.status[role] = await askStatusTarget(ask, role, fc.natives, fc.labels, c.status[role]);
      return;
    }
    case "typeLabels.bug":
    case "typeLabels.feature": {
      const type = field.slice("typeLabels.".length) as "bug" | "feature";
      const picked = await ask.checkbox({
        message: `Labels désignant un ticket « ${type} » (un label absent sera créé après validation)`,
        choices: typeLabelEditChoices(type, fc.labels, c.typeLabels[type]),
        pageSize: 15,
      });
      c.typeLabels[type] = picked.map((v) => (v.startsWith(CREATE_PREFIX) ? v.slice(CREATE_PREFIX.length) : v));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Un projet
// ---------------------------------------------------------------------------

interface InitEnv {
  opts: InitOptions;
  deps: InitDeps;
  ask: Prompter;
  say: (s: string) => void;
  rest: GitLabRest;
  gitops: GitOps;
  existing: Config | null;
  triggerLabel: string;
}

interface ConfiguredProject {
  proposal: ProjectProposal;
  labels: string[];
  /** Nom du clone de référence créé pendant init (renommé si le nom court final diffère). */
  cloneName: string;
}

function provisionalProject(info: ProjectInfo, name: string): ProjectConfig {
  return {
    name,
    id: info.id,
    path: info.pathWithNamespace,
    httpUrl: info.httpUrl,
    defaultBranch: info.defaultBranch,
    testMode: "local",
    ciSource: "merge_request",
    worktreeInclude: [],
    cowDirs: [],
    status: { inProgress: { kind: "label", name: "x" }, inReview: { kind: "label", name: "x" }, blocked: { kind: "label", name: "x" } },
    typeLabels: { bug: [], feature: [] },
  };
}

const verifyInputOf = (c: ProjectConfig): VerifyInput => ({
  setupCommand: c.setupCommand,
  buildCommand: c.buildCommand,
  testCommand: c.testCommand,
  worktreeInclude: c.worktreeInclude,
  cowDirs: c.cowDirs,
  ...(c.localCheckout ? { localCheckout: resolveHome(c.localCheckout) } : {}),
});

function timeoutMs(env: InitEnv): number {
  return (env.existing?.limits.commandTimeoutMin ?? 20) * 60_000;
}

async function agentProposal(env: InitEnv, ctx: ProposalContext, cloneName: string): Promise<ProjectProposal> {
  const { info, prior } = ctx;
  const { say, gitops, deps } = env;
  const project0 = provisionalProject(info, cloneName);
  say("  Clone de référence du dépôt…");
  await gitops.ensureReferenceClone(project0);
  const workdir = paths.worktree(`init-${info.id}`);
  await gitops.createDetachedWorktree(project0, workdir);
  const probeDeps = deps.probeDeps ?? defaultProbeDeps();
  const state: InitToolsState = { reports: [], refusedCalls: 0 };
  const toolsDeps: InitToolsDeps = {
    info,
    prior,
    takenNames: [...ctx.usedNames].filter((n) => n !== prior?.name),
    suggestedName: cloneName,
    triggerLabel: env.triggerLabel,
    listLabels: async () => ctx.labels.map((name) => ({ name, color: "" })),
    listStatuses: async () => ctx.natives,
    ciConfig: () => getCiConfig(env.rest, info.id, info.defaultBranch),
    findCheckouts: () => findLocalCheckouts(info.httpUrl, { ...(deps.checkoutRoots ? { roots: deps.checkoutRoots } : {}), exclude: [paths.home()] }),
    isCheckout: (dir) => isCheckoutOf(dir, info.httpUrl),
    listIgnored: (dir) => listIgnoredFiles(dir),
    probe: (tools) => probeToolchains(tools, workdir, probeDeps),
    versionManagers: () => listVersionManagers(workdir, probeDeps),
    verify: (input, attempt) =>
      verifyCommands(input, attempt, { gitops, project: project0, worktreePath: paths.worktree(`init-${info.id}-verif`), timeoutMs: timeoutMs(env), say }),
    say,
  };
  const transcriptPath =
    (env.existing?.transcripts.enabled ?? true) ? join(paths.runsDir(), "init", `${info.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`) : undefined;
  try {
    say("  Agent de configuration : lecture du dépôt, versions de toolchain, vérification réelle (plusieurs minutes)…");
    const res = await runConfigAgent({
      cwd: workdir,
      projectPath: info.pathWithNamespace,
      server: createInitServer(toolsDeps, state),
      models: configAgentModels(env.existing),
      ...(deps.queryFn ? { queryFn: deps.queryFn } : {}),
      ...(deps.claudeExecutable ? { claudeExecutable: deps.claudeExecutable } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      say,
    });
    say(`  (agent : ${res.turns} tours, ${Math.round(res.durationMs / 1000)} s, coût estimé ~$${res.costUsd.toFixed(2)}${transcriptPath ? `, transcript ${transcriptPath}` : ""})`);
    return proposalFromAgent(res.proposal, ctx, state.reports);
  } finally {
    await gitops.removeWorktree(project0, workdir).catch(() => undefined);
  }
}

/** Repli : détection simple, puis (en interactif) les questions champ par champ. */
async function fallbackProposal(env: InitEnv, ctx: ProposalContext, reason?: string): Promise<ProjectProposal> {
  let analysis: ProjectAnalysis | null = null;
  try {
    analysis = await analyseProject(env.rest, ctx.info.id, ctx.info.defaultBranch);
  } catch (err) {
    env.say(`  ⚠ Détection simple impossible : ${errorMessage(err)}`);
  }
  const p = proposalFromDetection(ctx, analysis, reason);
  if (analysis) {
    env.say(`  CI : ${analysis.hasCi ? `présente, pipeline ${analysis.ciSource === "merge_request" ? "de MR" : "de branche"}` : "absente"}`);
  }
  if (!env.opts.yes) {
    const fc: FieldContext = { ask: env.ask, labels: ctx.labels, natives: ctx.natives, usedNames: ctx.usedNames, priorName: ctx.prior?.name };
    for (const [field] of EDITABLE_FIELDS) {
      // Le `.worktreeinclude` versionné prime : la liste de la config n'est qu'un repli, on ne la redemande pas.
      if (field === "worktreeInclude" && analysis?.hasWorktreeInclude) continue;
      await editField(field, p.config, fc);
    }
  }
  return p;
}

type Outcome = ConfiguredProject | "skip" | "abort";

async function configureProject(env: InitEnv, info: ProjectInfo, prior: ProjectConfig | undefined, usedNames: Set<string>): Promise<Outcome> {
  const { say, ask, opts } = env;
  say("");
  say(`── ${info.pathWithNamespace} ──`);
  const labels = (await listLabels(env.rest, info.id)).map((l) => l.name);
  const natives = await listAllowedStatuses(env.rest, info.pathWithNamespace);
  const others = new Set([...usedNames].filter((n) => n !== prior?.name));
  const ctx: ProposalContext = { info, prior, labels, natives, usedNames: others };
  const cloneName = suggestProjectName(defaultProjectName(info.pathWithNamespace), others, prior?.name);

  const wantsAgent =
    opts.agent !== false &&
    (opts.yes || !prior || (await ask.confirm({ message: "Relancer l'agent de configuration sur ce projet ? (sinon la config actuelle est proposée)", default: false })));
  let proposal: ProjectProposal;
  if (wantsAgent) {
    try {
      proposal = await agentProposal(env, ctx, cloneName);
    } catch (err) {
      const reason = `Agent de configuration impossible (${errorMessage(err).split("\n")[0]}) : proposition par détection simple.`;
      say(`  ⚠ ${reason}`);
      proposal = await fallbackProposal(env, ctx, reason);
    }
  } else if (prior) {
    proposal = proposalFromDetection(ctx, null);
  } else {
    proposal = await fallbackProposal(env, ctx);
  }

  if (opts.yes) {
    for (const l of formatProposal(proposal, labelsToCreate(proposal.config, labels, env.triggerLabel))) say(l);
    const v = currentVerification(proposal);
    if (!v || v.verdict === "broken" || v.verdict === "refused") {
      say(`  ⚠ Commandes ${v ? "cassées" : "non vérifiées"} : acceptées (--yes), mais le premier ticket risque d'être bloqué. Corrige la config ou relance init.`);
    }
    return { proposal, labels, cloneName };
  }

  const fc: FieldContext = { ask, labels, natives, usedNames: others, priorName: prior?.name };
  for (;;) {
    say("");
    for (const l of formatProposal(proposal, labelsToCreate(proposal.config, labels, env.triggerLabel))) say(l);
    const action = await ask.select({
      message: `Config de ${info.pathWithNamespace}`,
      choices: [
        { name: "Valider", value: "accept" as const },
        { name: "Modifier un champ", value: "edit" as const },
        { name: "Revérifier les commandes (exécution réelle)", value: "verify" as const },
        { name: "Ignorer ce projet", value: "skip" as const },
        { name: "Tout annuler (rien n'est écrit)", value: "abort" as const },
      ],
      default: "accept",
    });
    if (action === "accept") return { proposal, labels, cloneName };
    if (action === "skip" || action === "abort") return action;
    if (action === "verify") {
      const project0 = provisionalProject(info, cloneName);
      try {
        await env.gitops.ensureReferenceClone(project0);
        say(`  Vérification des commandes (worktree jetable de ${info.defaultBranch})…`);
        proposal.reports.push(
          await verifyCommands(verifyInputOf(proposal.config), proposal.reports.length + 1, {
            gitops: env.gitops,
            project: project0,
            worktreePath: paths.worktree(`init-${info.id}-verif`),
            timeoutMs: timeoutMs(env),
            say,
          }),
        );
      } catch (err) {
        say(`  ⚠ Vérification impossible : ${errorMessage(err)}`);
      }
      continue;
    }
    const field = await ask.select({
      message: "Champ à modifier",
      choices: EDITABLE_FIELDS.map(([value, name]) => ({ name, value })),
      pageSize: EDITABLE_FIELDS.length,
    });
    await editField(field, proposal.config, fc);
    if (field === "testCommand" && !proposal.config.testCommand && proposal.config.testMode === "local") {
      say("  ⚠ Sans commande de test, le mode local ne peut rien vérifier : pense à passer le mode de test en ci-only.");
    }
    if (COMMAND_FIELDS.has(field) && proposal.reports.length > 0) say("  Les commandes ont changé : « Revérifier les commandes » relance l'exécution réelle.");
  }
}

// ---------------------------------------------------------------------------
// Commande
// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions = {}, deps: InitDeps = {}): Promise<void> {
  const say = deps.say ?? out;
  const ask = opts.yes ? noQuestions : (deps.prompter ?? inquirerPrompter);
  const file = opts.configPath ?? paths.config();
  const outputFile = opts.output ? resolve(resolveHome(opts.output)) : undefined;
  if (opts.dryRun && outputFile && outputFile === resolve(file)) {
    throw new Error("--dry-run n'écrit jamais la config de SprintSaver : choisis un autre fichier pour --output.");
  }
  if (opts.dryRun) say("Mode --dry-run : rien n'est écrit sur GitLab ni dans la config de SprintSaver (clone de référence et worktrees jetables restent locaux).");

  const existing = await readExisting(file, say);
  if (existing) say(`Config existante trouvée (${file}) : ses valeurs sont proposées par défaut.`);

  const projectArgs = opts.projects ?? [];
  const urlDefault = projectArgs.find((p) => /^https?:\/\//i.test(p)) ?? existing?.gitlab.url ?? "https://gitlab.com";
  const typedUrl = (
    opts.url ??
    (opts.yes
      ? urlDefault
      : await ask.input({
          message: "Adresse de l'instance GitLab (ex. https://gitlab.com ; une URL de projet est aussi acceptée)",
          default: urlDefault,
          validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? true : "URL http(s) attendue."),
        }))
  ).trim();
  // Une URL de projet (…/groupe/projet) ferait viser une API inexistante : on retrouve l'adresse de l'instance.
  const { base: url, projectPath } = await resolveApiBase(typedUrl, deps.fetch);
  if (url !== typedUrl.replace(/\/+$/, "")) say(`Adresse de l'instance : ${url}${projectPath ? ` (projet ${projectPath} présélectionné)` : ""}.`);

  const host = hostOf(url);
  const token = await ensureGlabConnection(host, {
    ...(deps.glabExec ? { exec: deps.glabExec } : {}),
    ...(deps.glabLogin ? { login: deps.glabLogin } : {}),
    confirmLogin: opts.yes ? async () => false : () => ask.confirm({ message: `Lancer \`glab auth login --hostname ${host}\` maintenant ?`, default: true }),
    say,
  });
  const rest = createGitLabRest(url, token, deps.fetch ? { fetch: deps.fetch } : undefined);
  const user = await resolveIdentity(rest, opts, existing, ask, say);

  // Projets
  const wanted = [...projectArgs.map((p) => normalizeProjectArg(p, url)), ...(projectPath ? [projectPath] : [])].filter(Boolean);
  const priorById = new Map((existing?.projects ?? []).map((p) => [p.id, p]));
  let selected: ProjectInfo[];
  if (opts.yes) {
    if (wanted.length > 0) selected = await Promise.all([...new Set(wanted)].map((p) => getProject(rest, p)));
    else if (existing?.projects.length) selected = await Promise.all(existing.projects.map((p) => getProject(rest, p.id)));
    else throw new Error("--yes : indique au moins un projet avec --project <groupe/projet>.");
  } else {
    say("Recherche des projets accessibles…");
    const projects = await listMemberProjects(rest);
    for (const w of wanted) {
      if (!projects.some((p) => p.pathWithNamespace.toLowerCase() === w.toLowerCase())) projects.unshift(await getProject(rest, w));
    }
    if (projects.length === 0) throw new Error("Aucun projet accessible avec la connexion glab.");
    const ids = await ask.checkbox({
      message: "Projets à surveiller",
      choices: projects.map((p) => ({
        name: p.pathWithNamespace,
        value: p.id,
        checked: priorById.has(p.id) || wanted.some((w) => w.toLowerCase() === p.pathWithNamespace.toLowerCase()),
      })),
      pageSize: 20,
      required: true,
    });
    selected = ids.map((id) => projects.find((p) => p.id === id)!);
  }
  // En --yes, les projets suivis non cités restent tels quels.
  const kept = opts.yes ? (existing?.projects ?? []).filter((p) => !selected.some((s) => s.id === p.id)) : [];

  const triggerLabel = existing?.triggerLabel ?? "auto::ready";
  const usedNames = reservedProjectNames(selected.map((s) => s.id), priorById);
  for (const k of kept) usedNames.add(k.name);
  const gitops = (deps.makeGitOps ?? ((t) => createGitOps({ token: t })))(token);
  const env: InitEnv = { opts, deps, ask, say, rest, gitops, existing, triggerLabel };

  const configured: ConfiguredProject[] = [];
  for (const info of selected) {
    const prior = priorById.get(info.id);
    const res = await configureProject(env, info, prior, usedNames);
    if (res === "abort") {
      say("Init annulé : rien n'a été écrit, ni sur GitLab ni dans la config.");
      return;
    }
    if (res === "skip") {
      say(`  ${info.pathWithNamespace} ignoré.`);
      continue;
    }
    if (prior && prior.name !== res.proposal.config.name) usedNames.delete(prior.name);
    usedNames.add(res.proposal.config.name);
    configured.push(res);
  }
  if (configured.length === 0 && kept.length === 0) {
    say("Aucun projet retenu : rien n'a été écrit.");
    return;
  }

  // Identité git des commits
  const gitGlobal = deps.gitGlobal ?? gitGlobalDefault;
  let authorName: string | undefined;
  let authorEmail: string | undefined;
  if (opts.yes) {
    authorName = existing?.git.authorName ?? user.name ?? (await gitGlobal("user.name"));
    authorEmail = existing?.git.authorEmail ?? user.email ?? (await gitGlobal("user.email"));
    if (!authorEmail) say("⚠ Aucun email d'auteur de commit trouvé (config, GitLab, git) : celui de la config git globale sera utilisé.");
  } else {
    say("");
    say("── Identité git des commits ──");
    authorName = (
      await ask.input({ message: "Nom de l'auteur des commits", default: existing?.git.authorName ?? user.name ?? (await gitGlobal("user.name")), required: true })
    ).trim();
    authorEmail = (
      await ask.input({
        message: "Email de l'auteur des commits",
        default: existing?.git.authorEmail ?? user.email ?? (await gitGlobal("user.email")),
        required: true,
        validate: (v) => (/^\S+@\S+$/.test(v.trim()) ? true : "Email invalide."),
      })
    ).trim();
  }

  // Aucun jeton dans la config : la connexion reste celle de glab (ADR, amendement 2).
  const config: Config = ConfigSchema.parse({
    ...(existing ?? {}),
    gitlab: { url, username: user.username, userId: user.id },
    git: { ...(authorName ? { authorName } : {}), ...(authorEmail ? { authorEmail } : {}) },
    triggerLabel,
    projects: [...kept, ...configured.map((c) => c.proposal.config)],
  });

  // Écritures, après validation seulement.
  say("");
  for (const c of configured) {
    const toCreate = labelsToCreate(c.proposal.config, c.labels, triggerLabel);
    if (toCreate.length === 0) continue;
    if (opts.dryRun) {
      say(`Labels qui seraient créés sur ${c.proposal.info.pathWithNamespace} : ${toCreate.map((l) => l.name).join(", ")}.`);
      continue;
    }
    say(`Labels de ${c.proposal.info.pathWithNamespace} :`);
    for (const spec of toCreate) await ensureLabel(rest, c.proposal.info.id, spec, say);
  }
  if (!opts.dryRun) {
    for (const c of configured) await renameReferenceClone(c.cloneName, c.proposal.config.name, say);
  }

  const yaml = YAML.stringify(config);
  if (opts.dryRun && !outputFile) {
    say("── Config produite (non écrite) ──");
    say(yaml.trimEnd());
  } else {
    await saveConfig(config, outputFile ?? file);
  }

  say("");
  say("── Résumé ──");
  say(`GitLab : ${url} via glab — MR assignées à @${user.username}`);
  say(`Label déclencheur : ${triggerLabel}`);
  say(`Commits : ${authorName ?? "?"} <${authorEmail ?? "?"}>`);
  for (const p of config.projects) {
    const c = configured.find((x) => x.proposal.config.id === p.id);
    const v = c ? currentVerification(c.proposal) : undefined;
    say(`• ${p.name} — ${p.path} [${p.defaultBranch}]${c ? "" : " (inchangé)"}`);
    say(`    stack ${p.stack ?? "?"}, tests ${p.testMode}${p.testCommand ? ` : ${p.testCommand}` : ""}, CI ${p.ciSource}`);
    if (c) say(`    commandes ${v ? (v.verdict === "passed" ? "vérifiées" : v.verdict === "baseline_red" ? "vérifiées (tests déjà rouges sur la branche par défaut)" : "cassées") : "non vérifiées"}`);
    if (c?.proposal.prerequisites.length) say(`    prérequis : ${c.proposal.prerequisites.join(" ; ")}`);
  }
  say("");
  if (opts.dryRun) say(outputFile ? `Config écrite dans ${outputFile} (--dry-run : config de SprintSaver inchangée).` : "Config non écrite (--dry-run).");
  else say(`Config écrite dans ${outputFile ?? file} (aucun jeton : la connexion reste gérée par glab).`);
}

async function resolveIdentity(rest: GitLabRest, opts: InitOptions, existing: Config | null, ask: Prompter, say: (s: string) => void): Promise<UserDetails> {
  const identity = await getUserDetails(rest);
  if (identity.kind === "personal") {
    say(`glab est connecté en tant que ${identity.user.name} (@${identity.user.username}).`);
    return identity.user;
  }
  say("glab est connecté avec un jeton de projet (GET /user indisponible) : les MR seront ouvertes par le bot du projet.");
  let user: UserDetails;
  if (opts.yes) {
    const username = (opts.username ?? existing?.gitlab.username)?.trim().replace(/^@/, "");
    if (!username) throw new Error("Jeton de projet : indique ton username GitLab avec --username (mode --yes).");
    let found: UserDetails | null = null;
    try {
      found = await findUserByUsername(rest, username);
    } catch (err) {
      if (!(err instanceof UserLookupUnavailableError)) throw err;
      if (existing?.gitlab.username === username) found = { id: existing.gitlab.userId, username, name: username };
      else throw new Error(`${err.message} Lance init en interactif pour indiquer ton id.`);
    }
    if (!found) throw new Error(`Utilisateur GitLab « ${username} » introuvable.`);
    user = found;
  } else {
    say("Les MR te seront assignées : indique ton username GitLab (le tien, pas celui du bot).");
    user = await resolveHumanUser(rest, (def) => ask.input({ message: "Ton username GitLab", default: def, required: true }), opts.username ?? existing?.gitlab.username, say);
  }
  say(`MR assignées à ${user.name} (@${user.username}, id ${user.id}).`);
  return user;
}

/** Le clone de référence a été créé sous un nom provisoire : il suit le nom court retenu. */
async function renameReferenceClone(from: string, to: string, say: (s: string) => void): Promise<void> {
  if (from === to) return;
  const src = paths.repo(from);
  const dst = paths.repo(to);
  if (!existsSync(src) || existsSync(dst)) return;
  try {
    await rename(src, dst);
  } catch (err) {
    say(`  ⚠ Clone de référence ${src} non renommé (${errorMessage(err)}) : il sera recloné au premier ticket.`);
  }
}
