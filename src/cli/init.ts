/**
 * `sprintsaver init` : configuration interactive (GitLab, projets, commandes, statuts, labels, identité git).
 * Relit la config existante pour pré-remplir les réponses ; la config produite reste éditable à la main.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { loadConfig, saveConfig } from "../config/load.js";
import { paths } from "../config/paths.js";
import {
  ConfigSchema,
  ProjectConfigSchema,
  type Config,
  type ProjectConfig,
  type StatusMapping,
  type StatusTarget,
} from "../config/schema.js";
import { detectProjectCommands, type DetectedCommands } from "../agent/detect-commands.js";
import { createGitOps, resolveHome } from "../git/gitops.js";
import {
  analyseProject,
  createLabel,
  defaultProjectName,
  findUserByUsername,
  getUserDetails,
  resolveApiBase,
  UserLookupUnavailableError,
  guessForRole,
  guessTypeLabels,
  listAllowedStatuses,
  listLabels,
  listMemberProjects,
  type NativeStatus,
  type ProjectInfo,
  type StatusRoleName,
  type UserDetails,
} from "../gitlab/discovery.js";
import { createGitLabRest, GitLabHttpError, type GitLabRest } from "../gitlab/rest.js";
import {
  glabToken,
  glabVersion,
  GlabAuthError,
  hostOf,
  type ExecFn,
  type TokenProvider,
} from "../gitlab/glab-auth.js";

const TRIGGER_LABEL_COLOR = "#6699cc";
const NONE = "-";
const ROLE_LABELS: Record<StatusRoleName, string> = {
  inProgress: "en cours",
  inReview: "livré en review",
  blocked: "bloqué",
};

const out = (s = "") => process.stdout.write(`${s}\n`);

async function gitGlobal(key: string): Promise<string | undefined> {
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

/** Saisie optionnelle : `-` pour vider. */
async function optionalInput(message: string, def: string | undefined): Promise<string | undefined> {
  const v = await input({ message: `${message} (« ${NONE} » pour aucune)`, default: def ?? NONE });
  const t = v.trim();
  return t && t !== NONE ? t : undefined;
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

/** Valide un nom court ; `ownName` (nom actuel du projet) reste autorisé pour lui-même. */
export function validateProjectName(v: string, usedNames: Set<string>, ownName?: string): true | string {
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(v)) return "Lettres, chiffres, - et _ uniquement (commence par une lettre ou un chiffre).";
  if (usedNames.has(v) && v !== ownName) return "Nom déjà utilisé par un autre projet.";
  return true;
}

/** Nom proposé par défaut : le nom actuel, sinon `base` suffixé (-2, -3…) s'il est déjà pris. */
export function suggestProjectName(base: string, usedNames: Set<string>, ownName?: string): string {
  if (ownName) return ownName;
  if (!usedNames.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!usedNames.has(candidate)) return candidate;
  }
}

async function readExisting(file: string): Promise<Config | null> {
  if (!existsSync(file)) return null;
  try {
    return await loadConfig(file);
  } catch (err) {
    out(`⚠ Config existante illisible, elle sera remplacée : ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Labels de statut proposés à la création quand le projet n'a rien d'adapté. */
export const DEFAULT_STATUS_LABELS: Record<StatusRoleName, { name: string; color: string; description: string }> = {
  inProgress: { name: "sprintsaver::en-cours", color: "#1f75cb", description: "SprintSaver traite ce ticket." },
  inReview: { name: "sprintsaver::en-review", color: "#108548", description: "SprintSaver a livré une MR à relire." },
  blocked: { name: "sprintsaver::bloque", color: "#dd2b0e", description: "SprintSaver est bloqué : voir son dernier commentaire." },
};

const TYPE_LABEL_COLORS = { bug: "#dd2b0e", feature: "#428bca" } as const;

export type StatusChoice =
  | { kind: "native"; id: string; name: string }
  | { kind: "label"; name: string }
  | { kind: "create"; name: string }
  | { kind: "create-other" };

function choiceValue(c: StatusChoice): string {
  return c.kind === "native" ? `native:${c.id}` : c.kind === "create-other" ? "create-other" : `${c.kind}:${c.name}`;
}

/**
 * Choix proposés pour un rôle de statut : statuts natifs, labels existants, création du label proposé s'il
 * n'existe pas, création d'un autre label. Défaut : la cible actuelle si elle existe encore, sinon le statut natif
 * ou le label qui ressemble au rôle, sinon la création du label proposé.
 */
export function statusChoices(
  role: StatusRoleName,
  natives: NativeStatus[],
  labels: string[],
  prior: StatusTarget | undefined,
): { choices: { name: string; value: string; choice: StatusChoice }[]; defaultValue: string } {
  const proposed = DEFAULT_STATUS_LABELS[role].name;
  const choices: { name: string; value: string; choice: StatusChoice }[] = [
    ...natives.map((n) => ({ name: `Statut natif : ${n.name}`, choice: { kind: "native" as const, id: n.id, name: n.name } })),
    ...labels.map((l) => ({ name: `Label : ${l}`, choice: { kind: "label" as const, name: l } })),
    ...(labels.includes(proposed) ? [] : [{ name: `Créer le label « ${proposed} »`, choice: { kind: "create" as const, name: proposed } }]),
    { name: "Créer un autre label…", choice: { kind: "create-other" as const } },
  ].map((c) => ({ ...c, value: choiceValue(c.choice) }));

  let def: StatusChoice | undefined;
  if (prior?.kind === "native" && natives.some((n) => n.id === prior.id)) def = { ...prior };
  else if (prior?.kind === "label") def = labels.includes(prior.name) ? { kind: "label", name: prior.name } : { kind: "create", name: prior.name };
  if (!def) {
    const nativeGuess = natives.find((n) => n.name === guessForRole(role, natives.map((x) => x.name)));
    const labelGuess = guessForRole(role, labels);
    def = nativeGuess
      ? { kind: "native", id: nativeGuess.id, name: nativeGuess.name }
      : labelGuess
        ? { kind: "label", name: labelGuess }
        : { kind: "create", name: proposed };
  }
  const defaultValue = choiceValue(def);
  // Ancien label disparu du projet : on propose de le recréer.
  if (!choices.some((c) => c.value === defaultValue)) choices.unshift({ name: `Créer le label « ${(def as { name: string }).name} »`, value: defaultValue, choice: def });
  return { choices, defaultValue };
}

/** Crée un label en tolérant qu'il existe déjà (409). */
async function ensureLabel(rest: GitLabRest, projectId: number, name: string, color: string, description: string): Promise<void> {
  try {
    await createLabel(rest, projectId, name, color, description);
    out(`  Label « ${name} » créé.`);
  } catch (err) {
    if (err instanceof GitLabHttpError && err.status === 409) return;
    throw err;
  }
}

async function askStatusTarget(
  rest: GitLabRest,
  projectId: number,
  role: StatusRoleName,
  natives: NativeStatus[],
  labels: string[],
  prior: StatusTarget | undefined,
): Promise<StatusTarget> {
  const { choices, defaultValue } = statusChoices(role, natives, labels, prior);
  const value = await select({
    message: `Statut « ${ROLE_LABELS[role]} »`,
    choices: choices.map(({ name, value }) => ({ name, value })),
    default: defaultValue,
    pageSize: 15,
  });
  const choice = choices.find((c) => c.value === value)!.choice;
  if (choice.kind === "native") return choice;
  if (choice.kind === "label") return choice;
  const name =
    choice.kind === "create"
      ? choice.name
      : (await input({ message: `Nom du label « ${ROLE_LABELS[role]} »`, default: DEFAULT_STATUS_LABELS[role].name, required: true })).trim();
  if (!labels.includes(name)) {
    const d = DEFAULT_STATUS_LABELS[role];
    await ensureLabel(rest, projectId, name, d.color, d.description);
    labels.push(name);
  }
  return { kind: "label", name };
}

const CREATE_PREFIX = "\u0000create:";

/**
 * Choix pour les labels d'un type de ticket : labels existants (cochés si déjà retenus ou s'ils ressemblent au type),
 * plus « Créer le label <type> » s'il n'existe pas, coché d'office quand rien d'autre ne correspond.
 */
export function typeLabelChoices(
  type: "bug" | "feature",
  labels: string[],
  prior: string[] | undefined,
): { name: string; value: string; checked: boolean }[] {
  const preselected = new Set((prior ?? guessTypeLabels(type, labels)).filter((l) => labels.includes(l)));
  return [
    ...labels.map((l) => ({ name: l, value: l, checked: preselected.has(l) })),
    ...(labels.includes(type)
      ? []
      : [{ name: `Créer le label « ${type} »`, value: `${CREATE_PREFIX}${type}`, checked: preselected.size === 0 }]),
  ];
}

async function askTypeLabels(
  rest: GitLabRest,
  projectId: number,
  type: "bug" | "feature",
  labels: string[],
  prior: string[] | undefined,
): Promise<string[]> {
  const picked = await checkbox({
    message: `Labels désignant un ticket « ${type} »`,
    choices: typeLabelChoices(type, labels, prior),
    pageSize: 15,
  });
  const result: string[] = [];
  for (const v of picked) {
    if (!v.startsWith(CREATE_PREFIX)) {
      result.push(v);
      continue;
    }
    const name = v.slice(CREATE_PREFIX.length);
    await ensureLabel(rest, projectId, name, TYPE_LABEL_COLORS[type], `Ticket de type ${type}.`);
    labels.push(name);
    result.push(name);
  }
  return result;
}

/** Dossier analysé par Claude : le checkout local s'il existe, sinon le clone de référence (créé au besoin). */
async function repoDirForAnalysis(
  token: TokenProvider,
  info: ProjectInfo,
  name: string,
  localCheckout: string | undefined,
): Promise<string> {
  if (localCheckout && existsSync(resolveHome(localCheckout))) return resolveHome(localCheckout);
  const provisional = ProjectConfigSchema.parse({
    name,
    id: info.id,
    path: info.pathWithNamespace,
    httpUrl: info.httpUrl,
    defaultBranch: info.defaultBranch,
    status: { inProgress: { kind: "label", name: "x" }, inReview: { kind: "label", name: "x" }, blocked: { kind: "label", name: "x" } },
  });
  out("  Clone du dépôt pour l'analyse…");
  return createGitOps({ token }).ensureReferenceClone(provisional);
}

async function configureProject(
  rest: GitLabRest,
  token: TokenProvider,
  info: ProjectInfo,
  prior: ProjectConfig | undefined,
  usedNames: Set<string>,
  triggerLabel: string,
): Promise<ProjectConfig> {
  out();
  out(`── ${info.pathWithNamespace} ──`);

  const name = await input({
    message: "Nom court du projet",
    default: suggestProjectName(defaultProjectName(info.pathWithNamespace), usedNames, prior?.name),
    validate: (v) => validateProjectName(v, usedNames, prior?.name),
  });
  if (prior && prior.name !== name) usedNames.delete(prior.name);
  usedNames.add(name);

  const localCheckout = await optionalInput(
    "Ton checkout local de ce projet, d'où copier .env et dossiers de dépendances (ex. ~/code/projet)",
    prior?.localCheckout,
  );

  const analysis = await analyseProject(rest, info.id, info.defaultBranch);
  const det = analysis.stacks[0];
  out(`  CI : ${analysis.hasCi ? `présente, pipeline ${analysis.ciSource === "merge_request" ? "de MR" : "de branche"}` : "absente"}`);
  if (analysis.hasWorktreeInclude) {
    out(`  .worktreeinclude présent sur ${info.defaultBranch} : il choisit les fichiers ignorés à copier dans chaque worktree.`);
  }

  // Commandes : proposées par une session Claude en lecture seule, validées une à une par l'utilisateur.
  let ai: DetectedCommands | undefined;
  const runAi = prior?.testCommand
    ? await confirm({ message: "Refaire analyser les commandes par Claude ? (sinon les actuelles sont proposées)", default: false })
    : true;
  if (runAi) {
    try {
      const dir = await repoDirForAnalysis(token, info, name, localCheckout);
      out("  Analyse du dépôt par Claude (lecture seule, environ une minute)…");
      const res = await detectProjectCommands(dir);
      ai = res.commands;
      out(`  Stack : ${ai.stack}`);
      out(`  ${ai.explanation}`);
      out(`  (analyse en ${res.turns} tours, coût estimé ~$${res.costUsd.toFixed(2)})`);
    } catch (err) {
      out(`  ⚠ Analyse par Claude impossible (${err instanceof Error ? err.message : String(err)}) : propositions par détection simple.`);
    }
  }
  const by = ai ? " — proposée par Claude" : "";
  const proposal = (fromAi: string | undefined, fromPrior: string | undefined, fromDet: string | undefined) =>
    ai ? fromAi || undefined : prior ? fromPrior : fromDet;

  const setupCommand = await optionalInput(`Commande de setup${by}`, proposal(ai?.setupCommand, prior?.setupCommand, det?.setupCommand));
  const buildCommand = await optionalInput(`Commande de build${by}`, proposal(ai?.buildCommand, prior?.buildCommand, det?.buildCommand));
  const testCommand = await optionalInput(`Commande de test${by}`, proposal(ai?.testCommand, prior?.testCommand, det?.testCommand));

  const testMode = await select({
    message: `Mode de test${by}`,
    choices: [
      { name: "local (tests lancés dans le worktree)", value: "local" as const },
      { name: "ci-only (les tests passent par la CI)", value: "ci-only" as const },
    ],
    default: ai?.testMode ?? prior?.testMode ?? (testCommand ? "local" : "ci-only"),
  });

  const ciSource = await select({
    message: "Pipeline à surveiller après un push",
    choices: [
      { name: "pipeline de merge request", value: "merge_request" as const },
      { name: "pipeline de branche", value: "branch" as const },
    ],
    default: prior?.ciSource ?? analysis.ciSource,
  });

  // Le `.worktreeinclude` versionné (lu sur origin/<defaultBranch> par prepareWorktree) prime : la liste de la
  // config ne sert que de repli s'il disparaît, on conserve donc l'existante sans la redemander.
  const includeDefault = ai?.worktreeInclude ?? prior?.worktreeInclude ?? [];
  const worktreeInclude = analysis.hasWorktreeInclude
    ? (prior?.worktreeInclude ?? [])
    : splitList(
        await input({
          message: `Fichiers ignorés par git à copier dans chaque worktree${by} (séparés par des virgules, « ${NONE} » pour aucun)`,
          default: includeDefault.length ? includeDefault.join(", ") : NONE,
        }),
      );

  const cowDefault = ai?.cowDirs ?? prior?.cowDirs ?? det?.cowDirs ?? [];
  const cowDirs = splitList(
    await input({
      message: `Dossiers de dépendances à cloner en copy-on-write${by} (séparés par des virgules, « ${NONE} » pour aucun)`,
      default: cowDefault.length ? cowDefault.join(", ") : NONE,
    }),
  );

  // Statuts : pour chaque rôle, un statut natif ou un label (existant ou créé à la volée).
  const labels = (await listLabels(rest, info.id)).map((l) => l.name);
  const natives = await listAllowedStatuses(rest, info.pathWithNamespace);
  if (natives.length > 0) out(`  Statuts natifs disponibles : ${natives.map((n) => n.name).join(", ")}`);
  const status: StatusMapping = {
    inProgress: await askStatusTarget(rest, info.id, "inProgress", natives, labels, prior?.status.inProgress),
    inReview: await askStatusTarget(rest, info.id, "inReview", natives, labels, prior?.status.inReview),
    blocked: await askStatusTarget(rest, info.id, "blocked", natives, labels, prior?.status.blocked),
  };

  const typeLabels = {
    bug: await askTypeLabels(rest, info.id, "bug", labels, prior?.typeLabels.bug),
    feature: await askTypeLabels(rest, info.id, "feature", labels, prior?.typeLabels.feature),
  };

  if (!labels.includes(triggerLabel)) {
    await ensureLabel(rest, info.id, triggerLabel, TRIGGER_LABEL_COLOR, "SprintSaver : ticket prêt à être pris en charge automatiquement.");
  } else {
    out(`  Label « ${triggerLabel} » déjà présent.`);
  }

  return {
    name,
    id: info.id,
    path: info.pathWithNamespace,
    httpUrl: info.httpUrl,
    defaultBranch: info.defaultBranch,
    stack: ai?.stack ?? det?.stack ?? prior?.stack,
    setupCommand,
    buildCommand,
    testCommand,
    testMode,
    ciSource,
    localCheckout,
    worktreeInclude,
    cowDirs,
    status,
    typeLabels,
  };
}

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

export async function runInit(opts: { configPath?: string } = {}): Promise<void> {
  const file = opts.configPath ?? paths.config();
  const existing = await readExisting(file);
  if (existing) out(`Config existante trouvée (${file}) : ses valeurs sont proposées par défaut.`);

  const typedUrl = (
    await input({
      message: "Adresse de l'instance GitLab (ex. https://gitlab.com ; une URL de projet est aussi acceptée)",
      default: existing?.gitlab.url ?? "https://gitlab.com",
      validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? true : "URL http(s) attendue."),
    })
  ).trim();
  // Une URL de projet (…/groupe/projet) ferait viser une API inexistante : on retrouve l'adresse de l'instance.
  const { base: url, projectPath } = await resolveApiBase(typedUrl);
  if (url !== typedUrl.replace(/\/+$/, "")) {
    out(`Adresse de l'instance : ${url}${projectPath ? ` (projet ${projectPath} présélectionné)` : ""}.`);
  }

  const host = hostOf(url);
  const token = await ensureGlabConnection(host);
  const rest = createGitLabRest(url, token);
  const identity = await getUserDetails(rest);
  let user: UserDetails;
  if (identity.kind === "personal") {
    user = identity.user;
    out(`glab est connecté en tant que ${user.name} (@${user.username}).`);
  } else {
    out("glab est connecté avec un jeton de projet (GET /user indisponible) : les MR seront ouvertes par le bot du projet.");
    out("Les MR te seront assignées : indique ton username GitLab (le tien, pas celui du bot).");
    user = await resolveHumanUser(
      rest,
      (def) => input({ message: "Ton username GitLab", default: def, required: true }),
      existing?.gitlab.username,
    );
    out(`MR assignées à ${user.name} (@${user.username}, id ${user.id}).`);
  }

  out(identity.kind === "personal" ? "Recherche des projets dont vous êtes membre…" : "Recherche du projet couvert par ce jeton…");
  const projects = await listMemberProjects(rest);
  if (projects.length === 0) throw new Error("Aucun projet accessible avec la connexion glab.");
  const priorById = new Map((existing?.projects ?? []).map((p) => [p.id, p]));
  const selectedIds = await checkbox({
    message: "Projets à surveiller",
    choices: projects.map((p) => ({ name: p.pathWithNamespace, value: p.id, checked: priorById.has(p.id) || p.pathWithNamespace.toLowerCase() === projectPath?.toLowerCase() })),
    pageSize: 20,
    required: true,
  });

  const triggerLabel = existing?.triggerLabel ?? "auto::ready";
  const usedNames = reservedProjectNames(selectedIds, priorById);
  const projectConfigs: ProjectConfig[] = [];
  for (const id of selectedIds) {
    const info = projects.find((p) => p.id === id)!;
    projectConfigs.push(await configureProject(rest, token, info, priorById.get(id), usedNames, triggerLabel));
  }

  out();
  out("── Identité git des commits ──");
  const authorName = await input({
    message: "Nom de l'auteur des commits",
    default: existing?.git.authorName ?? user.name ?? (await gitGlobal("user.name")),
    required: true,
  });
  const authorEmail = await input({
    message: "Email de l'auteur des commits",
    default: existing?.git.authorEmail ?? user.email ?? (await gitGlobal("user.email")),
    required: true,
    validate: (v) => (/^\S+@\S+$/.test(v.trim()) ? true : "Email invalide."),
  });

  // Aucun jeton dans la config : la connexion reste celle de glab (ADR, amendement 2).
  const config: Config = ConfigSchema.parse({
    ...(existing ?? {}),
    gitlab: { url, username: user.username, userId: user.id },
    git: { authorName: authorName.trim(), authorEmail: authorEmail.trim() },
    triggerLabel,
    projects: projectConfigs,
  });
  await saveConfig(config, file);

  out();
  out("── Résumé ──");
  out(`GitLab : ${url} via glab — MR assignées à @${user.username}`);
  out(`Label déclencheur : ${triggerLabel}`);
  out(`Commits : ${authorName} <${authorEmail}>`);
  for (const p of config.projects) {
    const fmt = (t: StatusTarget) => (t.kind === "native" ? `natif « ${t.name} »` : `label « ${t.name} »`);
    const st = `en cours ${fmt(p.status.inProgress)}, en review ${fmt(p.status.inReview)}, bloqué ${fmt(p.status.blocked)}`;
    out(`• ${p.name} — ${p.path} [${p.defaultBranch}]`);
    out(`    stack ${p.stack ?? "?"}, tests ${p.testMode}${p.testCommand ? ` : ${p.testCommand}` : ""}, CI ${p.ciSource}`);
    out(`    statuts ${st}`);
  }
  out();
  out(`Config écrite dans ${file} (aucun jeton : la connexion reste gérée par glab).`);
}
