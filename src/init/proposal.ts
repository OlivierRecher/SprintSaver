/**
 * Proposition de config d'un projet pendant `init` (ADR, amendement 5) : construction depuis la sortie de l'agent de
 * configuration, depuis la détection simple (repli) ou depuis la config existante, normalisation déterministe
 * (nom, cibles de statut, chemins), labels à créer et rendu lisible. Tout est pur : aucune écriture.
 */
import { existsSync } from "node:fs";
import type { AgentProposal } from "../agent/config-agent.js";
import type { ProjectConfig, StatusMapping, StatusTarget, ToolchainRequirement } from "../config/schema.js";
import { resolveHome } from "../git/gitops.js";
import {
  defaultProjectName,
  guessForRole,
  guessTypeLabels,
  type NativeStatus,
  type ProjectAnalysis,
  type ProjectInfo,
  type StatusRoleName,
} from "../gitlab/discovery.js";
import { VERDICT_LABEL, formatReport, type VerificationReport } from "./verify.js";

export const STATUS_ROLES: StatusRoleName[] = ["inProgress", "inReview", "blocked"];

export const ROLE_LABELS: Record<StatusRoleName, string> = {
  inProgress: "en cours",
  inReview: "livré en review",
  blocked: "bloqué",
};

/** Labels de statut proposés à la création quand le projet n'a rien d'adapté. */
export const DEFAULT_STATUS_LABELS: Record<StatusRoleName, { name: string; color: string; description: string }> = {
  inProgress: { name: "sprintsaver::en-cours", color: "#1f75cb", description: "SprintSaver traite ce ticket." },
  inReview: { name: "sprintsaver::en-review", color: "#108548", description: "SprintSaver a livré une MR à relire." },
  blocked: { name: "sprintsaver::bloque", color: "#dd2b0e", description: "SprintSaver est bloqué : voir son dernier commentaire." },
};

export const TYPE_LABEL_COLORS = { bug: "#dd2b0e", feature: "#428bca" } as const;
export const TRIGGER_LABEL_COLOR = "#6699cc";

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

/** Cible par défaut d'un rôle (statut natif, label existant ou label à créer), sans question. */
export function defaultStatusTarget(role: StatusRoleName, natives: NativeStatus[], labels: string[], prior: StatusTarget | undefined): StatusTarget {
  const { choices, defaultValue } = statusChoices(role, natives, labels, prior);
  const c = choices.find((x) => x.value === defaultValue)!.choice;
  if (c.kind === "native") return c;
  if (c.kind === "create-other") return { kind: "label", name: DEFAULT_STATUS_LABELS[role].name };
  return { kind: "label", name: c.name };
}

export const CREATE_PREFIX = "\u0000create:";

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

/** Labels de type par défaut, sans question (les cases cochées par défaut de `typeLabelChoices`). */
export function defaultTypeLabels(type: "bug" | "feature", labels: string[], prior: string[] | undefined): string[] {
  if (prior) return prior;
  return typeLabelChoices(type, labels, undefined)
    .filter((c) => c.checked)
    .map((c) => (c.value.startsWith(CREATE_PREFIX) ? c.value.slice(CREATE_PREFIX.length) : c.value));
}

// ---------------------------------------------------------------------------
// Proposition
// ---------------------------------------------------------------------------

export interface ToolchainEntry {
  tool: string;
  required: string;
  source: string;
  available: string;
  pinnedBy: string;
}

export interface ProjectProposal {
  info: ProjectInfo;
  config: ProjectConfig;
  /** agent : agent de configuration ; simple : détection simple (repli) ; existing : config actuelle reprise. */
  origin: "agent" | "simple" | "existing";
  explanation?: string;
  toolchain: ToolchainEntry[];
  prerequisites: string[];
  /** Classement de l'agent (indicatif : les rapports de vérification de l'orchestrateur font foi). */
  agentVerification?: AgentProposal["verification"];
  /** Vérifications réellement exécutées par l'orchestrateur, dans l'ordre. */
  reports: VerificationReport[];
  warnings: string[];
}

export interface ProposalContext {
  info: ProjectInfo;
  prior?: ProjectConfig;
  /** Labels existants du projet. */
  labels: string[];
  natives: NativeStatus[];
  /** Noms courts pris par les autres projets suivis. */
  usedNames: Set<string>;
}

const clean = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);
const cleanList = (l: string[]): string[] => [...new Set(l.map((x) => x.trim()).filter(Boolean))];

function baseConfig(ctx: ProposalContext): Pick<ProjectConfig, "id" | "path" | "httpUrl" | "defaultBranch"> {
  return { id: ctx.info.id, path: ctx.info.pathWithNamespace, httpUrl: ctx.info.httpUrl, defaultBranch: ctx.info.defaultBranch };
}

function defaultName(ctx: ProposalContext): string {
  return suggestProjectName(defaultProjectName(ctx.info.pathWithNamespace), ctx.usedNames, ctx.prior?.name);
}

function toRequirements(toolchain: ToolchainEntry[]): ToolchainRequirement[] | undefined {
  const req = toolchain
    .filter((t) => t.tool.trim() && t.required.trim())
    .map((t) => ({ tool: t.tool.trim(), required: t.required.trim(), source: t.source.trim(), ...(t.pinnedBy.trim() ? { pinnedBy: t.pinnedBy.trim() } : {}) }));
  return req.length ? req : undefined;
}

/** Cible de statut proposée par l'agent, vérifiée contre les statuts natifs et les labels du projet. */
export function resolveStatusTarget(
  role: StatusRoleName,
  proposed: { kind: "native" | "label"; name: string; id: string },
  ctx: ProposalContext,
  warnings: string[],
): StatusTarget {
  if (proposed.kind === "native") {
    const match =
      ctx.natives.find((n) => n.id === proposed.id.trim()) ??
      ctx.natives.find((n) => n.name.toLowerCase() === proposed.name.trim().toLowerCase());
    if (match) return { kind: "native", id: match.id, name: match.name };
    const fallback = defaultStatusTarget(role, ctx.natives, ctx.labels, ctx.prior?.status[role]);
    warnings.push(`Statut natif « ${proposed.name} » introuvable pour « ${ROLE_LABELS[role]} » : remplacé par ${fmtTarget(fallback)}.`);
    return fallback;
  }
  const name = proposed.name.trim();
  if (name) return { kind: "label", name };
  return defaultStatusTarget(role, ctx.natives, ctx.labels, ctx.prior?.status[role]);
}

/** Proposition de l'agent, normalisée : le code déterministe garde la main sur ce qui doit être valide. */
export function proposalFromAgent(out: AgentProposal, ctx: ProposalContext, reports: VerificationReport[]): ProjectProposal {
  const warnings: string[] = [];
  let name = out.name.trim();
  const valid = validateProjectName(name, ctx.usedNames, ctx.prior?.name);
  if (valid !== true) {
    const fallback = defaultName(ctx);
    warnings.push(`Nom « ${name} » refusé (${valid}) : remplacé par « ${fallback} ».`);
    name = fallback;
  }
  let localCheckout = clean(out.localCheckout);
  if (localCheckout && !existsSync(resolveHome(localCheckout))) {
    warnings.push(`Checkout local ${localCheckout} introuvable : ignoré.`);
    localCheckout = undefined;
  }
  const status: StatusMapping = {
    inProgress: resolveStatusTarget("inProgress", out.status.inProgress, ctx, warnings),
    inReview: resolveStatusTarget("inReview", out.status.inReview, ctx, warnings),
    blocked: resolveStatusTarget("blocked", out.status.blocked, ctx, warnings),
  };
  const testCommand = clean(out.testCommand);
  const config: ProjectConfig = {
    name,
    ...baseConfig(ctx),
    stack: clean(out.stack),
    setupCommand: clean(out.setupCommand),
    buildCommand: clean(out.buildCommand),
    testCommand,
    testMode: out.testMode === "local" && !testCommand ? "ci-only" : out.testMode,
    ciSource: out.ciSource,
    localCheckout,
    worktreeInclude: cleanList(out.worktreeInclude),
    cowDirs: cleanList(out.cowDirs),
    status,
    typeLabels: { bug: cleanList(out.typeLabels.bug), feature: cleanList(out.typeLabels.feature) },
    toolchain: toRequirements(out.toolchain),
  };
  if (out.testMode === "local" && !testCommand) warnings.push("Aucune commande de test : mode de test passé à ci-only.");
  return {
    info: ctx.info,
    config,
    origin: "agent",
    explanation: out.explanation.trim(),
    toolchain: out.toolchain,
    prerequisites: cleanList(out.prerequisites),
    agentVerification: out.verification,
    reports,
    warnings,
  };
}

/** Repli sans agent : config actuelle si elle existe, sinon détection simple (fichiers racine et CI via l'API). */
export function proposalFromDetection(ctx: ProposalContext, analysis: ProjectAnalysis | null, reason?: string): ProjectProposal {
  const prior = ctx.prior;
  const det = analysis?.stacks[0];
  const testCommand = prior ? prior.testCommand : det?.testCommand;
  const config: ProjectConfig = {
    name: defaultName(ctx),
    ...baseConfig(ctx),
    stack: prior?.stack ?? det?.stack,
    setupCommand: prior ? prior.setupCommand : det?.setupCommand,
    buildCommand: prior ? prior.buildCommand : det?.buildCommand,
    testCommand,
    testMode: prior?.testMode ?? (testCommand ? "local" : "ci-only"),
    ciSource: prior?.ciSource ?? analysis?.ciSource ?? "merge_request",
    localCheckout: prior?.localCheckout,
    worktreeInclude: prior?.worktreeInclude ?? [],
    cowDirs: prior?.cowDirs ?? det?.cowDirs ?? [],
    status: {
      inProgress: defaultStatusTarget("inProgress", ctx.natives, ctx.labels, prior?.status.inProgress),
      inReview: defaultStatusTarget("inReview", ctx.natives, ctx.labels, prior?.status.inReview),
      blocked: defaultStatusTarget("blocked", ctx.natives, ctx.labels, prior?.status.blocked),
    },
    typeLabels: {
      bug: defaultTypeLabels("bug", ctx.labels, prior?.typeLabels.bug),
      feature: defaultTypeLabels("feature", ctx.labels, prior?.typeLabels.feature),
    },
    toolchain: prior?.toolchain,
  };
  return {
    info: ctx.info,
    config,
    origin: prior ? "existing" : "simple",
    toolchain: [],
    prerequisites: [],
    reports: [],
    warnings: reason ? [reason] : [],
  };
}

// ---------------------------------------------------------------------------
// Labels à créer
// ---------------------------------------------------------------------------

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** Labels que la config utilise et qui n'existent pas encore sur le projet (créés après validation). */
export function labelsToCreate(config: ProjectConfig, existing: string[], triggerLabel: string): LabelSpec[] {
  const have = new Set(existing);
  const out = new Map<string, LabelSpec>();
  const add = (spec: LabelSpec) => {
    if (!have.has(spec.name) && !out.has(spec.name)) out.set(spec.name, spec);
  };
  for (const role of STATUS_ROLES) {
    const t = config.status[role];
    if (t.kind === "label") add({ name: t.name, color: DEFAULT_STATUS_LABELS[role].color, description: DEFAULT_STATUS_LABELS[role].description });
  }
  for (const type of ["bug", "feature"] as const) {
    for (const l of config.typeLabels[type]) add({ name: l, color: TYPE_LABEL_COLORS[type], description: `Ticket de type ${type}.` });
  }
  add({ name: triggerLabel, color: TRIGGER_LABEL_COLOR, description: "SprintSaver : ticket prêt à être pris en charge automatiquement." });
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Vérification et rendu
// ---------------------------------------------------------------------------

/** Les commandes de la config sont-elles exactement celles de ce rapport ? */
export function reportMatches(r: VerificationReport, c: ProjectConfig): boolean {
  const same = (a?: string, b?: string) => (a?.trim() || "") === (b?.trim() || "");
  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return (
    same(r.input.setupCommand, c.setupCommand) &&
    same(r.input.buildCommand, c.buildCommand) &&
    same(r.input.testCommand, c.testCommand) &&
    sameList(r.input.worktreeInclude, c.worktreeInclude) &&
    sameList(r.input.cowDirs, c.cowDirs) &&
    same(r.input.localCheckout ? resolveHome(r.input.localCheckout) : undefined, c.localCheckout ? resolveHome(c.localCheckout) : undefined)
  );
}

/** Dernière vérification qui porte sur les commandes actuelles de la proposition, s'il y en a une. */
export function currentVerification(p: ProjectProposal): VerificationReport | undefined {
  const last = p.reports.at(-1);
  return last && reportMatches(last, p.config) ? last : undefined;
}

export function fmtTarget(t: StatusTarget): string {
  return t.kind === "native" ? `statut natif « ${t.name} »` : `label « ${t.name} »`;
}

const AGENT_STATUS_LABEL: Record<AgentProposal["verification"]["status"], string> = {
  passed: "commandes vérifiées",
  baseline_red: "tests rouges sur la branche par défaut (ligne de base)",
  broken: "commande cassée",
  prerequisite_missing: "prérequis manquant",
  not_run: "non vérifiées",
};

/** Rendu complet de la proposition, pour validation par l'utilisateur. */
export function formatProposal(p: ProjectProposal, toCreate: LabelSpec[]): string[] {
  const c = p.config;
  const creating = new Set(toCreate.map((l) => l.name));
  const mark = (name: string) => (creating.has(name) ? " (à créer)" : "");
  const target = (t: StatusTarget) => `${fmtTarget(t)}${t.kind === "label" ? mark(t.name) : ""}`;
  const list = (l: string[]) => (l.length ? l.join(", ") : "—");
  const origin = { agent: "proposée par l'agent de configuration", simple: "détection simple", existing: "config actuelle" }[p.origin];
  const lines = [
    `── ${p.info.pathWithNamespace} [${p.info.defaultBranch}] — ${origin} ──`,
    `  Nom court            : ${c.name}`,
    `  Checkout local       : ${c.localCheckout ?? "— (fichiers copiés depuis le clone de référence)"}`,
    `  Stack                : ${c.stack ?? "—"}`,
    `  Setup                : ${c.setupCommand ?? "—"}`,
    `  Build                : ${c.buildCommand ?? "—"}`,
    `  Test                 : ${c.testCommand ?? "—"}`,
    `  Mode de test         : ${c.testMode}`,
    `  Pipeline surveillé   : ${c.ciSource === "merge_request" ? "pipeline de merge request" : "pipeline de branche"}`,
    `  Fichiers à copier    : ${list(c.worktreeInclude)}`,
    `  Dossiers COW         : ${list(c.cowDirs)}`,
    `  Statut en cours      : ${target(c.status.inProgress)}`,
    `  Statut en review     : ${target(c.status.inReview)}`,
    `  Statut bloqué        : ${target(c.status.blocked)}`,
    `  Labels bug           : ${c.typeLabels.bug.length ? c.typeLabels.bug.map((l) => `${l}${mark(l)}`).join(", ") : "—"}`,
    `  Labels feature       : ${c.typeLabels.feature.length ? c.typeLabels.feature.map((l) => `${l}${mark(l)}`).join(", ") : "—"}`,
    `  Labels à créer       : ${toCreate.length ? toCreate.map((l) => l.name).join(", ") : "aucun"}`,
  ];
  const toolchain = p.toolchain.filter((t) => t.tool.trim());
  if (toolchain.length) {
    lines.push("  Toolchain :");
    for (const t of toolchain) {
      lines.push(`    • ${t.tool} : exigé ${t.required || "—"}${t.source ? ` (${t.source})` : ""}`);
      if (t.available) lines.push(`        machine : ${t.available}`);
      lines.push(`        ${t.pinnedBy ? `version fixée par : ${t.pinnedBy}` : "version non fixée par les commandes"}`);
    }
  }
  const current = currentVerification(p);
  if (current) {
    lines.push(`  Vérification réelle  : ${VERDICT_LABEL[current.verdict]} (tentative ${current.attempt}).`);
    lines.push(...formatReport(current).split("\n").slice(1).map((l) => `    ${l}`).slice(0, 40));
  } else if (p.reports.length > 0) {
    const last = p.reports.at(-1)!;
    lines.push(`  Vérification réelle  : les commandes ont changé depuis la dernière vérification (${VERDICT_LABEL[last.verdict]}) : non vérifiées.`);
  } else {
    lines.push("  Vérification réelle  : commandes non vérifiées.");
  }
  if (p.agentVerification) {
    const v = p.agentVerification;
    lines.push(`  Avis de l'agent      : ${AGENT_STATUS_LABEL[v.status]}${v.note.trim() ? ` — ${v.note.trim()}` : ""}`);
    if (v.failingTests.length) lines.push(`    Tests rouges sur ${p.info.defaultBranch} : ${v.failingTests.join(", ")}`);
  }
  if (p.prerequisites.length) {
    lines.push("  Prérequis manquants :");
    lines.push(...p.prerequisites.map((x) => `    - ${x}`));
  }
  if (p.explanation) lines.push(`  Explication : ${p.explanation}`);
  if (p.warnings.length) {
    lines.push("  Avertissements :");
    lines.push(...p.warnings.map((w) => `    ⚠ ${w}`));
  }
  return lines;
}
