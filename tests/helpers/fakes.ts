/** Doubles en mémoire des contrats, pour tester le moteur sans GitLab, git ni Claude. */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  CommandResult,
  GitLabApi,
  GitOps,
  Issue,
  Job,
  MrRef,
  Note,
  PhaseSummary,
  Pipeline,
  PipelineOutcome,
  QueuedIssue,
  RebaseResult,
  RunRecorder,
  StateStore,
  TicketState,
} from "../../src/contracts.js";
import { ConfigSchema, ProjectConfigSchema, type AgentPhase, type Config, type ProjectConfig } from "../../src/config/schema.js";
import { parseCheckboxes } from "../../src/domain/checkboxes.js";
import type { AgentProposal } from "../../src/agent/config-agent.js";

export function makeProject(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return ProjectConfigSchema.parse({
    name: "demo",
    id: 7,
    path: "team/demo",
    httpUrl: "https://gitlab.example.com/team/demo.git",
    defaultBranch: "main",
    testCommand: "npm test",
    status: { mode: "labels", inProgress: "st::doing", inReview: "st::review", blocked: "st::blocked" },
    ...over,
  });
}

export function makeConfig(over: Partial<Config> = {}, project = makeProject()): Config {
  return {
    ...ConfigSchema.parse({
      gitlab: { username: "me", userId: 42 },
      projects: [project],
    }),
    ...over,
  };
}

export const DEFAULT_DESCRIPTION = [
  "Contexte libre.",
  "",
  "- [ ] le bouton affiche le total",
  "- [ ] le total est arrondi au centime",
  "- [ ] le design est joli",
].join("\n");

export function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    projectId: 7,
    iid: 12,
    title: "Afficher le total du panier",
    state: "opened",
    webUrl: "https://gitlab.example.com/team/demo/-/issues/12",
    labels: ["auto::ready"],
    description: DEFAULT_DESCRIPTION,
    issueType: "issue",
    authorUsername: "alice",
    createdAt: "2026-11-01T10:00:00Z",
    ...over,
  };
}

const pipeline = (status: Pipeline["status"], id = 1): Pipeline => ({
  id,
  status,
  sha: "x",
  ref: "b",
  webUrl: `https://gitlab.example.com/p/${id}`,
});
export const job = (name: string, id = 100): Job => ({
  id,
  name,
  stage: "test",
  status: "failed",
  webUrl: `https://gitlab.example.com/j/${id}`,
  allowFailure: false,
});
export const ciSuccess = (): PipelineOutcome => ({ kind: "success", pipeline: pipeline("success") });
export const ciFailed = (jobs: Job[] = [job("unit")], id = 2): PipelineOutcome => ({ kind: "failed", pipeline: pipeline("failed", id), failedJobs: jobs });
export const ciNoRunner = (id = 7): PipelineOutcome => ({ kind: "no-runner", pipeline: pipeline("pending", id) });
export const basePipeline = (status: Pipeline["status"]): Pipeline => pipeline(status, 99);

/** Journal partagé des appels, pour vérifier l'ordre entre GitLab, git et l'agent. */
export class CallLog {
  readonly entries: string[] = [];
  push(e: string): void {
    this.entries.push(e);
  }
  indexOf(prefix: string): number {
    return this.entries.findIndex((e) => e.startsWith(prefix));
  }
  count(prefix: string): number {
    return this.entries.filter((e) => e.startsWith(prefix)).length;
  }
}

export class FakeGitLab implements GitLabApi {
  issue: Issue = makeIssue();
  notes: Note[] = [{ id: 1, authorUsername: "bob", body: "Voir la capture ![](/uploads/abc/shot.png)", createdAt: "2026-11-02T10:00:00Z" }];
  linked: Issue[] = [];
  comments: string[] = [];
  queue: QueuedIssue[] = [];
  queueError: Error | null = null;
  removeLabelError: Error | null = null;
  pipelineOutcomes: PipelineOutcome[] = [];
  retryOutcomes: PipelineOutcome[] = [];
  base: Pipeline | null = basePipeline("success");
  /** Jobs en échec du dernier pipeline de la branche par défaut (`base`). */
  baseFailedJobs: Job[] = [];
  /** Logs de jobs par id (sinon un log générique). */
  jobLogs = new Map<number, string>();
  existingMr: MrRef | null = null;
  mrUpdates: { mrIid: number; patch: { title?: string; description?: string; assigneeIds?: number[] } }[] = [];
  descriptions: string[] = [];
  waitCalls: { sha: string; mrIid?: number }[] = [];
  /** Images en échec renvoyées par downloadImagesDetailed. */
  failedImages: { url: string; status?: number }[] = [];
  jobLogCalls: { projectId: number; jobId: number }[] = [];

  constructor(readonly log: CallLog) {}

  async currentUser() {
    return { id: 42, username: "me", name: "Me" };
  }
  async listQueuedIssues(): Promise<QueuedIssue[]> {
    this.log.push("gitlab.listQueuedIssues");
    if (this.queueError) throw this.queueError;
    return this.queue;
  }
  async getIssue(): Promise<Issue> {
    this.log.push("gitlab.getIssue");
    return { ...this.issue };
  }
  async getIssueNotes(): Promise<Note[]> {
    return this.notes;
  }
  async getLinkedIssues(): Promise<Issue[]> {
    return this.linked;
  }
  async downloadImages(_p: ProjectConfig, texts: string[], destDir: string): Promise<string[]> {
    this.log.push("gitlab.downloadImages");
    return texts.some((t) => t.includes("/uploads/")) ? [`${destDir}/shot.png`] : [];
  }
  async downloadImagesDetailed(p: ProjectConfig, texts: string[], destDir: string) {
    return { saved: await this.downloadImages(p, texts, destDir), failed: this.failedImages };
  }
  async addLabel(_id: number, _iid: number, label: string): Promise<void> {
    this.log.push(`gitlab.addLabel:${label}`);
  }
  async removeLabel(_id: number, _iid: number, label: string): Promise<void> {
    this.log.push(`gitlab.removeLabel:${label}`);
    if (this.removeLabelError) throw this.removeLabelError;
  }
  async updateIssueDescription(_id: number, _iid: number, description: string): Promise<void> {
    this.log.push("gitlab.updateIssueDescription");
    this.descriptions.push(description);
    this.issue = { ...this.issue, description };
  }
  async comment(_id: number, _iid: number, body: string): Promise<void> {
    this.log.push("gitlab.comment");
    this.comments.push(body);
  }
  async setStatus(_p: ProjectConfig, _iid: number, role: string): Promise<void> {
    this.log.push(`gitlab.setStatus:${role}`);
  }
  async findOpenMrForBranch(): Promise<MrRef | null> {
    return this.existingMr;
  }
  async createDraftMr(input: { title: string; description: string }): Promise<MrRef> {
    this.log.push(`gitlab.createDraftMr:${input.title}`);
    this.existingMr = { iid: 5, webUrl: "https://gitlab.example.com/team/demo/-/merge_requests/5" };
    return this.existingMr;
  }
  async updateMr(_id: number, mrIid: number, patch: { title?: string; description?: string; assigneeIds?: number[] }): Promise<void> {
    this.log.push(`gitlab.updateMr${patch.assigneeIds ? `:assignee=${patch.assigneeIds.join(",")}` : ""}`);
    this.mrUpdates.push({ mrIid, patch });
  }
  async markMrReady(): Promise<void> {
    this.log.push("gitlab.markMrReady");
  }
  /** Fichiers téléversés (chemins locaux), dans l'ordre. */
  uploads: string[] = [];
  uploadError: Error | null = null;
  async uploadFile(_id: number, filePath: string): Promise<{ markdown: string; url: string }> {
    this.log.push("gitlab.uploadFile");
    if (this.uploadError) throw this.uploadError;
    this.uploads.push(filePath);
    const name = filePath.split("/").pop() ?? "file";
    const url = `/uploads/secret${this.uploads.length}/${name}`;
    return { url, markdown: `![${name}](${url})` };
  }
  async waitForPipeline(input: { sha: string; mrIid?: number }): Promise<PipelineOutcome> {
    this.log.push(`gitlab.waitForPipeline:${input.sha}`);
    this.waitCalls.push({ sha: input.sha, mrIid: input.mrIid });
    return this.pipelineOutcomes.shift() ?? ciSuccess();
  }
  async retryJobsAndWait(input: { jobs: Job[] }): Promise<PipelineOutcome> {
    this.log.push(`gitlab.retryJobsAndWait:${input.jobs.map((j) => j.name).join(",")}`);
    return this.retryOutcomes.shift() ?? ciSuccess();
  }
  async latestFinishedPipeline(): Promise<Pipeline | null> {
    this.log.push("gitlab.latestFinishedPipeline");
    return this.base;
  }
  async pipelineFailedJobs(_projectId: number, pipelineId: number): Promise<Job[]> {
    this.log.push(`gitlab.pipelineFailedJobs:${pipelineId}`);
    return this.baseFailedJobs;
  }
  async jobLog(projectId: number, jobId: number): Promise<string> {
    this.jobLogCalls.push({ projectId, jobId });
    return this.jobLogs.get(jobId) ?? `log du job ${jobId}\nError: expected 2 got 3`;
  }
  async searchIssues() {
    return [];
  }
  async closingMrs() {
    return [];
  }
  async mrDiff() {
    return "";
  }
}

export class FakeGit implements GitOps {
  private n = 0;
  head = "base0";
  commits: string[] = [];
  pushes: { force: boolean; head: string }[] = [];
  testResults: CommandResult[] = [];
  /**
   * Commits en conflit que rencontrera le prochain `rebaseOnDefault`, dans l'ordre (un arrêt du rebase
   * chacun). Comme avec git : un `rebaseContinue` dont la résolution est complète passe à l'arrêt suivant
   * (le même conflit ne revient pas) ; tant que des marqueurs subsistent (`failedAttempts`), il renvoie le
   * même conflit sur le même commit.
   */
  rebaseStops: FakeRebaseStop[] = [];
  /** Rebase arrêté en cours dans le worktree (comme `.git/rebase-merge`). */
  rebaseInProgress = false;
  private pendingStops: { files: string[]; id: string; left: number }[] = [];
  private headBeforeRebase = "";
  /** Le rebase sans conflit réécrit-il HEAD ? */
  rebaseMovesHead = false;
  dirty = false;
  diffRanges: [string, string][] = [];
  removed: string[] = [];
  /** Sortie de `git log --oneline origin/<défaut>..HEAD` (commits déjà sur la branche). */
  branchLog = "";
  /** Diff renvoyé par diffRange (défaut : `diff <from>..<to>`). */
  rangeDiff: string | null = null;

  constructor(readonly log: CallLog) {}

  async ensureReferenceClone(p: ProjectConfig) {
    this.log.push("git.ensureReferenceClone");
    return `/repos/${p.name}`;
  }
  async remoteBranchExists() {
    return false;
  }
  async createOrReuseWorktree(_p: ProjectConfig, branch: string, wtPath: string) {
    this.log.push(`git.createOrReuseWorktree:${branch}`);
    const reused = existsSync(wtPath);
    mkdirSync(wtPath, { recursive: true });
    return { reused };
  }
  async prepareWorktree(_p: ProjectConfig, _wtPath: string, _timeoutMs: number) {
    this.log.push("git.prepareWorktree");
  }
  async removeWorktree(_p: ProjectConfig, wtPath: string) {
    this.log.push("git.removeWorktree");
    this.removed.push(wtPath);
    rmSync(wtPath, { recursive: true, force: true });
  }
  /** Worktrees « avant » créés (chemins). */
  baseWorktrees: string[] = [];
  async createBaseWorktree(_p: ProjectConfig, _wt: string, basePath: string) {
    this.log.push("git.createBaseWorktree");
    this.baseWorktrees.push(basePath);
    mkdirSync(basePath, { recursive: true });
  }
  /** Worktrees détachés sur la branche par défaut créés (chemins). */
  detachedWorktrees: string[] = [];
  async createDetachedWorktree(_p: ProjectConfig, wtPath: string) {
    this.log.push("git.createDetachedWorktree");
    this.detachedWorktrees.push(wtPath);
    mkdirSync(wtPath, { recursive: true });
  }
  async discardChanges() {
    this.log.push("git.discardChanges");
    this.dirty = false;
  }
  async commitAll(_wt: string, message: string): Promise<string | null> {
    // Un commit pendant un rebase arrêté irait sur la HEAD détachée : jamais voulu par le moteur.
    if (this.rebaseInProgress) throw new Error("commit pendant un rebase en cours (HEAD détachée)");
    this.log.push(`git.commit:${message}`);
    this.commits.push(message);
    this.dirty = false;
    this.head = `sha${++this.n}`;
    return this.head;
  }
  async push(_wt: string, _branch: string, opts?: { force?: boolean }) {
    if (this.rebaseInProgress) throw new Error("push pendant un rebase en cours (HEAD détachée)");
    this.log.push(`git.push${opts?.force ? ":force" : ""}`);
    this.pushes.push({ force: opts?.force ?? false, head: this.head });
  }
  async headSha() {
    return this.head;
  }
  async diffAgainstBase() {
    this.log.push("git.diffAgainstBase");
    return "diff --git a/src/cart.ts b/src/cart.ts\n+total";
  }
  async diffRange(_wt: string, from: string, to: string) {
    this.log.push(`git.diffRange:${from}..${to}`);
    this.diffRanges.push([from, to]);
    return this.rangeDiff ?? `diff ${from}..${to}`;
  }
  async isDirty() {
    return this.dirty;
  }
  async rebaseOnDefault() {
    this.log.push("git.rebaseOnDefault");
    if (this.rebaseInProgress) throw new Error("fatal: It seems that there is already a rebase-merge directory");
    const stops = this.rebaseStops.splice(0);
    if (stops.length === 0) {
      if (this.rebaseMovesHead) this.head = `rebased${++this.n}`;
      return { ok: true } as RebaseResult;
    }
    this.pendingStops = stops.map((st, i) => ({ files: st.files, id: st.id ?? `stop${i + 1}`, left: st.failedAttempts ?? 0 }));
    this.headBeforeRebase = this.head;
    this.head = `detached${++this.n}`;
    this.rebaseInProgress = true;
    return { ok: false, conflictedFiles: [...this.pendingStops[0]!.files] } as RebaseResult;
  }
  async rebaseContinue(): Promise<RebaseResult> {
    this.log.push("git.rebaseContinue");
    if (!this.rebaseInProgress) throw new Error("fatal: no rebase in progress");
    const current = this.pendingStops[0]!;
    if (current.left > 0) {
      // Marqueurs de conflit restants : rien n'est continué, même arrêt.
      current.left -= 1;
      return { ok: false, conflictedFiles: [...current.files] };
    }
    this.pendingStops.shift();
    const next = this.pendingStops[0];
    if (next) {
      this.head = `detached${++this.n}`;
      return { ok: false, conflictedFiles: [...next.files] };
    }
    this.rebaseInProgress = false;
    this.head = `rebased${++this.n}`;
    return { ok: true };
  }
  /** Sans effet s'il n'y a pas de rebase en cours (comme gitops). */
  async rebaseAbort() {
    if (!this.rebaseInProgress) return;
    this.log.push("git.rebaseAbort");
    this.rebaseInProgress = false;
    this.pendingStops = [];
    this.head = this.headBeforeRebase;
  }
  /** Simule un rebase laissé arrêté par un crash (conflit sur `files`). */
  interruptedRebase(files: string[] = ["src/cart.ts"]): void {
    this.pendingStops = [{ files, id: "stop1", left: 0 }];
    this.headBeforeRebase = this.head;
    this.head = `detached${++this.n}`;
    this.rebaseInProgress = true;
  }
  async run(_wt: string, command: string): Promise<CommandResult> {
    this.log.push(`git.run:${command}`);
    // Commandes git de l'orchestrateur (n'entament pas la file des résultats de tests).
    if (command.startsWith("git log")) return { exitCode: 0, output: this.branchLog, timedOut: false, durationMs: 5 };
    if (command.includes("REBASE_HEAD")) {
      const id = this.rebaseInProgress ? this.pendingStops[0]?.id : undefined;
      return id ? { exitCode: 0, output: `${id}\n`, timedOut: false, durationMs: 5 } : { exitCode: 1, output: "", timedOut: false, durationMs: 5 };
    }
    return this.testResults.shift() ?? { exitCode: 0, output: "all green", timedOut: false, durationMs: 1000 };
  }
}

export interface FakeRebaseStop {
  files: string[];
  /** REBASE_HEAD de cet arrêt (défaut : `stop<n>`). */
  id?: string;
  /** Nombre de `rebaseContinue` qui trouvent encore des marqueurs de conflit (résolution ratée). */
  failedAttempts?: number;
}

export const red = (output = "FAIL src/cart.test.ts > total arrondi\n1 failed"): CommandResult => ({
  exitCode: 1,
  output,
  timedOut: false,
  durationMs: 2000,
});

type Handler = (req: AgentRunRequest<unknown>, n: number) => unknown;

/** Agent factice : une sortie par défaut cohérente par phase, surchargeable (fonction ou file de sorties). */
export class FakeAgent implements AgentRunner {
  readonly requests: AgentRunRequest<unknown>[] = [];
  readonly handlers: Partial<Record<AgentPhase, Handler | unknown[]>> = {};
  private readonly counts = new Map<AgentPhase, number>();

  constructor(
    readonly log: CallLog,
    private readonly gitlab: FakeGitLab,
  ) {}

  phases(): AgentPhase[] {
    return this.requests.map((r) => r.phase);
  }

  on(phase: AgentPhase, handler: Handler | unknown[]): this {
    this.handlers[phase] = handler;
    return this;
  }

  async run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    this.log.push(`agent.${req.phase}`);
    this.requests.push(req as AgentRunRequest<unknown>);
    const n = (this.counts.get(req.phase) ?? 0) + 1;
    this.counts.set(req.phase, n);
    const h = this.handlers[req.phase];
    let raw: unknown;
    if (typeof h === "function") raw = (h as Handler)(req as AgentRunRequest<unknown>, n);
    else if (Array.isArray(h) && h.length > 0) raw = h.length > 1 ? h.shift() : h[0];
    else raw = this.defaultOutput(req.phase);
    const output = req.outputSchema.parse(raw);
    return { output, numTurns: 3, durationMs: 1500, costUsd: 0.1, skillsLoaded: [`phases/${req.phase}`] };
  }

  private defaultOutput(phase: AgentPhase): unknown {
    const boxes = parseCheckboxes(this.gitlab.issue.description);
    const fix = { summary: "corrigé", rootCause: "cause", testsAdjusted: [], unrelatedToTicket: false };
    switch (phase) {
      case "analyse":
        return {
          type: "feature",
          summary: "Afficher le total.",
          plan: ["calculer", "afficher"],
          criteria: boxes.map((b) => ({
            index: b.index,
            testable: !b.text.includes("joli"),
            reason: b.text.includes("joli") ? "subjectif" : "test unitaire",
          })),
          precedents: [{ ref: "#3", relevant: true, why: "même composant" }],
          assumptions: ["arrondi bancaire"],
          blockingQuestions: [],
        };
      case "write-tests":
        return {
          tests: [
            { name: "affiche le total", file: "src/cart.test.ts", change: "added", criteria: [0], explanation: "vérifie l'affichage" },
            { name: "arrondit", file: "src/cart.test.ts", change: "added", criteria: [1], explanation: "vérifie l'arrondi" },
          ],
          redEvidence: "2 failed",
          notes: "",
        };
      case "implement":
        return { summary: "fait", testsAdjusted: [], testsPassingLocally: true };
      case "review":
        return { findings: [{ severity: "nit", category: "style", description: "nom de variable" }], summary: "ok" };
      case "verify-criteria":
        return {
          proofs: boxes
            .filter((b) => !b.text.includes("joli"))
            .map((b) => ({ index: b.index, proven: true, tests: ["t"], reason: "asserte" })),
        };
      case "mr-writeup":
        return { title: "Total du panier", summary: "Ajoute le total arrondi.", changeKinds: [], uiScreens: [], dataChanges: [] };
      case "ui-captures":
        return { captures: [], skippedReason: "", launchRecipe: "" };
      case "retro":
        return { lessons: ["lancer les tests plus tôt"], patch: "--- a/skills/projects/demo.md\n+++ b/skills/projects/demo.md\n@@ -0,0 +1 @@\n+piège" };
      default:
        return fix;
    }
  }
}

export class MemoryStore implements StateStore {
  readonly states = new Map<string, TicketState>();
  readonly savedPhases: string[] = [];
  async load(key: string) {
    const s = this.states.get(key);
    return s ? structuredClone(s) : null;
  }
  async save(state: TicketState) {
    this.savedPhases.push(state.phase);
    this.states.set(state.key, structuredClone(state));
  }
  async list() {
    return [...this.states.values()].map((s) => structuredClone(s));
  }
  async remove(key: string) {
    this.states.delete(key);
  }
}

export class MemoryRecorder implements RunRecorder {
  readonly summaries: PhaseSummary[] = [];
  async recordPhase(s: PhaseSummary) {
    this.summaries.push(s);
  }
  async readSummaries(key: string) {
    return this.summaries.filter((s) => s.ticketKey === key);
  }
}

/** Sortie type de l'agent de configuration (init). */
export const makeAgentProposal = (over: Partial<AgentProposal> = {}): AgentProposal => ({
  name: "shop",
  localCheckout: "",
  stack: "Python 3.10 / unittest",
  setupCommand: "uv venv --python 3.10 .venv",
  buildCommand: "",
  testCommand: ".venv/bin/python -m unittest discover -s tests",
  testMode: "local",
  ciSource: "merge_request",
  worktreeInclude: [],
  cowDirs: [],
  status: {
    inProgress: { kind: "native", name: "In progress", id: "gid://s/2" },
    inReview: { kind: "label", name: "sprintsaver::en-review", id: "" },
    blocked: { kind: "label", name: "sprintsaver::bloque", id: "" },
  },
  typeLabels: { bug: ["bug"], feature: ["feature"] },
  toolchain: [{ tool: "python", required: "3.10", source: ".python-version, image python:3.10", available: "défaut 3.15 ; uv 3.10.22", pinnedBy: "uv venv --python 3.10" }],
  prerequisites: [],
  verification: { status: "passed", failingTests: [], note: "setup et tests passent" },
  explanation: "La CI et .python-version exigent Python 3.10.",
  ...over,
});
