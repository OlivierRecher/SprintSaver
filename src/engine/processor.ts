/**
 * Machine à états d'un ticket (ADR § 7, § 8).
 *
 * `state.phase` désigne la dernière phase ATTEINTE. `process` exécute les phases suivantes une à une et
 * sauvegarde l'état après chacune (et à chaque incrément de compteur), ce qui permet de reprendre après
 * un crash ou un Ctrl+C. Au démarrage d'un nouveau ticket, le ticket est lu AVANT le retrait du label (un
 * GitLab indisponible ne fait pas perdre le ticket) ; puis, comme à la reprise d'un ticket bloqué, le label
 * déclencheur est retiré AVANT de créer ou de réinitialiser l'état (sans retrait, pas de prise en charge), et
 * remis si l'état ne peut pas être enregistré. La phase `picked` pose ensuite le statut « en cours ».
 *
 * La durée maximale porte sur le temps actif cumulé (`activeMs`), pas sur le temps écoulé depuis le début :
 * les périodes où l'outil est arrêté ne comptent pas.
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import {
  AgentRunError,
  TICKET_PHASES,
  type AgentRunResult,
  type AgentRunner,
  type AnalysisResult,
  type CriterionProof,
  type Finding,
  type GitLabApi,
  type GitOps,
  type Issue,
  type PhaseSummary,
  type PipelineOutcome,
  type RunRecorder,
  type StateStore,
  type TestEntry,
  type TicketPhase,
  type TicketState,
} from "../contracts.js";
import type { AgentPhase, Config, ProjectConfig, TicketType } from "../config/schema.js";
import { paths, ticketKey, toolRoot } from "../config/paths.js";
import { log } from "../log.js";
import { checkBoxesByText, parseCheckboxes } from "../domain/checkboxes.js";
import {
  baseCiBrokenComment,
  blockedComment,
  deliveredComment,
  needsInfoComment,
  pickupComment,
} from "../domain/comments.js";
import { renderMrDescription, type DataChange, type ScreenCapture } from "../domain/mr-description.js";
import {
  AnalyseOutput,
  FixOutput,
  ImplementOutput,
  MrWriteupOutput,
  RetroOutput,
  ReviewOutput,
  UiCapturesOutput,
  VerifyCriteriaOutput,
  WriteTestsOutput,
} from "../phases/schemas.js";
import * as P from "../phases/prompts.js";
import { branchName, errorMessage, extractFailingTests, mergeTests, shortFact, typeFromIssue } from "./util.js";

export interface TicketProcessorDeps {
  config: Config;
  gitlab: GitLabApi;
  git: GitOps;
  agent: AgentRunner;
  store: StateStore;
  recorder: RunRecorder;
  now?: () => Date;
  /** Racine du dépôt SprintSaver (session de rétro, skills/projects). Défaut : toolRoot(). */
  skillsRepoRoot?: string;
}

export interface ProcessOptions {
  /** Lancement explicite (`sprintsaver run`), label présent ou non. */
  manual?: boolean;
  /** Arrêt demandé : on s'arrête proprement après la phase en cours (état sauvegardé). */
  signal?: AbortSignal;
  /** Arrêt immédiat (2e Ctrl+C) : la session agent en cours est interrompue, le ticket reste repris tel quel. */
  abortNow?: AbortSignal;
}

export interface TicketProcessor {
  process(project: ProjectConfig, iid: number, opts?: ProcessOptions): Promise<TicketState>;
}

/** Cause d'un blocage, qui détermine le commentaire posté. */
export type BlockCause =
  | { kind: "generic"; reason: string; details: string[] }
  | { kind: "needs-info"; reason: string; questions: string[] }
  | { kind: "base-ci"; reason: string; pipelineUrl: string };

/** Levée par une phase pour faire passer le ticket en `blocked`. */
export class TicketBlocked extends Error {
  constructor(readonly block: BlockCause) {
    super(block.reason);
    this.name = "TicketBlocked";
  }
}

/**
 * Arrêt demandé pendant une étape : le Ctrl+C du terminal atteint aussi les commandes lancées par git/gitops
 * (tests, setup), qui échouent alors pour une raison étrangère au ticket. L'état est conservé, sans blocage.
 */
class StopRequested extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopRequested";
  }
}

/** Tentatives de résolution par arrêt du rebase (un commit en conflit). */
export const MAX_REBASE_FIX_ATTEMPTS_PER_STOP = 2;
/** Plafond global d'arrêts du rebase (commits en conflit) sur une finalisation. */
export const MAX_REBASE_STOPS = 10;
const COMMIT_LIST_MAX = 50;
const IMAGES_SUBDIR = join(".sprintsaver", "images");
const CAPTURES_SUBDIR = join(".sprintsaver", "captures");
/** Écrans capturés au plus par MR (chaque écran = une paire avant/après). */
export const MAX_UI_SCREENS = 4;
const CAPTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Contenu « avant/après » de la description de MR : captures d'écran et changements de données. */
interface Showcase {
  captures: ScreenCapture[];
  capturesMissing?: string;
  dataChanges: DataChange[];
}

/** Worktree « avant » des captures, à côté de celui du ticket (le point est exclu des noms de projet). */
export function baseWorktreePath(worktreePath: string): string {
  return `${worktreePath}.avant`;
}

export function createTicketProcessor(deps: TicketProcessorDeps): TicketProcessor {
  return {
    async process(project, iid, opts = {}) {
      const key = ticketKey(project.name, iid);
      const existing = await deps.store.load(key);

      if (existing?.phase === "finalized") {
        await alreadyDelivered(deps, project, existing);
        return existing;
      }

      const run = new TicketRun(deps, project, iid, opts.signal, opts.abortNow);
      await run.init();
      let startPicking = false;
      if (!existing) {
        const issue = await deps.gitlab.getIssue(project.id, iid);
        await run.takeTriggerLabel();
        await run.restoreLabelOnFailure(() => run.createState(issue));
        startPicking = true;
      } else if (existing.phase === "blocked") {
        await run.takeTriggerLabel();
        await run.restoreLabelOnFailure(() => run.resumeBlocked(existing));
        startPicking = true;
      } else {
        run.adopt(existing);
        // Crash juste après la création de l'état : le statut « en cours » n'a peut-être pas été posé.
        startPicking = existing.phase === "picked";
        log.info({ ticket: key, phase: existing.phase }, `Reprise de ${key} après la phase « ${existing.phase} »`);
      }
      if (opts.manual) log.info({ ticket: key }, `Traitement manuel de ${key}`);
      return run.execute(startPicking);
    },
  };
}

async function alreadyDelivered(deps: TicketProcessorDeps, project: ProjectConfig, state: TicketState): Promise<void> {
  log.info({ ticket: state.key, mr: state.mrUrl }, `${state.key} est déjà livré : rien à faire`);
  const body = [
    `Ce ticket a déjà été livré par SprintSaver${state.mrUrl ? ` : ${state.mrUrl}` : ""}.`,
    "",
    `Pour le retraiter de zéro, supprimez la branche \`${state.branch}\` et le fichier d'état \`${paths.stateFile(state.key)}\`, puis remettez le label.`,
  ].join("\n");
  try {
    await deps.gitlab.comment(project.id, state.iid, body);
  } catch (err) {
    log.error({ err, ticket: state.key }, "Commentaire « déjà livré » impossible");
  }
  try {
    await deps.gitlab.removeLabel(project.id, state.iid, deps.config.triggerLabel);
  } catch (err) {
    log.debug({ err, ticket: state.key }, "Retrait du label impossible (absent ?)");
  }
}

class TicketRun {
  private readonly key: string;
  private readonly now: () => Date;
  private stateRef?: TicketState;
  private ticket?: P.TicketContext;
  private readonly iterations = new Map<string, number>();
  /** Un rebase est en cours (conflits) : à annuler en cas de blocage. */
  private rebasing = false;
  /** La branche a été réécrite par un rebase pendant ce passage : les pushes doivent être forcés. */
  private rewritten = false;
  /** Dernier sha poussé par ce processus (évite les pushes redondants ; inconnu après une reprise). */
  private lastPushedSha?: string;
  /** Début du segment de temps actif pas encore compté dans `state.activeMs` (epoch ms). */
  private activeMark: number;

  constructor(
    private readonly deps: TicketProcessorDeps,
    private readonly project: ProjectConfig,
    private readonly iid: number,
    private readonly stopSignal?: AbortSignal,
    private readonly abortNow?: AbortSignal,
  ) {
    this.key = ticketKey(project.name, iid);
    this.now = deps.now ?? (() => new Date());
    this.activeMark = this.now().getTime();
  }

  private get state(): TicketState {
    if (!this.stateRef) throw new Error("état du ticket non initialisé");
    return this.stateRef;
  }

  private get wt(): string {
    return this.state.worktreePath;
  }

  private get limits() {
    return this.deps.config.limits;
  }

  /** Reprend la numérotation des itérations là où les résumés déjà écrits l'ont laissée. */
  async init(): Promise<void> {
    try {
      for (const s of await this.deps.recorder.readSummaries(this.key)) {
        this.iterations.set(s.phase, Math.max(this.iterations.get(s.phase) ?? 0, s.iteration));
      }
    } catch (err) {
      log.debug({ err }, "Lecture des résumés de phase impossible");
    }
  }

  // -------------------------------------------------------------------------
  // Démarrage
  // -------------------------------------------------------------------------

  /**
   * Retrait du label déclencheur : c'est le verrou de prise en charge (ADR § 4). Obligatoire : s'il échoue,
   * le ticket n'est pas démarré (aucun état créé ni réinitialisé, aucun commentaire), sinon il serait repris
   * et recommenté à chaque cycle de polling.
   */
  async takeTriggerLabel(): Promise<void> {
    const label = this.deps.config.triggerLabel;
    try {
      await this.deps.gitlab.removeLabel(this.project.id, this.iid, label);
    } catch (err) {
      log.error({ err, ticket: this.key }, `Retrait du label « ${label} » de ${this.key} impossible : ticket non démarré`);
      throw new Error(`prise en charge de ${this.key} annulée : retrait du label « ${label} » impossible (${errorMessage(err)})`);
    }
  }

  /**
   * Le label a été retiré mais l'état n'a pas pu être créé ou enregistré : sans label ni état, le ticket
   * serait perdu sans trace. On remet le label (best-effort) pour qu'il soit repris au prochain cycle.
   */
  async restoreLabelOnFailure(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const label = this.deps.config.triggerLabel;
      try {
        await this.deps.gitlab.addLabel(this.project.id, this.iid, label);
        log.error({ err, ticket: this.key }, `État de ${this.key} impossible à enregistrer : label « ${label} » remis (${errorMessage(err)})`);
      } catch (e) {
        log.error(
          { err, ticket: this.key, labelErr: e },
          `État de ${this.key} impossible à enregistrer et label « ${label} » impossible à remettre : remettez-le à la main (${errorMessage(err)})`,
        );
      }
      throw err;
    }
  }

  async createState(issue: Issue): Promise<void> {
    const now = this.now().toISOString();
    this.stateRef = {
      version: 1,
      key: this.key,
      projectName: this.project.name,
      projectId: this.project.id,
      iid: this.iid,
      title: issue.title,
      webUrl: issue.webUrl,
      phase: "picked",
      branch: branchName(this.iid, issue.title),
      worktreePath: paths.worktree(this.key),
      startedAt: now,
      updatedAt: now,
      resumeCount: 0,
      counters: { testFix: 0, review: 0, ci: 0 },
      tests: [],
      nits: [],
      proofs: [],
      flakyJobs: [],
      activeMs: 0,
      // Un worktree laissé par un passage précédent (état supprimé) n'est pas réutilisé tel quel.
      recreateWorktree: true,
    };
    this.activeMark = this.now().getTime();
    log.info({ ticket: this.key, branch: this.state.branch }, `Prise en charge de ${this.key} : ${issue.title}`);
    await this.save();
  }

  /**
   * Reprise d'un ticket bloqué (ADR § 6) : même branche, compteurs et durée à zéro, analyse refaite. Le
   * worktree conservé pour inspection est recréé depuis le remote (la branche poussée au blocage fait foi).
   */
  async resumeBlocked(previous: TicketState): Promise<void> {
    const {
      blockedReason: _reason,
      phaseBeforeBlock: _before,
      reviewedSha: _sha,
      ciGreenSha: _green,
      pendingForcePush: _force,
      pendingRebaseReview: _rebase,
      proofsStale: _stale,
      priorCommits: _prior,
      deliverySteps: _delivery,
      ...rest
    } = previous;
    this.stateRef = {
      ...rest,
      phase: "picked",
      resumeCount: previous.resumeCount + 1,
      counters: { testFix: 0, review: 0, ci: 0 },
      startedAt: this.now().toISOString(),
      activeMs: 0,
      recreateWorktree: true,
      pickupCommented: false,
      nits: [],
      proofs: [],
      flakyJobs: [],
      ciRetriedShas: [],
    };
    this.activeMark = this.now().getTime();
    log.info(
      { ticket: this.key, resumeCount: this.state.resumeCount },
      `Reprise du ticket bloqué ${this.key} (bloqué pour : ${previous.blockedReason ?? "?"})`,
    );
    await this.save();
  }

  adopt(state: TicketState): void {
    this.stateRef = state;
  }

  // -------------------------------------------------------------------------
  // Boucle principale
  // -------------------------------------------------------------------------

  async execute(startPicking: boolean): Promise<TicketState> {
    try {
      if (startPicking) {
        this.checkDeadline();
        await this.stepPicked();
        await this.save();
      }
      const steps: Record<Exclude<TicketPhase, "blocked" | "picked">, () => Promise<void>> = {
        prepared: () => this.stepPrepared(),
        analysed: () => this.stepAnalysed(),
        tests_written: () => this.stepTestsWritten(),
        implemented: () => this.stepImplemented(),
        tests_green: () => this.ensureLocalTestsGreen(),
        reviewed: () => this.reviewLoop("full"),
        pushed: () => this.stepPushed(),
        ci_green: () => this.ciLoop(),
        finalized: () => this.stepFinalized(),
      };
      const start = TICKET_PHASES.indexOf(this.state.phase as (typeof TICKET_PHASES)[number]);
      for (const phase of TICKET_PHASES.slice(start + 1)) {
        if (phase === "picked") continue;
        if (this.stopSignal?.aborted) {
          log.warn({ ticket: this.key, phase: this.state.phase }, `Arrêt demandé : ${this.key} reprendra après « ${this.state.phase} »`);
          return this.state;
        }
        this.checkDeadline();
        log.info({ ticket: this.key, phase }, `${this.key} → ${phase}`);
        await steps[phase]();
        this.state.phase = phase;
        await this.save();
      }
      log.info({ ticket: this.key, mr: this.state.mrUrl }, `${this.key} livré : ${this.state.mrUrl ?? ""}`);
    } catch (err) {
      if (err instanceof AgentRunError && err.reason === "aborted") {
        await this.abortRebaseQuietly();
        log.warn({ ticket: this.key, phase: this.state.phase }, `Session ${err.phase} interrompue : ${this.key} reprendra après « ${this.state.phase} »`);
        return this.state;
      }
      // Après une demande d'arrêt, une erreur technique vient très probablement du Ctrl+C reçu par une
      // commande enfant : on conserve l'état pour reprise plutôt que de bloquer le ticket.
      if (err instanceof StopRequested || (this.stopSignal?.aborted && !(err instanceof TicketBlocked))) {
        await this.abortRebaseQuietly();
        log.warn(
          { ticket: this.key, phase: this.state.phase, err: errorMessage(err) },
          `Arrêt demandé : ${this.key} reprendra après « ${this.state.phase} » (${errorMessage(err)})`,
        );
        return this.state;
      }
      await this.block(toBlockCause(err));
    }
    await this.retro();
    return this.state;
  }

  private async save(): Promise<void> {
    this.accountActiveTime();
    this.state.updatedAt = this.now().toISOString();
    await this.deps.store.save(this.state);
  }

  /** Ajoute à `activeMs` le temps écoulé depuis le début du segment courant (ce processus). */
  private accountActiveTime(): void {
    const t = this.now().getTime();
    this.state.activeMs = (this.state.activeMs ?? 0) + Math.max(0, t - this.activeMark);
    this.activeMark = t;
  }

  private activeMs(): number {
    return (this.state.activeMs ?? 0) + Math.max(0, this.now().getTime() - this.activeMark);
  }

  private checkDeadline(): void {
    const activeMs = this.activeMs();
    if (activeMs > this.limits.maxDurationMin * 60_000) {
      throw new TicketBlocked({
        kind: "generic",
        reason: `durée maximale atteinte (${this.limits.maxDurationMin} min)`,
        details: [`Dernière phase atteinte : ${this.state.phase}`, `Temps de traitement cumulé : ${Math.round(activeMs / 60_000)} min`],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  /** Statut « en cours » (le label a été retiré par `takeTriggerLabel`). */
  private async stepPicked(): Promise<void> {
    await this.deps.gitlab.setStatus(this.project, this.iid, "inProgress");
  }

  private async stepPrepared(): Promise<void> {
    const { git, gitlab } = this.deps;
    await git.ensureReferenceClone(this.project);
    // Nouveau passage (ticket neuf ou bloqué remis en file) : on ne réutilise pas un worktree existant,
    // on le recrée depuis le remote. Une reprise après crash (recreateWorktree absent) le garde.
    if (this.state.recreateWorktree && existsSync(this.wt)) {
      log.info({ ticket: this.key, worktree: this.wt }, "Worktree existant supprimé : il est recréé depuis le remote");
      await git.removeWorktree(this.project, this.wt);
    }
    const existedOnRemote = await git.remoteBranchExists(this.project, this.state.branch);
    const { reused } = await git.createOrReuseWorktree(this.project, this.state.branch, this.wt);
    if (!reused && !existedOnRemote && !this.state.baseShaAtStart) {
      this.state.baseShaAtStart = await git.headSha(this.wt);
    }
    await git.prepareWorktree(this.project, this.wt, this.limits.commandTimeoutMin * 60_000);
    this.state.priorCommits = await this.branchCommits();
    this.state.recreateWorktree = false;

    // Dossier local à l'outil, ignoré par git (le .gitignore « * » s'ignore lui-même).
    const imagesDir = join(this.wt, IMAGES_SUBDIR);
    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(this.wt, ".sprintsaver", ".gitignore"), "*\n", "utf8");

    const ticket = await this.ticketContext();
    const texts = [ticket.issue.description, ...ticket.notes.map((n) => n.body)];
    let files: string[];
    if (gitlab.downloadImagesDetailed) {
      const res = await gitlab.downloadImagesDetailed(this.project, texts, imagesDir);
      files = res.saved;
      this.state.imagesFailed = res.failed.map((f) => `${f.url}${f.status !== undefined ? ` (HTTP ${f.status})` : ""}`);
      if (res.failed.length > 0) {
        log.warn({ ticket: this.key, failed: this.state.imagesFailed }, `${res.failed.length} image(s) du ticket non téléchargée(s)`);
      }
    } else {
      files = await gitlab.downloadImages(this.project, texts, imagesDir);
    }
    ticket.imagePaths = files.map((f) => (isAbsolute(f) ? relative(this.wt, f) : f));
    ticket.imagesFailed = this.state.imagesFailed;
  }

  private async stepAnalysed(): Promise<void> {
    const ticket = await this.ticketContext();
    const boxes = parseCheckboxes(ticket.issue.description);
    if (boxes.length === 0) {
      throw new TicketBlocked({
        kind: "needs-info",
        reason: "le ticket ne contient aucune case à cocher",
        questions: [
          "Le ticket ne contient aucune case à cocher : ajoutez les critères d'acceptation dans la description sous forme de cases (`- [ ] …`), une par comportement attendu.",
        ],
      });
    }

    const hint = typeFromIssue(ticket.issue, this.project);
    const res = await this.runAgent(
      "analyse",
      AnalyseOutput,
      P.buildAnalysePrompt({ ticket, criteria: boxes, typeHint: hint }),
      (o) => [
        `type ${hint?.type ?? o.type} (source ${hint?.source ?? "agent"})`,
        `${o.criteria.filter((c) => c.testable).length} critère(s) testable(s) sur ${boxes.length}`,
        ...(o.blockingQuestions.length > 0 ? [`${o.blockingQuestions.length} question(s) bloquante(s)`] : []),
      ],
      // Type pas tranché par les labels : les deux skills de type (recherche de précédents du skill bug).
      { ticketType: hint?.type ?? "feature", typeSkills: hint ? undefined : ["bug", "feature"] },
    );
    const out = res.output;
    const analysis: AnalysisResult = {
      type: hint?.type ?? out.type,
      typeSource: hint?.source ?? "agent",
      summary: out.summary,
      plan: out.plan,
      criteria: boxes.map((b) => {
        const c = out.criteria.find((x) => x.index === b.index);
        return {
          index: b.index,
          text: b.text,
          checkedInitially: b.checked,
          testable: c?.testable ?? false,
          reason: c?.reason ?? "non classé par l'analyse",
        };
      }),
      precedents: out.precedents,
      assumptions: out.assumptions,
      blockingQuestions: out.blockingQuestions,
    };
    this.state.analysis = analysis;
    await this.save();

    if (out.blockingQuestions.length > 0) {
      throw new TicketBlocked({
        kind: "needs-info",
        reason: "ambiguïtés bloquantes dans le ticket",
        questions: out.blockingQuestions,
      });
    }

    if (!this.state.pickupCommented) {
      await this.deps.gitlab.comment(this.project.id, this.iid, pickupComment(analysis, this.state.branch));
      this.state.pickupCommented = true;
      await this.save();
    }
  }

  private async stepTestsWritten(): Promise<void> {
    const analysis = this.analysis();
    if (!analysis.criteria.some((c) => c.testable)) {
      log.info({ ticket: this.key }, "Aucun critère testable : pas de phase d'écriture des tests");
      return;
    }
    const ticket = await this.ticketContext();
    const res = await this.runAgent(
      "write-tests",
      WriteTestsOutput,
      P.buildWriteTestsPrompt({ ticket, analysis, existingWork: this.state.priorCommits }),
      (o) => [
      `${o.tests.length} test(s) déclaré(s)`,
        ...o.tests.map((t) => shortFact(`${t.change === "added" ? "ajouté" : "modifié"} ${t.name} → critères ${t.criteria.join(",")}`)),
      ],
    );
    this.state.tests = mergeTests(this.state.tests, res.output.tests);
    await this.save();
    await this.commit(`test: tests des critères du ticket #${this.iid}`);
  }

  private async stepImplemented(): Promise<void> {
    const analysis = this.analysis();
    const ticket = await this.ticketContext();
    const res = await this.runAgent(
      "implement",
      ImplementOutput,
      P.buildImplementPrompt({ ticket, analysis, tests: this.state.tests, existingWork: this.state.priorCommits }),
      (o) => [
        `tests verts d'après l'agent : ${o.testsPassingLocally ? "oui" : "non"}`,
        ...(o.testsAdjusted.length > 0 ? [`${o.testsAdjusted.length} test(s) ajusté(s)`] : []),
      ],
    );
    this.state.tests = mergeTests(this.state.tests, res.output.testsAdjusted);
    await this.save();
    const prefix = analysis.type === "bug" ? "fix" : "feat";
    await this.commit(`${prefix}: ${this.state.title.replace(/\s+/g, " ").trim()} (#${this.iid})`);
  }

  /** Boucle test/fix locale (compteur testFix partagé par tous les appels du passage). */
  private async ensureLocalTestsGreen(): Promise<void> {
    if (this.project.testMode !== "local") {
      log.info({ ticket: this.key }, "Projet en mode ci-only : la CI fera foi pour les tests");
      return;
    }
    const command = this.project.testCommand;
    if (!command) {
      log.warn({ ticket: this.key }, `Aucune testCommand configurée pour ${this.project.name} : tests locaux ignorés`);
      return;
    }
    for (;;) {
      this.checkDeadline();
      const startedAt = this.now();
      const res = await this.deps.git.run(this.wt, command, this.limits.commandTimeoutMin * 60_000);
      const green = res.exitCode === 0 && !res.timedOut;
      if (!green && this.stopSignal?.aborted) {
        // Probablement tuée par le Ctrl+C : ni itération test/fix consommée, ni session de correction.
        throw new StopRequested(`tests interrompus (${command})`);
      }
      const failing = green ? [] : extractFailingTests(res.output);
      const willBlock = !green && this.state.counters.testFix + 1 > this.limits.testFix;
      await this.record({
        phase: "tests-local",
        iteration: this.nextIteration("tests-local"),
        startedAt: startedAt.toISOString(),
        durationMs: res.durationMs,
        outcome: green ? "ok" : willBlock ? "blocked" : "retry",
        facts: green
          ? [`${command} : vert en ${Math.round(res.durationMs / 1000)} s`]
          : [
              res.timedOut ? `${command} : délai dépassé` : `${command} : code de sortie ${res.exitCode}`,
              ...(failing.length > 0 ? [shortFact(`tests en échec : ${failing.join(", ")}`, 400)] : []),
            ],
      });
      if (green) return;

      this.state.counters.testFix += 1;
      await this.save();
      if (this.state.counters.testFix > this.limits.testFix) {
        throw new TicketBlocked({
          kind: "generic",
          reason: `plafond d'itérations test/fix atteint (${this.limits.testFix})`,
          details: [
            `Commande : \`${command}\` (${res.timedOut ? "délai dépassé" : `code de sortie ${res.exitCode}`})`,
            ...(failing.length > 0 ? [`Tests en échec : ${failing.join(", ")}`] : []),
          ],
        });
      }

      const ticket = await this.ticketContext();
      const fix = await this.runAgent(
        "test-fix",
        FixOutput,
        P.buildTestFixPrompt({
          ticket,
          analysis: this.analysis(),
          tests: this.state.tests,
          command,
          output: res.output,
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          iteration: this.state.counters.testFix,
        }),
        fixFacts,
      );
      this.adoptAdjustedTests(fix.output.testsAdjusted);
      await this.save();
      await this.commit(`fix: corrige les tests (#${this.iid})`);
    }
  }

  /**
   * Boucle de review. Mode "full" : diff complet + vérification des critères. Mode "delta" : uniquement ce
   * qui a changé depuis la dernière review (`reviewedSha`). Mode "rebase" : diff complet après résolution de
   * conflits. En delta et en rebase, la vérification des critères (ADR § 5) est refaite si les preuves sont
   * périmées : tests ajustés par une phase de correction (`proofsStale`), ou fichiers de test déclarés
   * touchés par le delta (ou par les conflits résolus).
   */
  private async reviewLoop(initialMode: P.ReviewMode, conflictedFiles?: string[]): Promise<void> {
    const { git } = this.deps;
    const fromSha = this.state.reviewedSha;
    const mode: P.ReviewMode = initialMode === "delta" && !fromSha ? "full" : initialMode;
    for (;;) {
      this.checkDeadline();
      const head = await git.headSha(this.wt);
      let diff: string;
      if (mode === "delta" && fromSha) {
        diff = head === fromSha ? "" : await git.diffRange(this.wt, fromSha, head);
      } else {
        diff = await git.diffAgainstBase(this.project, this.wt);
      }

      const touched = mode === "delta" ? P.diffFiles(diff) : mode === "rebase" ? (conflictedFiles ?? []) : [];
      if (!this.state.proofsStale && this.touchesDeclaredTests(touched)) {
        this.state.proofsStale = true;
        await this.save();
      }
      const analysis = this.analysis();
      const testable = analysis.criteria.filter((c) => c.testable);
      // Aucun critère testable : aucune preuve à refaire.
      if (testable.length === 0) this.state.proofsStale = false;
      const verifyNeeded = testable.length > 0 && (mode === "full" || this.state.proofsStale === true);
      const skipReview = mode === "delta" && diff.trim() === "";
      if (skipReview && !verifyNeeded) {
        this.state.reviewedSha = head;
        await this.save();
        return;
      }

      const ticket = await this.ticketContext();
      const findings: Finding[] = [];
      if (!skipReview) {
        const review = await this.runAgent(
          "review",
          ReviewOutput,
          P.buildReviewPrompt({ ticket, analysis, diff, mode, conflictedFiles }),
          (o) => findingFacts(o.findings, mode),
        );
        findings.push(...review.output.findings.map((f) => ({ ...f })));
      }

      let proofs: CriterionProof[] | undefined;
      if (verifyNeeded) {
        const verify = await this.runAgent(
          "verify-criteria",
          VerifyCriteriaOutput,
          P.buildVerifyCriteriaPrompt({ ticket, analysis, tests: this.state.tests }),
          (o) => {
            const unproven = o.proofs.filter((p) => !p.proven);
            return [
              `${o.proofs.filter((p) => p.proven).length}/${testable.length} critère(s) prouvé(s)`,
              ...unproven.map((p) => shortFact(`critère [${p.index}] non prouvé : ${p.reason}`)),
            ];
          },
        );
        proofs = testable.map(
          (c) =>
            verify.output.proofs.find((p) => p.index === c.index) ?? {
              index: c.index,
              proven: false,
              tests: [],
              reason: "non évalué par la vérification",
            },
        );
        for (const p of proofs.filter((x) => !x.proven)) {
          const text = analysis.criteria.find((c) => c.index === p.index)?.text ?? "";
          findings.push({
            severity: "blocking",
            category: "criterion",
            description: `Critère [${p.index}] non prouvé par un test (« ${text} ») : ${p.reason}`,
          });
        }
      }

      const blocking = findings.filter((f) => f.severity === "blocking");
      const nits = findings.filter((f) => f.severity !== "blocking");
      if (blocking.length === 0) {
        this.state.nits = mode === "full" ? nits : dedupeFindings([...this.state.nits, ...nits]);
        if (proofs) {
          this.state.proofs = proofs;
          this.state.proofsStale = false;
        }
        this.state.reviewedSha = await git.headSha(this.wt);
        await this.save();
        return;
      }

      this.state.counters.review += 1;
      await this.save();
      if (this.state.counters.review > this.limits.review) {
        throw new TicketBlocked({
          kind: "generic",
          reason: `plafond d'itérations de review atteint (${this.limits.review})`,
          details: blocking.map((f) => shortFact(`${f.file ? `${f.file}${f.line !== undefined ? `:${f.line}` : ""} : ` : ""}${f.description}`, 300)),
        });
      }

      const fix = await this.runAgent(
        "review-fix",
        FixOutput,
        P.buildReviewFixPrompt({ ticket, analysis, tests: this.state.tests, findings: blocking, iteration: this.state.counters.review }),
        fixFacts,
      );
      this.adoptAdjustedTests(fix.output.testsAdjusted);
      await this.save();
      await this.commit(`fix(review): corrige les retours de review (#${this.iid})`);
      await this.ensureLocalTestsGreen();
    }
  }

  /** Tests ajustés par une phase de correction : enregistrés, et preuves des critères à refaire. */
  private adoptAdjustedTests(adjusted: TestEntry[]): void {
    this.state.tests = mergeTests(this.state.tests, adjusted);
    if (adjusted.length > 0) this.state.proofsStale = true;
  }

  /** Un des fichiers donnés est-il un fichier de test déclaré pour ce ticket ? */
  private touchesDeclaredTests(files: string[]): boolean {
    if (files.length === 0 || this.state.tests.length === 0) return false;
    const norm = (f: string) => normalize(f).replace(/^\.\//, "");
    const declared = new Set(this.state.tests.map((t) => norm(t.file)));
    return files.some((f) => declared.has(norm(f)));
  }

  /**
   * Une review est-elle due sur `head` ? Oui si les preuves sont périmées ou si HEAD n'est pas celui de la
   * dernière review (correctif commité puis crash ou 2e Ctrl+C avant la fin de sa review). Exception : une
   * résolution de conflits de rebase en attente (`pendingRebaseReview`), relue par la review « rebase ».
   */
  private reviewDue(head: string): boolean {
    if (this.state.pendingRebaseReview) return false;
    return this.state.proofsStale === true || this.state.reviewedSha !== head;
  }

  /** Tests puis review du delta (et vérification des critères si les preuves sont périmées) si une review est due. */
  private async ensureReviewed(): Promise<void> {
    const head = await this.deps.git.headSha(this.wt);
    if (!this.reviewDue(head)) return;
    log.info(
      { ticket: this.key, head, reviewedSha: this.state.reviewedSha, proofsStale: this.state.proofsStale },
      "Travail non relu depuis la dernière review (reprise après interruption ?) : tests et review du delta",
    );
    await this.ensureLocalTestsGreen();
    await this.reviewLoop("delta");
  }

  /** Annule un rebase resté en cours dans le worktree (sans effet s'il n'y en a pas), sans lever. */
  private async abortRebaseQuietly(): Promise<void> {
    if (!this.stateRef || !existsSync(this.wt)) return;
    try {
      await this.deps.git.rebaseAbort(this.wt);
    } catch (err) {
      log.error({ err, ticket: this.key }, `Annulation du rebase en cours impossible (${errorMessage(err)})`);
    }
    this.rebasing = false;
  }

  /** Pousse la branche si HEAD n'a pas déjà été poussé par ce processus (forcé si l'historique a été réécrit). */
  private async pushBranch(opts: { force?: boolean } = {}): Promise<void> {
    const { git } = this.deps;
    const head = await git.headSha(this.wt);
    if (this.lastPushedSha === head && !opts.force) return;
    await git.push(this.wt, this.state.branch, { force: opts.force || this.rewritten || this.state.pendingForcePush === true });
    this.lastPushedSha = head;
  }

  /** Commits du ticket présents sur la branche (`origin/<défaut>..HEAD`), le plus récent d'abord. */
  private async branchCommits(): Promise<string[]> {
    const range = `origin/${this.project.defaultBranch}..HEAD`;
    try {
      const res = await this.deps.git.run(
        this.wt,
        `git log --oneline --no-decorate -n ${COMMIT_LIST_MAX} ${shellQuote(range)}`,
        60_000,
      );
      if (res.exitCode !== 0 || res.timedOut) return [];
      return res.output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{7,40}\s/.test(l));
    } catch (err) {
      log.debug({ err, ticket: this.key }, "Liste des commits de la branche impossible");
      return [];
    }
  }

  /** Identifiant de l'arrêt courant du rebase : le commit en cours d'application (REBASE_HEAD). */
  private async rebaseStopId(conflictedFiles: string[]): Promise<string> {
    try {
      const res = await this.deps.git.run(this.wt, "git rev-parse --verify -q REBASE_HEAD", 60_000);
      const sha = res.output.trim().split(/\s+/)[0] ?? "";
      if (res.exitCode === 0 && sha) return `commit:${sha}`;
    } catch (err) {
      log.debug({ err, ticket: this.key }, "REBASE_HEAD illisible");
    }
    return `files:${[...conflictedFiles].sort().join(",")}`;
  }

  private async stepPushed(): Promise<void> {
    const { gitlab } = this.deps;
    await this.pushBranch();
    const existing = await gitlab.findOpenMrForBranch(this.project.id, this.state.branch);
    let mr = existing;
    if (existing) {
      await gitlab.updateMr(this.project.id, existing.iid, { description: this.mrDescription(true) });
    } else {
      mr = await gitlab.createDraftMr({
        projectId: this.project.id,
        sourceBranch: this.state.branch,
        targetBranch: this.project.defaultBranch,
        title: mrTitle(this.state.title, this.iid),
        description: this.mrDescription(true),
      });
    }
    if (!mr) throw new Error("création de la MR impossible");
    this.state.mrIid = mr.iid;
    this.state.mrUrl = mr.webUrl;
    await this.save();
  }

  private async waitCi(sha: string, kind: "wait" | "retry", run: () => Promise<PipelineOutcome>): Promise<PipelineOutcome> {
    const startedAt = this.now();
    const t0 = Date.now();
    const outcome = await run();
    const failedJobs = outcome.kind === "failed" ? outcome.failedJobs.map((j) => j.name) : [];
    await this.record({
      phase: "ci",
      iteration: this.nextIteration("ci"),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - t0,
      outcome: outcome.kind === "success" || outcome.kind === "none" ? "ok" : outcome.kind === "failed" ? "retry" : "blocked",
      facts: [
        `${kind === "retry" ? "relance des jobs en échec" : "pipeline"} sur ${sha.slice(0, 8)} : ${outcome.kind}`,
        ...(failedJobs.length > 0 ? [shortFact(`jobs en échec : ${failedJobs.join(", ")}`, 400)] : []),
      ],
    });
    return outcome;
  }

  /**
   * Boucle CI (ADR § 7.6) : relance unique des jobs, base cassée, ci-fix, re-review du delta.
   *
   * Chaque itération commence par relire ce qui ne l'a pas été (`ensureReviewed` : correctif commité puis
   * crash avant la fin de sa review, ou preuves périmées), puis pousse la branche : un correctif commité mais
   * pas poussé avant un crash l'est à la reprise, sinon on attendrait un pipeline sur un sha absent du remote. « Aucun pipeline » ne
   * vaut « pas de CI » que si aucun pipeline n'a jamais été vu pour ce ticket (`ciSeen`) ; sinon c'est un
   * blocage.
   */
  private async ciLoop(): Promise<void> {
    const { git, gitlab } = this.deps;
    const timeoutMs = this.limits.ciTimeoutMin * 60_000;
    for (;;) {
      this.checkDeadline();
      // Reprise après une interruption entre le commit d'un correctif et la fin de sa review : relu (et
      // preuves refaites) avant d'être poussé.
      await this.ensureReviewed();
      await this.pushBranch();
      const sha = await git.headSha(this.wt);
      let outcome = await this.waitCi(sha, "wait", () =>
        gitlab.waitForPipeline({ project: this.project, sha, branch: this.state.branch, mrIid: this.state.mrIid, timeoutMs }),
      );
      if (outcome.kind !== "none" && !this.state.ciSeen) {
        this.state.ciSeen = true;
        await this.save();
      }
      if (outcome.kind === "success") return this.markCiGreen(sha);
      if (outcome.kind === "none") {
        if (this.state.ciSeen) {
          throw new TicketBlocked({
            kind: "generic",
            reason: `pipeline introuvable pour ${sha.slice(0, 8)}`,
            details: [
              `Aucun pipeline n'est apparu pour le commit ${sha} de \`${this.state.branch}\`, alors que la CI a déjà tourné pour ce ticket.`,
              "Vérifiez que la branche est bien poussée et que la CI n'est pas désactivée ou filtrée pour ce commit.",
            ],
          });
        }
        log.info({ ticket: this.key, sha }, "Aucun pipeline pour ce commit : pas de CI à attendre");
        return this.markCiGreen(sha);
      }
      if (outcome.kind === "timeout" || outcome.kind === "canceled") throw ciStopped(outcome, this.limits.ciTimeoutMin);

      const retried = this.state.ciRetriedShas ?? [];
      if (!retried.includes(sha)) {
        this.state.ciRetriedShas = [...retried, sha];
        await this.save();
        const failed = outcome;
        const retry = await this.waitCi(sha, "retry", () =>
          gitlab.retryJobsAndWait({ project: this.project, pipeline: failed.pipeline, jobs: failed.failedJobs, timeoutMs }),
        );
        if (retry.kind === "success") {
          const names = failed.failedJobs.map((j) => j.name);
          this.state.flakyJobs = [...new Set([...this.state.flakyJobs, ...names])];
          log.info({ ticket: this.key, jobs: names }, "Jobs instables : verts après relance");
          return this.markCiGreen(sha);
        }
        if (retry.kind === "timeout" || retry.kind === "canceled") throw ciStopped(retry, this.limits.ciTimeoutMin);
        if (retry.kind === "failed") outcome = retry;
      }

      const base = await gitlab.latestFinishedPipeline(this.project.id, this.project.defaultBranch);
      if (base?.status === "failed") {
        throw new TicketBlocked({
          kind: "base-ci",
          reason: `CI de ${this.project.defaultBranch} cassée, indépendante du ticket`,
          pipelineUrl: base.webUrl,
        });
      }

      this.state.counters.ci += 1;
      await this.save();
      if (this.state.counters.ci > this.limits.ci) {
        throw new TicketBlocked({
          kind: "generic",
          reason: `plafond d'itérations CI atteint (${this.limits.ci})`,
          details: [`Pipeline : ${outcome.pipeline.webUrl}`, `Jobs en échec : ${outcome.failedJobs.map((j) => j.name).join(", ")}`],
        });
      }

      const jobs = [];
      for (const job of outcome.failedJobs) {
        let jobLog: string;
        try {
          // Job d'un pipeline enfant d'un autre projet : son log est dans ce projet-là.
          jobLog = await gitlab.jobLog(job.projectId ?? this.project.id, job.id, P.MAX_LOG_CHARS);
        } catch (err) {
          jobLog = `(log indisponible : ${errorMessage(err)})`;
        }
        jobs.push({ name: job.name, stage: job.stage, webUrl: job.webUrl, log: jobLog });
      }
      const ticket = await this.ticketContext();
      const fix = await this.runAgent(
        "ci-fix",
        FixOutput,
        P.buildCiFixPrompt({
          ticket,
          analysis: this.analysis(),
          tests: this.state.tests,
          pipelineUrl: outcome.pipeline.webUrl,
          jobs,
          iteration: this.state.counters.ci,
        }),
        fixFacts,
      );
      this.adoptAdjustedTests(fix.output.testsAdjusted);
      await this.save();
      await this.commit(`fix(ci): corrige la CI (#${this.iid})`);
      await this.ensureLocalTestsGreen();
      await this.reviewLoop("delta");
      // Le push est fait au début de l'itération suivante.
    }
  }

  private async markCiGreen(sha: string): Promise<void> {
    this.state.ciGreenSha = sha;
    await this.save();
  }

  /**
   * Finalisation (ADR § 7.7), en sous-étapes persistées dans `deliverySteps` : une reprise saute celles déjà
   * faites. Une fois la MR passée en Ready, le worktree n'est plus nécessaire (pas de nouveau rebase).
   */
  private async stepFinalized(): Promise<void> {
    const { git, gitlab } = this.deps;
    const mrIid = this.state.mrIid;
    if (mrIid === undefined) throw new Error("aucune MR enregistrée pour ce ticket");
    const steps = (this.state.deliverySteps ??= {});

    if (!steps.mrReady) {
      steps.summary = await this.rebaseAndMarkReady(mrIid);
      steps.mrReady = true;
      await this.save();
    } else {
      log.info({ ticket: this.key, mr: this.state.mrUrl }, "Reprise de la livraison : MR déjà passée en Ready");
    }
    const analysis = this.analysis();
    const summary = steps.summary ?? analysis.summary;

    // 3. Cases prouvées cochées sur le ticket (description relue fraîchement).
    const testable = analysis.criteria.filter((c) => c.testable);
    const proven = this.state.proofs
      .filter((p) => p.proven && testable.some((c) => c.index === p.index))
      .map((p) => p.index);
    if (!steps.boxesChecked) {
      // Par index ET texte : la description a pu changer depuis l'analyse (case ajoutée ou déplacée).
      const fresh = await gitlab.getIssue(this.project.id, this.iid);
      const checked = checkBoxesByText(
        fresh.description,
        proven.map((index) => ({ index, text: analysis.criteria.find((c) => c.index === index)?.text ?? "" })),
      );
      if (checked !== fresh.description) await gitlab.updateIssueDescription(this.project.id, this.iid, checked);
      steps.boxesChecked = true;
      await this.save();
    }

    // 4. Statut, commentaire de livraison, nettoyage.
    if (!steps.statusSet) {
      await gitlab.setStatus(this.project, this.iid, "inReview");
      steps.statusSet = true;
      await this.save();
    }
    if (!steps.commented) {
      await gitlab.comment(
        this.project.id,
        this.iid,
        deliveredComment({
          mrUrl: this.state.mrUrl ?? "",
          summary,
          provenCount: proven.length,
          totalTestable: testable.length,
          untestable: analysis.criteria.filter((c) => !c.testable).map((c) => `${c.text}${c.reason ? ` (${c.reason})` : ""}`),
        }),
      );
      steps.commented = true;
      await this.save();
    }
    if (!steps.worktreeRemoved) {
      // Worktree « avant » laissé par un crash pendant les captures.
      if (existsSync(baseWorktreePath(this.wt))) await git.removeWorktree(this.project, baseWorktreePath(this.wt));
      await git.removeWorktree(this.project, this.wt);
      steps.worktreeRemoved = true;
      await this.save();
    }
  }

  /** Rebase, tests/review/CI si besoin, rédaction de la MR puis Ready. Retourne le résumé rédigé. */
  private async rebaseAndMarkReady(mrIid: number): Promise<string> {
    const { git, gitlab, config } = this.deps;

    // 0. Rebase laissé arrêté par un crash ou un arrêt (rebase-fix interrompu) : annulé, il est refait.
    //    Sans effet s'il n'y en a pas.
    await git.rebaseAbort(this.wt);
    this.rebasing = false;
    // Travail non relu (correctif commité puis interruption) : relu AVANT le rebase, sinon un rebase propre
    // déplacerait reviewedSha par-dessus et le delta ne serait jamais relu.
    await this.ensureReviewed();

    // 1. Rebase sur la branche par défaut, conflits résolus par l'agent : au plus
    //    MAX_REBASE_FIX_ATTEMPTS_PER_STOP tentatives par arrêt (commit en conflit), MAX_REBASE_STOPS arrêts.
    const before = await git.headSha(this.wt);
    let rebase = await git.rebaseOnDefault(this.project, this.wt);
    const conflicted = new Set<string>();
    let stops = 0;
    let attemptsThisStop = 0;
    let currentStop: string | null = null;
    while (!rebase.ok) {
      this.rebasing = true;
      rebase.conflictedFiles.forEach((f) => conflicted.add(f));
      const stopId = await this.rebaseStopId(rebase.conflictedFiles);
      if (stopId !== currentStop) {
        currentStop = stopId;
        stops += 1;
        attemptsThisStop = 0;
      }
      if (attemptsThisStop >= MAX_REBASE_FIX_ATTEMPTS_PER_STOP || stops > MAX_REBASE_STOPS) {
        await git.rebaseAbort(this.wt);
        this.rebasing = false;
        throw new TicketBlocked({
          kind: "generic",
          reason:
            stops > MAX_REBASE_STOPS
              ? `conflits de rebase sur ${this.project.defaultBranch} : plus de ${MAX_REBASE_STOPS} commits en conflit`
              : `conflits de rebase sur ${this.project.defaultBranch} non résolus après ${MAX_REBASE_FIX_ATTEMPTS_PER_STOP} tentatives sur le même commit`,
          details: [`Fichiers en conflit : ${[...conflicted].join(", ")}`, `Arrêts du rebase : ${Math.min(stops, MAX_REBASE_STOPS + 1)}`],
        });
      }
      attemptsThisStop += 1;
      const files = rebase.conflictedFiles;
      const ticket = await this.ticketContext();
      const fix = await this.runAgent(
        "rebase-fix",
        FixOutput,
        P.buildRebaseFixPrompt({
          ticket,
          analysis: this.analysis(),
          defaultBranch: this.project.defaultBranch,
          conflictedFiles: files,
          attempt: attemptsThisStop,
        }),
        (o) => [shortFact(`conflits : ${files.join(", ")}`), ...fixFacts(o)],
      );
      this.adoptAdjustedTests(fix.output.testsAdjusted);
      // Marqueurs de conflit restants : `rebaseContinue` renvoie le même arrêt, compté comme une tentative ratée.
      rebase = await git.rebaseContinue(this.wt);
    }
    this.rebasing = false;

    const after = await git.headSha(this.wt);
    if (after !== before) {
      this.state.pendingForcePush = true;
      if (stops === 0) {
        // Rebase propre : le contenu relu est inchangé, seule la base a bougé (le delta éventuel a été relu
        // avant le rebase). La prochaine review de delta part du HEAD rebasé (sinon elle embarquerait tout l'amont).
        this.state.reviewedSha = after;
      } else {
        this.state.pendingRebaseReview = [...conflicted];
      }
      await this.save();
    }
    // pendingForcePush couvre un crash entre le rebase et la fin de la CI : à la reprise,
    // le rebase est un no-op (after === before) mais la branche distante n'est pas à jour.
    if (this.state.pendingForcePush) {
      this.rewritten = true;
      log.info({ ticket: this.key, conflicts: [...conflicted] }, "Branche rebasée : nouvelle passe de tests, de review et de CI");
      await this.ensureLocalTestsGreen();
      const rebaseReview = this.state.pendingRebaseReview;
      if (rebaseReview) {
        await this.reviewLoop("rebase", rebaseReview);
        this.state.pendingRebaseReview = undefined;
        await this.save();
      } else {
        // Correctifs `fix:` éventuels de la boucle de tests après le rebase.
        await this.reviewLoop("delta");
      }
      await this.pushBranch({ force: true });
      await this.ciLoop();
      this.state.pendingForcePush = false;
      await this.save();
    }
    // Avant la rédaction : HEAD relu (preuves à jour) et validé par la CI (ex. reprise d'un état antérieur à
    // ciGreenSha) ; sinon boucle CI, qui relit d'abord ce qui doit l'être.
    const head = await git.headSha(this.wt);
    if (this.reviewDue(head) || this.state.ciGreenSha !== head) await this.ciLoop();

    // 2. Description finale, MR Ready et assignée.
    const analysis = this.analysis();
    const ticket = await this.ticketContext();
    const diff = await git.diffAgainstBase(this.project, this.wt);
    const writeup = await this.runAgent(
      "mr-writeup",
      MrWriteupOutput,
      P.buildMrWriteupPrompt({ ticket, analysis, tests: this.state.tests, proofs: this.state.proofs, nits: this.state.nits, diff }),
      (o) => [shortFact(`titre : ${o.title}`), shortFact(`nature : ${o.changeKinds.join(", ") || "interne"}`)],
    );
    const showcase = await this.showcase(writeup.output, ticket, analysis, diff);
    await gitlab.updateMr(this.project.id, mrIid, {
      title: mrTitle(writeup.output.title, this.iid),
      description: this.mrDescription(false, writeup.output.summary, showcase),
      // Toujours l'humain de la config : avec un Project Access Token, l'auteur de la MR est le bot du projet
      // (ADR, amendement 1). Le moteur ne déduit jamais l'utilisateur du jeton.
      assigneeIds: [config.gitlab.userId],
    });
    await gitlab.markMrReady(this.project.id, mrIid);
    return writeup.output.summary;
  }

  // -------------------------------------------------------------------------
  // Blocage
  // -------------------------------------------------------------------------

  private async block(cause: BlockCause): Promise<void> {
    const { git, gitlab } = this.deps;
    const st = this.state;
    log.warn({ ticket: this.key, phase: st.phase, reason: cause.reason }, `${this.key} bloqué : ${cause.reason}`);

    const safe = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        log.error({ err, ticket: this.key }, `Blocage de ${this.key} : ${what} impossible (${errorMessage(err)})`);
      }
    };

    if (existsSync(st.worktreePath)) {
      // Rebase arrêté (conflits de ce passage, ou laissé par un crash avant la reprise) : annulé avant le WIP,
      // sinon le commit irait sur la HEAD détachée du rebase. Sans effet s'il n'y en a pas.
      await safe("annulation du rebase", () => git.rebaseAbort(st.worktreePath));
      this.rebasing = false;
      await safe("commit WIP", async () => {
        if (await git.isDirty(st.worktreePath)) await git.commitAll(st.worktreePath, "wip: travail en cours SprintSaver");
      });
      await safe("push de la branche", async () => {
        const head = await git.headSha(st.worktreePath);
        if (st.baseShaAtStart === undefined || head !== st.baseShaAtStart) {
          // Branche rebasée pendant ce passage ou lors d'un passage interrompu, pas encore poussée.
          await git.push(st.worktreePath, st.branch, { force: this.rewritten || st.pendingForcePush === true });
        }
      });
    }
    await safe("statut bloqué", () => gitlab.setStatus(this.project, this.iid, "blocked"));
    await safe("commentaire de blocage", () => gitlab.comment(this.project.id, this.iid, this.blockComment(cause)));
    if (st.mrIid !== undefined) {
      const mrIid = st.mrIid;
      await safe("mise à jour de la MR", () => gitlab.updateMr(this.project.id, mrIid, { description: this.mrDescription(true) }));
    }

    st.phaseBeforeBlock = st.phase;
    st.blockedReason = cause.reason;
    st.phase = "blocked";
    await this.save();
  }

  private blockComment(cause: BlockCause): string {
    const { config } = this.deps;
    const me = config.gitlab.username; // l'humain, jamais le bot d'un jeton de projet
    switch (cause.kind) {
      case "needs-info": {
        const author = this.ticket?.issue.authorUsername;
        return needsInfoComment(cause.questions, author ? [author, me] : [me], config.triggerLabel);
      }
      case "base-ci":
        return baseCiBrokenComment({
          defaultBranch: this.project.defaultBranch,
          pipelineUrl: cause.pipelineUrl,
          branch: this.state.branch,
          mentions: [me],
          triggerLabel: config.triggerLabel,
        });
      case "generic":
        return blockedComment({
          reason: cause.reason,
          details: cause.details,
          branch: this.state.branch,
          mrUrl: this.state.mrUrl,
          mentions: [me],
          triggerLabel: config.triggerLabel,
        });
    }
  }

  // -------------------------------------------------------------------------
  // Rétro
  // -------------------------------------------------------------------------

  private async retro(): Promise<void> {
    const { config, recorder } = this.deps;
    const st = this.state;
    if (!config.retro.enabled || (st.phase !== "finalized" && st.phase !== "blocked")) return;
    try {
      const root = this.deps.skillsRepoRoot ?? toolRoot();
      let projectSkill: string | null = null;
      try {
        projectSkill = await readFile(join(root, "skills", "projects", `${this.project.name}.md`), "utf8");
      } catch {
        projectSkill = null;
      }
      const summaries = await recorder.readSummaries(this.key);
      const res = await this.runAgent(
        "retro",
        RetroOutput,
        P.buildRetroPrompt({
          projectName: this.project.name,
          outcome: st.phase === "finalized" ? "finalized" : "blocked",
          blockedReason: st.blockedReason,
          summaries,
          projectSkill,
        }),
        (o) => [`${o.lessons.length} leçon(s)`, o.patch.trim() ? "patch proposé" : "aucun patch"],
        { worktreePath: root },
      );
      const dir = paths.run(this.key);
      await mkdir(dir, { recursive: true });
      const md = [`# Rétro ${this.key}`, "", ...(res.output.lessons.length > 0 ? res.output.lessons.map((l) => `- ${l}`) : ["Aucune leçon : le ticket n'a pas coûté d'itération évitable."]), ""].join("\n");
      await writeFile(join(dir, "retro.md"), md, "utf8");
      const patch = res.output.patch.trim();
      if (patch) {
        const patchPath = join(dir, "retro.patch");
        await writeFile(patchPath, `${patch}\n`, "utf8");
        log.info({ ticket: this.key, patch: patchPath }, `Rétro : patch de skills proposé dans ${patchPath} (git apply dans ${root})`);
      } else {
        log.info({ ticket: this.key, retro: join(dir, "retro.md") }, `Rétro écrite dans ${join(dir, "retro.md")} (aucun patch proposé)`);
      }
    } catch (err) {
      log.error({ err, ticket: this.key }, `Rétro de ${this.key} en échec : ${errorMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------

  private analysis(): AnalysisResult {
    const a = this.state.analysis;
    if (!a) throw new Error("analyse absente de l'état du ticket");
    return a;
  }

  private ticketType(): TicketType {
    return this.state.analysis?.type ?? "feature";
  }

  /** Ticket relu sur GitLab une fois par passage (ADR § 4 : ticket gelé pendant le traitement). */
  private async ticketContext(): Promise<P.TicketContext> {
    if (!this.ticket) {
      const { gitlab } = this.deps;
      const [issue, notes, linked] = await Promise.all([
        gitlab.getIssue(this.project.id, this.iid),
        gitlab.getIssueNotes(this.project.id, this.iid),
        gitlab.getLinkedIssues(this.project.id, this.iid),
      ]);
      let imagePaths: string[] = [];
      try {
        imagePaths = (await readdir(join(this.wt, IMAGES_SUBDIR))).sort().map((f) => join(IMAGES_SUBDIR, f));
      } catch {
        imagePaths = [];
      }
      this.ticket = {
        issue,
        notes,
        linked,
        imagePaths,
        imagesFailed: this.state.imagesFailed,
        repo: {
          branch: this.state.branch,
          defaultBranch: this.project.defaultBranch,
          testCommand: this.project.testCommand,
          buildCommand: this.project.buildCommand,
          testMode: this.project.testMode,
        },
      };
    }
    return this.ticket;
  }

  // -------------------------------------------------------------------------
  // Avant / après dans la MR (ADR, amendement 3)
  // -------------------------------------------------------------------------

  /**
   * Changements de données et d'API décrits par la rédaction, et captures avant/après si le changement touche
   * l'interface. Les captures ne bloquent jamais la livraison : un échec est signalé dans la MR.
   */
  private async showcase(
    writeup: MrWriteupOutput,
    ticket: P.TicketContext,
    analysis: AnalysisResult,
    diff: string,
  ): Promise<Showcase> {
    const dataChanges = writeup.dataChanges.filter((d) => d.subject.trim() !== "" && (d.before.trim() !== "" || d.after.trim() !== ""));
    if (!writeup.changeKinds.includes("ui") || !this.deps.config.screenshots.enabled) return { captures: [], dataChanges };
    const screens = writeup.uiScreens.filter((s) => s.label.trim() !== "").slice(0, MAX_UI_SCREENS);
    if (screens.length === 0) {
      return { captures: [], capturesMissing: "aucun écran à capturer n'a été désigné", dataChanges };
    }
    return { ...(await this.captureScreens(screens, ticket, analysis, diff)), dataChanges };
  }

  private async captureScreens(
    screens: { label: string; howToReach: string }[],
    ticket: P.TicketContext,
    analysis: AnalysisResult,
    diff: string,
  ): Promise<Omit<Showcase, "dataChanges">> {
    const { git } = this.deps;
    const basePath = baseWorktreePath(this.wt);
    const capturesDir = join(this.wt, CAPTURES_SUBDIR);
    // Raison affichée dans la MR : courte et sans détail local (chemins, sorties de commande), qui reste au journal.
    let stage = "échec de la préparation de la version « avant »";
    try {
      await rm(capturesDir, { recursive: true, force: true });
      await mkdir(capturesDir, { recursive: true });
      await git.createBaseWorktree(this.project, this.wt, basePath);
      await git.prepareWorktree(this.project, basePath, this.limits.commandTimeoutMin * 60_000);
      stage = "échec de la session de captures";
      const res = await this.runAgent(
        "ui-captures",
        UiCapturesOutput,
        P.buildUiCapturesPrompt({ ticket, analysis, screens, basePath, capturesDir: CAPTURES_SUBDIR, diff }),
        (o) => [shortFact(`captures : ${o.captures.length}/${screens.length}`), ...(o.skippedReason ? [shortFact(`manquantes : ${o.skippedReason}`)] : [])],
        { extraWritableRoots: [basePath] },
      );
      return await this.publishCaptures(res.output, capturesDir);
    } catch (err) {
      if ((err instanceof AgentRunError && err.reason === "aborted") || this.stopSignal?.aborted) throw err;
      log.warn({ ticket: this.key, err: errorMessage(err) }, "Captures d'écran impossibles, MR livrée sans captures");
      const why = err instanceof AgentRunError ? ` (${AGENT_ERROR_LABELS[err.reason]})` : "";
      return { captures: [], capturesMissing: `${stage}${why}` };
    } finally {
      await this.cleanupAfterCaptures(basePath);
    }
  }

  /** Téléverse les captures valides (dossier de captures, format image) et prépare leur rendu. */
  private async publishCaptures(output: UiCapturesOutput, capturesDir: string): Promise<Omit<Showcase, "dataChanges">> {
    const problems: string[] = [];
    const upload = async (label: string, side: "avant" | "après", raw: string): Promise<string | undefined> => {
      if (raw.trim() === "") return undefined;
      // Liens résolus : une capture ne peut pas désigner un fichier hors du dossier de captures.
      const abs = resolve(this.wt, raw.trim());
      const real = existsSync(abs) ? realpathSync(abs) : null;
      const inside = real !== null && real.startsWith(realpathSync(capturesDir) + sep);
      if (!inside || !CAPTURE_EXTENSIONS.has(extname(real).toLowerCase())) {
        problems.push(`${label} (${side}) : fichier invalide ou absent`);
        return undefined;
      }
      try {
        return (await this.deps.gitlab.uploadFile(this.project.id, real)).markdown;
      } catch (err) {
        problems.push(`${label} (${side}) : téléversement impossible`);
        log.warn({ ticket: this.key, file: abs, err: errorMessage(err) }, "Capture non téléversée");
        return undefined;
      }
    };

    const captures: ScreenCapture[] = [];
    for (const c of output.captures.slice(0, MAX_UI_SCREENS)) {
      const beforeMarkdown = await upload(c.label, "avant", c.before);
      const afterMarkdown = await upload(c.label, "après", c.after);
      if (afterMarkdown === undefined && beforeMarkdown === undefined) continue;
      captures.push({ label: c.label, beforeMarkdown, afterMarkdown, note: c.note });
    }
    const missing = [output.skippedReason.trim(), ...problems].filter((m) => m !== "").join(" ; ");
    if (captures.length === 0 && missing === "") return { captures, capturesMissing: "la session n'a produit aucune capture" };
    return missing === "" ? { captures } : { captures, capturesMissing: missing };
  }

  /** Supprime le worktree « avant » et annule toute modification laissée dans le worktree par la session. */
  private async cleanupAfterCaptures(basePath: string): Promise<void> {
    const { git } = this.deps;
    try {
      if (existsSync(basePath)) await git.removeWorktree(this.project, basePath);
    } catch (err) {
      log.warn({ ticket: this.key, basePath, err: errorMessage(err) }, "Worktree « avant » non supprimé");
    }
    try {
      if (await git.isDirty(this.wt)) {
        log.warn({ ticket: this.key }, "La session de captures a modifié le worktree : modifications annulées");
        await git.discardChanges(this.wt);
      }
    } catch (err) {
      log.warn({ ticket: this.key, err: errorMessage(err) }, "Nettoyage du worktree après les captures impossible");
    }
  }

  private mrDescription(inProgress: boolean, summary?: string, showcase?: Showcase): string {
    const st = this.state;
    const a = st.analysis;
    return renderMrDescription({
      iid: st.iid,
      issueUrl: st.webUrl,
      summary: summary ?? a?.summary ?? "",
      criteria: a?.criteria ?? [],
      proofs: st.proofs,
      tests: st.tests,
      assumptions: a?.assumptions ?? [],
      nits: st.nits,
      flakyJobs: st.flakyJobs,
      captures: showcase?.captures,
      capturesMissing: showcase?.capturesMissing,
      dataChanges: showcase?.dataChanges,
      inProgress,
    });
  }

  private async commit(message: string): Promise<string | null> {
    const sha = await this.deps.git.commitAll(this.wt, message);
    if (sha) log.info({ ticket: this.key, sha: sha.slice(0, 8) }, `Commit : ${message}`);
    else log.info({ ticket: this.key }, `Rien à commiter pour « ${message} »`);
    return sha;
  }

  private nextIteration(phase: string): number {
    const n = (this.iterations.get(phase) ?? 0) + 1;
    this.iterations.set(phase, n);
    return n;
  }

  private async record(summary: Omit<PhaseSummary, "ticketKey">): Promise<void> {
    try {
      await this.deps.recorder.recordPhase({ ticketKey: this.key, ...summary });
    } catch (err) {
      log.warn({ err, ticket: this.key }, "Écriture du résumé de phase impossible");
    }
  }

  private async runAgent<T>(
    phase: AgentPhase,
    schema: z.ZodType<T>,
    bundle: P.PromptBundle,
    facts: (output: T) => string[],
    opts: { ticketType?: TicketType; typeSkills?: TicketType[]; worktreePath?: string; extraWritableRoots?: string[] } = {},
  ): Promise<AgentRunResult<T>> {
    const iteration = this.nextIteration(phase);
    const startedAt = this.now();
    const t0 = Date.now();
    try {
      const res = await this.deps.agent.run({
        phase,
        ticketType: opts.ticketType ?? this.ticketType(),
        project: this.project,
        ticketKey: this.key,
        worktreePath: opts.worktreePath ?? this.wt,
        prompt: bundle.prompt,
        context: bundle.context === "" ? undefined : bundle.context,
        outputSchema: schema,
        iteration,
        typeSkills: opts.typeSkills,
        extraWritableRoots: opts.extraWritableRoots,
        abortSignal: this.abortNow,
      });
      await this.record({
        phase,
        iteration,
        startedAt: startedAt.toISOString(),
        durationMs: res.durationMs,
        outcome: "ok",
        numTurns: res.numTurns,
        costUsd: res.costUsd,
        skillsLoaded: res.skillsLoaded,
        facts: facts(res.output),
      });
      return res;
    } catch (err) {
      await this.record({
        phase,
        iteration,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - t0,
        outcome: "error",
        facts: [shortFact(err instanceof AgentRunError ? `${err.reason} : ${err.message}` : errorMessage(err), 400)],
      });
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------

const AGENT_ERROR_LABELS: Record<AgentRunError["reason"], string> = {
  max_turns: "nombre maximal de tours atteint",
  invalid_output: "sortie structurée invalide",
  execution_error: "erreur d'exécution",
  aborted: "session interrompue",
};

export function toBlockCause(err: unknown): BlockCause {
  if (err instanceof TicketBlocked) return err.block;
  if (err instanceof AgentRunError) {
    return {
      kind: "generic",
      reason: `session « ${err.phase} » en échec : ${AGENT_ERROR_LABELS[err.reason]}`,
      details: [shortFact(err.message, 500)],
    };
  }
  return { kind: "generic", reason: `erreur technique : ${errorMessage(err)}`, details: [] };
}

function ciStopped(outcome: PipelineOutcome, timeoutMin: number): TicketBlocked {
  if (outcome.kind === "canceled") {
    return new TicketBlocked({ kind: "generic", reason: "pipeline CI annulé", details: [`Pipeline : ${outcome.pipeline.webUrl}`] });
  }
  const url = outcome.kind === "timeout" ? outcome.pipeline?.webUrl : undefined;
  return new TicketBlocked({
    kind: "generic",
    reason: `CI non terminée après ${timeoutMin} min`,
    details: url ? [`Pipeline : ${url}`] : [],
  });
}

/** Titre de MR : sans préfixe Draft (géré par GitLab), suffixé par « (#iid) » s'il n'y est pas déjà. */
export function mrTitle(title: string, iid: number): string {
  const clean = title
    .replace(/^\s*(?:draft:|\[draft\]|\(draft\))\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.includes(`(#${iid})`) ? clean : `${clean} (#${iid})`;
}

function fixFacts(o: FixOutput): string[] {
  return [
    shortFact(`cause : ${o.rootCause}`),
    ...(o.unrelatedToTicket ? ["échec jugé sans rapport avec le ticket"] : []),
    ...(o.testsAdjusted.length > 0 ? [`${o.testsAdjusted.length} test(s) ajusté(s)`] : []),
  ];
}

function findingFacts(findings: Finding[], mode: P.ReviewMode): string[] {
  const blocking = findings.filter((f) => f.severity === "blocking");
  return [
    `review ${mode} : ${blocking.length} bloquant(s), ${findings.length - blocking.length} nit(s)`,
    ...blocking.map((f) => shortFact(`[${f.category}] ${f.file ? `${f.file} : ` : ""}${f.description}`)),
  ];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.file ?? ""}:${f.line ?? ""}:${f.description}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
