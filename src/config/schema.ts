import { z } from "zod";

/** Phases agent (une session Claude chacune). */
export const AGENT_PHASES = [
  "analyse",
  "write-tests",
  "implement",
  "test-fix",
  "review",
  "review-fix",
  "verify-criteria",
  "ci-fix",
  "rebase-fix",
  "mr-writeup",
  "ui-captures",
  "retro",
] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

/** Phases qui pilotent Chrome par défaut : voir le résultat (review) et le capturer (ui-captures). */
export const DEFAULT_CHROME_PHASES: readonly AgentPhase[] = ["ui-captures", "review"];

export const TICKET_TYPES = ["bug", "feature"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";

export const DEFAULT_PHASE_MODELS: Record<AgentPhase, string> = {
  analyse: OPUS,
  "write-tests": OPUS,
  implement: OPUS,
  "test-fix": OPUS,
  review: OPUS,
  "review-fix": OPUS,
  "verify-criteria": OPUS,
  "ci-fix": OPUS,
  "rebase-fix": OPUS,
  "mr-writeup": SONNET,
  "ui-captures": SONNET,
  retro: SONNET,
};

/**
 * Cible d'un rôle de statut : statut natif des work items (GraphQL, id global + nom) OU label du projet.
 * Chaque rôle a sa propre cible : on peut mapper « en cours » sur le statut natif « In progress » et « livré en
 * review » / « bloqué » sur des labels quand l'instance n'a pas de statut natif équivalent.
 */
export const StatusTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), id: z.string().min(1), name: z.string() }),
  z.object({ kind: z.literal("label"), name: z.string().min(1) }),
]);
export type StatusTarget = z.infer<typeof StatusTargetSchema>;

const StatusMappingObject = z.object({
  inProgress: StatusTargetSchema,
  inReview: StatusTargetSchema,
  blocked: StatusTargetSchema,
});
export type StatusMapping = z.infer<typeof StatusMappingObject>;

const STATUS_ROLES = ["inProgress", "inReview", "blocked"] as const;

/** Ancien format (`mode: "native" | "labels"` pour les trois rôles à la fois) → une cible par rôle. */
function migrateLegacyStatus(v: unknown): unknown {
  if (!v || typeof v !== "object" || !("mode" in v)) return v;
  const legacy = v as Record<string, unknown> & { mode: unknown };
  const out: Record<string, unknown> = {};
  for (const role of STATUS_ROLES) {
    const r = legacy[role];
    out[role] =
      legacy.mode === "native" && r && typeof r === "object"
        ? { kind: "native", ...(r as object) }
        : legacy.mode === "labels" && typeof r === "string"
          ? { kind: "label", name: r }
          : r;
  }
  return out;
}

export const StatusMappingSchema = z.preprocess(migrateLegacyStatus, StatusMappingObject);
export type StatusRole = "inProgress" | "inReview" | "blocked";

/** Version de toolchain exigée par le dépôt, relevée par `init` (ADR, amendement 5). Documentation : non lue par le moteur. */
export const ToolchainRequirementSchema = z.object({
  tool: z.string(),
  required: z.string(),
  /** D'où vient l'exigence (CI, fichier de version, manifeste, README). */
  source: z.string().default(""),
  /** Comment les commandes fixent la version (gestionnaire de versions, chemin…). */
  pinnedBy: z.string().optional(),
});
export type ToolchainRequirement = z.infer<typeof ToolchainRequirementSchema>;

export const ProjectConfigSchema = z.object({
  /** Clé courte utilisée dans les chemins et `run <name>#<iid>`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i),
  /** Id numérique GitLab. */
  id: z.number().int(),
  /** path_with_namespace, ex. "groupe/sous-groupe/projet". */
  path: z.string(),
  /** URL de clone HTTPS (le jeton glab est passé en en-tête au moment du clone, jamais écrit). */
  httpUrl: z.string().url(),
  defaultBranch: z.string().default("main"),
  stack: z.string().optional(),
  setupCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  testCommand: z.string().optional(),
  testMode: z.enum(["local", "ci-only"]).default("local"),
  /** Source du pipeline à surveiller après un push. */
  ciSource: z.enum(["merge_request", "branch"]).default("merge_request"),
  /**
   * Checkout local de l'utilisateur (ex. ~/code/projet) d'où copier les fichiers ignorés par git (.env…) et les
   * cowDirs. Défaut : le clone de référence ~/.sprintsaver/repos/<name>.
   */
  localCheckout: z.string().optional(),
  /**
   * Fichiers ignorés par git nécessaires pour lancer les tests et l'application en local (config d'environnement
   * locale, secrets de dev…), copiés vers le worktree depuis `localCheckout` (si pas de .worktreeinclude).
   */
  worktreeInclude: z.array(z.string()).default([]),
  /** Dossiers lourds (ex. node_modules) clonés en copy-on-write depuis le clone de référence. */
  cowDirs: z.array(z.string()).default([]),
  status: StatusMappingSchema,
  /** Versions de toolchain exigées par le dépôt et comment les commandes les fixent (relevé par `init`). */
  toolchain: z.array(ToolchainRequirementSchema).optional(),
  typeLabels: z
    .object({
      bug: z.array(z.string()).default(["bug", "type::bug"]),
      feature: z.array(z.string()).default(["feature", "type::feature"]),
    })
    .default({ bug: ["bug", "type::bug"], feature: ["feature", "type::feature"] }),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ConfigSchema = z.object({
  /**
   * Aucun jeton ici : la connexion est celle de glab (`glab auth login`) pour l'hôte de `url` (ADR, amendement 2).
   * Un ancien champ `token` est ignoré au chargement et disparaît à la prochaine sauvegarde.
   */
  gitlab: z.object({
    url: z.string().url().default("https://gitlab.com"),
    /** Utilisateur de l'outil : assignee des MR (toujours l'humain, jamais le bot d'un jeton de projet). */
    username: z.string().min(1),
    userId: z.number().int(),
  }),
  /** Identité git des commits (défaut : config git globale). */
  git: z
    .object({ authorName: z.string().optional(), authorEmail: z.string().optional() })
    .default({}),
  triggerLabel: z.string().default("auto::ready"),
  pollIntervalSec: z.number().int().positive().default(120),
  limits: z
    .object({
      testFix: z.number().int().positive().default(5),
      review: z.number().int().positive().default(3),
      ci: z.number().int().positive().default(3),
      maxDurationMin: z.number().int().positive().default(180),
      maxTurnsPerSession: z.number().int().positive().default(150),
      commandTimeoutMin: z.number().int().positive().default(20),
      ciTimeoutMin: z.number().int().positive().default(60),
    })
    .default({
      testFix: 5,
      review: 3,
      ci: 3,
      maxDurationMin: 180,
      maxTurnsPerSession: 150,
      commandTimeoutMin: 20,
      ciTimeoutMin: 60,
    }),
  models: z.record(z.string(), z.string()).default({}),
  retro: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /** Captures avant/après dans la MR quand le changement touche l'interface (ADR, amendement 3). */
  screenshots: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /**
   * Claude in Chrome (ADR, amendement 4) : le Chrome de l'utilisateur, piloté par les sessions des phases listées
   * pour voir le résultat et faire les captures. Navigation limitée à l'hôte local par le garde-fou. Sans
   * extension connectée, les sessions se rabattent sur les outils headless.
   */
  chrome: z
    .object({
      enabled: z.boolean().default(true),
      phases: z.array(z.enum(AGENT_PHASES)).default([...DEFAULT_CHROME_PHASES]),
    })
    .default({ enabled: true, phases: [...DEFAULT_CHROME_PHASES] }),
  transcripts: z
    .object({
      enabled: z.boolean().default(true),
      retentionDays: z.number().int().positive().default(30),
    })
    .default({ enabled: true, retentionDays: 30 }),
  projects: z.array(ProjectConfigSchema).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

/** La session de cette phase reçoit-elle le navigateur (Claude in Chrome) ? */
export function chromeFor(config: Config, phase: AgentPhase): boolean {
  return config.chrome.enabled && config.chrome.phases.includes(phase);
}

export function modelFor(config: Config, phase: AgentPhase): string {
  return config.models[phase] ?? DEFAULT_PHASE_MODELS[phase];
}
