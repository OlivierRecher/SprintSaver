/**
 * Contrats partagés entre modules. Chaque module implémente son interface ;
 * le moteur (engine/) ne dépend que de ces interfaces, ce qui permet de le tester avec des doubles.
 */
import type { z } from "zod";
import type { AgentPhase, ProjectConfig, StatusRole, TicketType } from "./config/schema.js";

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface IssueSummary {
  projectId: number;
  iid: number;
  title: string;
  state: "opened" | "closed";
  webUrl: string;
  labels: string[];
}

export interface Issue extends IssueSummary {
  description: string;
  /** "issue" | "incident" | "task" | ... (champ issue_type GitLab, en minuscules) */
  issueType: string;
  authorUsername: string;
  createdAt: string;
}

export interface Note {
  id: number;
  authorUsername: string;
  body: string;
  createdAt: string;
}

export interface QueuedIssue {
  project: ProjectConfig;
  iid: number;
  title: string;
  /** Date d'ajout du label déclencheur (ISO), utilisée pour l'ordre FIFO. */
  labeledAt: string;
}

export interface MrRef {
  iid: number;
  webUrl: string;
}

export interface MrSummary extends MrRef {
  title: string;
  state: string;
  mergedAt?: string | null;
}

export type PipelineStatus =
  | "created"
  | "waiting_for_resource"
  | "preparing"
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled"
  | "skipped"
  | "manual"
  | "scheduled";

export interface Pipeline {
  id: number;
  status: PipelineStatus;
  sha: string;
  ref: string;
  webUrl: string;
}

export interface Job {
  id: number;
  name: string;
  stage: string;
  status: string;
  webUrl: string;
  allowFailure: boolean;
  /** Projet du job s'il diffère du projet du ticket (jobs de pipelines enfants d'un autre projet). */
  projectId?: number;
}

/** Résultat d'une attente de pipeline. */
export type PipelineOutcome =
  | { kind: "success"; pipeline: Pipeline }
  | { kind: "failed"; pipeline: Pipeline; failedJobs: Job[] }
  | { kind: "canceled"; pipeline: Pipeline }
  | { kind: "none" } // aucun pipeline créé pour ce sha (pas de CI)
  | { kind: "timeout"; pipeline?: Pipeline };

export interface GitLabApi {
  currentUser(): Promise<GitLabUser>;

  /** Tickets ouverts portant `label` dans les projets donnés, triés du plus ancien étiquetage au plus récent. */
  listQueuedIssues(projects: ProjectConfig[], label: string): Promise<QueuedIssue[]>;

  getIssue(projectId: number, iid: number): Promise<Issue>;
  /** Commentaires humains (notes système exclues), ordre chronologique. */
  getIssueNotes(projectId: number, iid: number): Promise<Note[]>;
  getLinkedIssues(projectId: number, iid: number): Promise<Issue[]>;
  /**
   * Télécharge les images (uploads markdown `![..](/uploads/...)`) référencées dans les textes donnés.
   * Retourne les chemins locaux écrits dans destDir.
   */
  downloadImages(project: ProjectConfig, texts: string[], destDir: string): Promise<string[]>;
  /** Comme `downloadImages`, avec en plus les images qui n'ont pas pu être téléchargées (optionnel). */
  downloadImagesDetailed?(
    project: ProjectConfig,
    texts: string[],
    destDir: string,
  ): Promise<{ saved: string[]; failed: { url: string; status?: number }[] }>;

  addLabel(projectId: number, iid: number, label: string): Promise<void>;
  removeLabel(projectId: number, iid: number, label: string): Promise<void>;
  updateIssueDescription(projectId: number, iid: number, description: string): Promise<void>;
  comment(projectId: number, iid: number, body: string): Promise<void>;
  setStatus(project: ProjectConfig, iid: number, role: StatusRole): Promise<void>;

  findOpenMrForBranch(projectId: number, sourceBranch: string): Promise<MrRef | null>;
  createDraftMr(input: {
    projectId: number;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<MrRef>;
  updateMr(
    projectId: number,
    mrIid: number,
    patch: { title?: string; description?: string; assigneeIds?: number[] },
  ): Promise<void>;
  /** Retire le préfixe Draft du titre. */
  markMrReady(projectId: number, mrIid: number): Promise<void>;
  /**
   * Téléverse un fichier dans les uploads du projet (POST /projects/:id/uploads).
   * Retourne le markdown à insérer (`![nom](/uploads/<secret>/nom.png)`) et l'URL relative.
   */
  uploadFile(projectId: number, filePath: string): Promise<{ markdown: string; url: string }>;

  /**
   * Attend la fin du pipeline correspondant à `sha` (pipeline de MR si mrIid fourni et ciSource=merge_request,
   * sinon pipeline de branche). Poll toutes les `pollMs`.
   */
  waitForPipeline(input: {
    project: ProjectConfig;
    sha: string;
    branch: string;
    mrIid?: number;
    timeoutMs: number;
    pollMs?: number;
    /** Délai max d'apparition d'un pipeline avant de conclure "none". */
    appearTimeoutMs?: number;
  }): Promise<PipelineOutcome>;
  /** Relance les jobs donnés puis attend la fin du pipeline. */
  retryJobsAndWait(input: {
    project: ProjectConfig;
    pipeline: Pipeline;
    jobs: Job[];
    timeoutMs: number;
    pollMs?: number;
  }): Promise<PipelineOutcome>;
  /** Dernier pipeline terminé de la branche donnée (ou null). */
  latestFinishedPipeline(projectId: number, ref: string): Promise<Pipeline | null>;
  /** Fin du log d'un job (tronqué à maxChars depuis la fin). */
  jobLog(projectId: number, jobId: number, maxChars?: number): Promise<string>;

  // --- lecture seule, exposé aux agents via MCP ---
  searchIssues(projectId: number, query: string, state: "opened" | "closed" | "all", limit?: number): Promise<IssueSummary[]>;
  closingMrs(projectId: number, iid: number): Promise<MrSummary[]>;
  /** Diff unifié d'une MR, tronqué à maxChars. */
  mrDiff(projectId: number, mrIid: number, maxChars?: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Git / worktrees
// ---------------------------------------------------------------------------

export interface CommandResult {
  exitCode: number;
  /** stdout+stderr entrelacés, tronqués depuis le début si trop longs. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export type RebaseResult = { ok: true } | { ok: false; conflictedFiles: string[] };

export interface GitOps {
  /** Clone (si absent) puis fetch le clone de référence. Retourne son chemin. */
  ensureReferenceClone(project: ProjectConfig): Promise<string>;
  /** Le remote a-t-il cette branche ? */
  remoteBranchExists(project: ProjectConfig, branch: string): Promise<boolean>;
  /**
   * Crée le worktree `wtPath` sur `branch`. Si la branche existe sur le remote, la reprend ;
   * sinon la crée depuis origin/<defaultBranch>. Si le worktree existe déjà, le réutilise.
   */
  createOrReuseWorktree(project: ProjectConfig, branch: string, wtPath: string): Promise<{ reused: boolean }>;
  /** Copie .worktreeinclude / worktreeInclude, clone COW des cowDirs, lance setupCommand. */
  prepareWorktree(project: ProjectConfig, wtPath: string, timeoutMs: number): Promise<void>;
  removeWorktree(project: ProjectConfig, wtPath: string): Promise<void>;
  /**
   * Crée `basePath`, worktree détaché sur le merge-base entre HEAD de `wtPath` et origin/<defaultBranch>
   * (l'état « avant » du ticket). Un dossier existant à cet endroit est d'abord supprimé.
   */
  createBaseWorktree(project: ProjectConfig, wtPath: string, basePath: string): Promise<void>;
  /**
   * Crée `wtPath`, worktree détaché sur origin/<defaultBranch> tel que fetché par `ensureReferenceClone`
   * (analyse et vérification des commandes par `init`). Un dossier existant à cet endroit est d'abord supprimé.
   */
  createDetachedWorktree(project: ProjectConfig, wtPath: string): Promise<void>;
  /** Annule les modifications non commitées (fichiers suivis restaurés, non suivis non ignorés supprimés). */
  discardChanges(wtPath: string): Promise<void>;

  /** `git add -A` + commit. Retourne le sha, ou null s'il n'y avait rien à commiter. */
  commitAll(wtPath: string, message: string): Promise<string | null>;
  /** Push de la branche courante vers origin (force-with-lease si force). */
  push(wtPath: string, branch: string, opts?: { force?: boolean }): Promise<void>;
  headSha(wtPath: string): Promise<string>;
  /** Diff de HEAD (et de l'arbre de travail) par rapport au merge-base avec origin/<defaultBranch>. */
  diffAgainstBase(project: ProjectConfig, wtPath: string): Promise<string>;
  /** Diff entre deux refs. */
  diffRange(wtPath: string, from: string, to: string): Promise<string>;
  /** Fichiers modifiés non commités ? */
  isDirty(wtPath: string): Promise<boolean>;

  /** fetch puis rebase sur origin/<defaultBranch>. En cas de conflit, laisse le rebase en cours. */
  rebaseOnDefault(project: ProjectConfig, wtPath: string): Promise<RebaseResult>;
  /**
   * `git add -A` + `rebase --continue` (sans éditeur). Peut renvoyer de nouveaux conflits. Si des fichiers
   * contiennent encore des marqueurs de conflit, rien n'est ajouté ni continué : renvoie ces fichiers
   * (`ok: false`), le rebase reste arrêté sur le même commit.
   */
  rebaseContinue(wtPath: string): Promise<RebaseResult>;
  /** Annule le rebase en cours ; sans effet s'il n'y en a pas. */
  rebaseAbort(wtPath: string): Promise<void>;

  /** Exécute une commande shell dans le worktree. */
  run(wtPath: string, command: string, timeoutMs: number): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentRunRequest<T> {
  phase: AgentPhase;
  ticketType: TicketType;
  project: ProjectConfig;
  ticketKey: string;
  worktreePath: string;
  /** Message utilisateur de la session. */
  prompt: string;
  /** Contexte additionnel ajouté au prompt système après les skills (ticket, analyse...). */
  context?: string;
  /** Schéma zod de la sortie structurée attendue. */
  outputSchema: z.ZodType<T>;
  /** N° d'itération de la phase (pour nommer le transcript). */
  iteration: number;
  /** Dossiers modifiables en plus du worktree et des dossiers temporaires (ex. worktree « avant » des captures). */
  extraWritableRoots?: string[];
  /**
   * Skills de type à charger à la place de `ticketType` (ex. les deux quand le type n'est pas encore
   * tranché, à l'analyse). Absent : `[ticketType]`.
   */
  typeSkills?: TicketType[];
  /**
   * Arrêt immédiat (2e Ctrl+C) : interrompt la session en cours, qui échoue avec
   * `AgentRunError(..., "aborted")`.
   */
  abortSignal?: AbortSignal;
}

export interface AgentRunResult<T> {
  output: T;
  numTurns: number;
  durationMs: number;
  costUsd?: number;
  transcriptPath?: string;
  skillsLoaded: string[];
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly phase: AgentPhase,
    readonly reason: "max_turns" | "invalid_output" | "execution_error" | "aborted",
  ) {
    super(message);
  }
}

export interface AgentRunner {
  run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>>;
}

// ---------------------------------------------------------------------------
// État d'un ticket
// ---------------------------------------------------------------------------

export const TICKET_PHASES = [
  "picked",
  "prepared",
  "analysed",
  "tests_written",
  "implemented",
  "tests_green",
  "reviewed",
  "pushed",
  "ci_green",
  "finalized",
] as const;
export type TicketPhase = (typeof TICKET_PHASES)[number] | "blocked";

export interface Criterion {
  /** Index de la case dans l'ordre d'apparition de la description (0-based). */
  index: number;
  text: string;
  checkedInitially: boolean;
  testable?: boolean;
  /** Raison si non testable. */
  reason?: string;
}

export interface TestEntry {
  name: string;
  file: string;
  change: "added" | "modified";
  /** Indices des critères prouvés par ce test. */
  criteria: number[];
  explanation: string;
}

export interface Finding {
  severity: "blocking" | "nit";
  category: string;
  file?: string;
  line?: number;
  description: string;
}

export interface AnalysisResult {
  type: TicketType;
  typeSource: "labels" | "issue_type" | "agent";
  summary: string;
  plan: string[];
  criteria: Criterion[];
  precedents: { ref: string; relevant: boolean; why: string }[];
  assumptions: string[];
  blockingQuestions: string[];
}

export interface CriterionProof {
  index: number;
  proven: boolean;
  tests: string[];
  reason: string;
}

export interface TicketState {
  version: 1;
  key: string;
  projectName: string;
  projectId: number;
  iid: number;
  title: string;
  webUrl: string;
  phase: TicketPhase;
  /** Phase atteinte avant un blocage (pour info). */
  phaseBeforeBlock?: TicketPhase;
  branch: string;
  worktreePath: string;
  startedAt: string;
  updatedAt: string;
  resumeCount: number;
  counters: { testFix: number; review: number; ci: number };
  /** sha de HEAD au moment de la dernière review complète (pour les re-reviews sur delta). */
  reviewedSha?: string;
  baseShaAtStart?: string;
  mrIid?: number;
  mrUrl?: string;
  analysis?: AnalysisResult;
  tests: TestEntry[];
  nits: Finding[];
  proofs: CriterionProof[];
  flakyJobs: string[];
  /** Shas dont les jobs en échec ont déjà été relancés une fois (survit à un crash). */
  ciRetriedShas?: string[];
  /** Branche réécrite localement (rebase) pas encore poussée ni validée par la CI. */
  pendingForcePush?: boolean;
  blockedReason?: string;
  /** Ticket dont la prise en charge a été commentée. */
  pickupCommented?: boolean;
  /** Un pipeline a déjà été observé pour ce ticket : un « aucun pipeline » ultérieur n'est plus « pas de CI ». */
  ciSeen?: boolean;
  /** Dernier sha validé par la CI (vert, vert après relance, ou projet sans CI). */
  ciGreenSha?: string;
  /** Temps de traitement actif cumulé (ms), hors périodes où l'outil était arrêté. Absent : 0. */
  activeMs?: number;
  /** Le worktree doit être recréé depuis le remote à la prochaine préparation (nouveau passage). */
  recreateWorktree?: boolean;
  /** Commits du ticket déjà présents sur la branche à la préparation (`git log --oneline`), le plus récent d'abord. */
  priorCommits?: string[];
  /** Des tests ont changé depuis la dernière vérification des critères : les preuves sont à refaire. */
  proofsStale?: boolean;
  /** Rebase avec conflits terminé mais résolution pas encore relue (fichiers en conflit). */
  pendingRebaseReview?: string[];
  /** Images du ticket qui n'ont pas pu être téléchargées (URL et statut HTTP éventuel). */
  imagesFailed?: string[];
  /** Sous-étapes de la livraison déjà faites (reprise idempotente de la finalisation). */
  deliverySteps?: DeliverySteps;
}

export interface DeliverySteps {
  /** MR décrite, assignée et passée en Ready (rebase et CI terminés). */
  mrReady?: boolean;
  /** Résumé produit par la rédaction de la MR (repris dans le commentaire de livraison). */
  summary?: string;
  boxesChecked?: boolean;
  statusSet?: boolean;
  commented?: boolean;
  worktreeRemoved?: boolean;
}

export interface StateStore {
  load(key: string): Promise<TicketState | null>;
  save(state: TicketState): Promise<void>;
  list(): Promise<TicketState[]>;
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Résumés de phase (entrée de la rétro)
// ---------------------------------------------------------------------------

export interface PhaseSummary {
  ticketKey: string;
  phase: AgentPhase | "ci" | "tests-local";
  iteration: number;
  startedAt: string;
  durationMs: number;
  outcome: "ok" | "retry" | "blocked" | "error";
  numTurns?: number;
  costUsd?: number;
  skillsLoaded?: string[];
  /** Faits saillants : tests en échec, findings, erreurs CI, etc. Texte court. */
  facts: string[];
}

export interface RunRecorder {
  recordPhase(summary: PhaseSummary): Promise<void>;
  readSummaries(ticketKey: string): Promise<PhaseSummary[]>;
}
