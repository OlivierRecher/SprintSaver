/**
 * Implémentation de `GitLabApi` (src/contracts.ts) sur le client REST/GraphQL maison (rest.ts).
 * @gitbeaker/rest n'est pas utilisé ici : un helper fetch typé couvre tous les endpoints,
 * permet d'injecter fetch/sleep/horloge dans les tests et garde la gestion d'erreurs/retry uniforme.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Config, ProjectConfig, StatusRole } from "../config/schema.js";
import { glabToken, hostOf, type TokenProvider } from "./glab-auth.js";
import type {
  GitLabApi,
  GitLabUser,
  Issue,
  IssueSummary,
  Job,
  MrRef,
  MrSummary,
  Note,
  Pipeline,
  PipelineOutcome,
  PipelineStatus,
  QueuedIssue,
} from "../contracts.js";
import { log } from "../log.js";
import { pipelineWaitsForRunner, setWorkItemStatus } from "./graphql.js";
import { GitLabHttpError, GitLabRest, pid, type HttpDeps } from "./rest.js";
import {
  extractImageUploads,
  formatUnifiedDiff,
  head,
  isDraftTitle,
  safeLocalName,
  stripAnsi,
  stripDraftPrefix,
  tail,
  type RawDiff,
} from "./util.js";

// ---------------------------------------------------------------------------
// Formes REST (sous-ensemble utile)
// ---------------------------------------------------------------------------

interface RawUser {
  id: number;
  username: string;
  name: string;
}

interface RawIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: string;
  web_url: string;
  labels: string[];
  description: string | null;
  issue_type?: string | null;
  type?: string | null;
  author?: { username: string } | null;
  created_at: string;
}

interface RawNote {
  id: number;
  body: string;
  system: boolean;
  author?: { username: string } | null;
  created_at: string;
}

interface RawLabelEvent {
  id: number;
  action: "add" | "remove";
  created_at: string;
  label: { id: number; name: string } | null;
}

interface RawMr {
  iid: number;
  web_url: string;
  title: string;
  state: string;
  merged_at?: string | null;
  sha?: string | null;
}

interface RawPipeline {
  id: number;
  status: string;
  sha: string;
  ref: string;
  web_url: string;
  created_at?: string;
}

interface RawJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
  allow_failure: boolean;
}

/** Job « trigger » (pipeline enfant ou multi-projets). */
interface RawBridge extends RawJob {
  downstream_pipeline?: { id: number; project_id: number; status?: string } | null;
}

interface RawCommit {
  id: string;
  parent_ids?: string[];
}

/**
 * Job renvoyé par cette implémentation : compatible structurellement avec `Job` (contracts.ts), avec en plus
 * le projet qui porte le job. Il diffère du projet du ticket pour les jobs d'un pipeline aval
 * (enfant/multi-projets) : relance et lecture du log doivent alors viser `projectId`.
 */
export type ProjectJob = Job & { projectId?: number };

/** Résultat détaillé d'un téléchargement d'images. */
export interface DownloadImagesResult {
  saved: string[];
  failed: { url: string; status?: number }[];
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

function toSummary(r: RawIssue): IssueSummary {
  return {
    projectId: r.project_id,
    iid: r.iid,
    title: r.title,
    state: r.state === "closed" ? "closed" : "opened",
    webUrl: r.web_url,
    labels: r.labels ?? [],
  };
}

function toIssue(r: RawIssue): Issue {
  return {
    ...toSummary(r),
    description: r.description ?? "",
    issueType: (r.issue_type ?? r.type ?? "issue").toLowerCase(),
    authorUsername: r.author?.username ?? "",
    createdAt: r.created_at,
  };
}

function toPipeline(r: RawPipeline): Pipeline {
  return { id: r.id, status: r.status as PipelineStatus, sha: r.sha, ref: r.ref, webUrl: r.web_url };
}

function toJob(r: RawJob, projectId: number, namePrefix = ""): ProjectJob {
  return {
    id: r.id,
    name: `${namePrefix}${r.name}`,
    stage: r.stage,
    status: r.status,
    webUrl: r.web_url,
    allowFailure: Boolean(r.allow_failure),
    projectId,
  };
}

/** Statuts de fin. `manual` et `skipped` = fin sans échec (traités comme succès). */
const FINAL_STATUSES = new Set(["success", "failed", "canceled", "skipped", "manual"]);

export function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

const ROLES: StatusRole[] = ["inProgress", "inReview", "blocked"];

export const DEFAULT_POLL_MS = 20_000;
export const DEFAULT_APPEAR_TIMEOUT_MS = 3 * 60_000;
export const DEFAULT_JOB_LOG_CHARS = 20_000;
export const DEFAULT_DIFF_CHARS = 60_000;
/** Nombre max de pipelines "merged results" examinés à chaque relevé (les plus récents). */
const MERGED_RESULTS_CANDIDATES = 5;
/** Profondeur max de descente dans les pipelines aval (enfants / multi-projets). */
const MAX_DOWNSTREAM_DEPTH = 2;

// ---------------------------------------------------------------------------

/**
 * Client GitLab. Par défaut, le jeton est celui de la connexion glab pour l'hôte configuré (ADR, amendement 2) :
 * aucun jeton n'est stocké par SprintSaver.
 */
export function createGitLabApi(
  config: Config,
  deps: HttpDeps = {},
  token: string | TokenProvider = glabToken(hostOf(config.gitlab.url)),
): GitLabApiImpl {
  return new GitLabApiImpl(new GitLabRest(config.gitlab.url, token, deps));
}

export class GitLabApiImpl implements GitLabApi {
  constructor(readonly rest: GitLabRest) {}

  private issuePath(projectId: number, iid: number): string {
    return `/projects/${pid(projectId)}/issues/${iid}`;
  }

  async currentUser(): Promise<GitLabUser> {
    const u = await this.rest.get<RawUser>("/user");
    return { id: u.id, username: u.username, name: u.name };
  }

  async listQueuedIssues(projects: ProjectConfig[], label: string): Promise<QueuedIssue[]> {
    const queued: (QueuedIssue & { projectId: number })[] = [];
    for (const project of projects) {
      let issues: RawIssue[];
      try {
        issues = await this.rest.paginate<RawIssue>(`/projects/${pid(project.id)}/issues`, {
          state: "opened",
          labels: label,
          order_by: "created_at",
          sort: "asc",
        });
      } catch (err) {
        log.warn({ project: project.name, err: errMsg(err) }, "Impossible de lister les tickets du projet");
        continue;
      }
      for (const issue of issues) {
        let labeledAt = issue.created_at;
        try {
          const events = await this.rest.paginate<RawLabelEvent>(
            `${this.issuePath(project.id, issue.iid)}/resource_label_events`,
          );
          const adds = events.filter((e) => e.action === "add" && e.label?.name === label);
          const last = adds.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id).at(-1);
          if (last) labeledAt = last.created_at;
        } catch (err) {
          log.warn({ project: project.name, iid: issue.iid, err: errMsg(err) }, "Date d'étiquetage inconnue");
        }
        queued.push({ project, projectId: project.id, iid: issue.iid, title: issue.title, labeledAt });
      }
    }
    queued.sort(
      (a, b) =>
        Date.parse(a.labeledAt) - Date.parse(b.labeledAt) || a.projectId - b.projectId || a.iid - b.iid,
    );
    return queued.map(({ project, iid, title, labeledAt }) => ({ project, iid, title, labeledAt }));
  }

  async getIssue(projectId: number, iid: number): Promise<Issue> {
    return toIssue(await this.rest.get<RawIssue>(this.issuePath(projectId, iid)));
  }

  async getIssueNotes(projectId: number, iid: number): Promise<Note[]> {
    const notes = await this.rest.paginate<RawNote>(`${this.issuePath(projectId, iid)}/notes`, {
      sort: "asc",
      order_by: "created_at",
    });
    return notes
      .filter((n) => !n.system)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
      .map((n) => ({ id: n.id, authorUsername: n.author?.username ?? "", body: n.body, createdAt: n.created_at }));
  }

  async getLinkedIssues(projectId: number, iid: number): Promise<Issue[]> {
    const links = await this.rest.get<RawIssue[]>(`${this.issuePath(projectId, iid)}/links`);
    return links.map(toIssue);
  }

  async downloadImages(project: ProjectConfig, texts: string[], destDir: string): Promise<string[]> {
    return (await this.downloadImagesDetailed(project, texts, destDir)).saved;
  }

  /** Comme `downloadImages`, mais renvoie aussi les échecs (ex. 403 : l'API uploads peut exiger un rôle élevé). */
  downloadImagesDetailed(project: ProjectConfig, texts: string[], destDir: string): Promise<DownloadImagesResult> {
    return downloadImagesDetailed(this.rest, project, texts, destDir);
  }

  async addLabel(projectId: number, iid: number, label: string): Promise<void> {
    await this.rest.put(this.issuePath(projectId, iid), { add_labels: label });
  }

  async removeLabel(projectId: number, iid: number, label: string): Promise<void> {
    await this.rest.put(this.issuePath(projectId, iid), { remove_labels: label });
  }

  async updateIssueDescription(projectId: number, iid: number, description: string): Promise<void> {
    await this.rest.put(this.issuePath(projectId, iid), { description });
  }

  async comment(projectId: number, iid: number, body: string): Promise<void> {
    await this.rest.post(`${this.issuePath(projectId, iid)}/notes`, { body });
  }

  /**
   * Passe le ticket au rôle donné. Cible native : statut du work item. Cible label : ajout du label. Dans les deux
   * cas, les labels des AUTRES rôles sont retirés (un ticket n'affiche qu'un statut SprintSaver à la fois).
   */
  async setStatus(project: ProjectConfig, iid: number, role: StatusRole): Promise<void> {
    const mapping = project.status;
    const target = mapping[role];
    const remove = [
      ...new Set(
        ROLES.filter((r) => r !== role)
          .map((r) => mapping[r])
          .flatMap((t) => (t.kind === "label" ? [t.name] : []))
          .filter((name) => !(target.kind === "label" && name === target.name)),
      ),
    ];
    if (target.kind === "native") {
      await setWorkItemStatus(this.rest, project.path, iid, target.id);
      if (remove.length) await this.rest.put(this.issuePath(project.id, iid), { remove_labels: remove.join(",") });
      return;
    }
    await this.rest.put(this.issuePath(project.id, iid), {
      add_labels: target.name,
      ...(remove.length ? { remove_labels: remove.join(",") } : {}),
    });
  }

  async findOpenMrForBranch(projectId: number, sourceBranch: string): Promise<MrRef | null> {
    const mrs = await this.rest.get<RawMr[]>(`/projects/${pid(projectId)}/merge_requests`, {
      source_branch: sourceBranch,
      state: "opened",
    });
    const mr = mrs[0];
    return mr ? { iid: mr.iid, webUrl: mr.web_url } : null;
  }

  async createDraftMr(input: {
    projectId: number;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<MrRef> {
    const title = isDraftTitle(input.title) ? input.title : `Draft: ${input.title}`;
    try {
      const mr = await this.rest.post<RawMr>(`/projects/${pid(input.projectId)}/merge_requests`, {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title,
        description: input.description,
        remove_source_branch: true,
      });
      return { iid: mr.iid, webUrl: mr.web_url };
    } catch (err) {
      // 409 (MR déjà ouverte) ou réponse perdue alors que la MR a pu être créée : on revérifie.
      const existing = await this.findOpenMrForBranch(input.projectId, input.sourceBranch).catch(() => null);
      if (existing) {
        log.warn(
          { projectId: input.projectId, branch: input.sourceBranch, mr: existing.iid, err: errMsg(err) },
          "Création de MR en erreur, mais une MR ouverte existe pour la branche : elle est réutilisée",
        );
        return existing;
      }
      throw err;
    }
  }

  async updateMr(
    projectId: number,
    mrIid: number,
    patch: { title?: string; description?: string; assigneeIds?: number[] },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.assigneeIds !== undefined) body.assignee_ids = patch.assigneeIds;
    if (Object.keys(body).length === 0) return;
    await this.rest.put(`/projects/${pid(projectId)}/merge_requests/${mrIid}`, body);
  }

  async markMrReady(projectId: number, mrIid: number): Promise<void> {
    const path = `/projects/${pid(projectId)}/merge_requests/${mrIid}`;
    const mr = await this.rest.get<RawMr>(path);
    const title = stripDraftPrefix(mr.title);
    if (title === mr.title) return;
    await this.rest.put(path, { title });
  }

  async uploadFile(projectId: number, filePath: string): Promise<{ markdown: string; url: string }> {
    const form = new FormData();
    const bytes = await readFile(filePath);
    form.append("file", new Blob([bytes], { type: mimeOf(filePath) }), basename(filePath));
    const res = await this.rest.request<{ markdown?: string; url?: string; alt?: string }>("POST", `/projects/${pid(projectId)}/uploads`, {
      form,
    });
    if (!res?.url) throw new Error(`GitLab POST /projects/${projectId}/uploads : réponse sans url`);
    return { url: res.url, markdown: res.markdown ?? `![${res.alt ?? basename(filePath)}](${res.url})` };
  }

  // --- Pipelines -----------------------------------------------------------

  /**
   * Pipeline correspondant à `sha`. En mode MR : pipeline dont le sha est exactement `sha`, sinon pipeline
   * "merged results" / merge train (sha = commit de merge) dont le commit a `sha` pour parent. Aucune fenêtre
   * temporelle : un pipeline de l'ancien head n'a jamais le nouveau sha pour parent.
   */
  private async findPipeline(
    project: ProjectConfig,
    sha: string,
    branch: string,
    mrIid: number | undefined,
    parents: Map<string, string[]>,
  ): Promise<RawPipeline | undefined> {
    if (project.ciSource === "merge_request" && mrIid !== undefined) {
      const list = await this.rest.get<RawPipeline[]>(
        `/projects/${pid(project.id)}/merge_requests/${mrIid}/pipelines`,
        { per_page: 50 },
      );
      const exact = list.find((p) => p.sha === sha);
      if (exact) return exact;
      const candidates = list
        .filter((p) => /\/(merge|train)$/.test(p.ref))
        .sort((a, b) => b.id - a.id)
        .slice(0, MERGED_RESULTS_CANDIDATES);
      for (const c of candidates) {
        if ((await this.commitParents(project.id, c.sha, parents)).includes(sha)) return c;
      }
      return undefined;
    }
    return this.findBranchPipeline(project.id, branch, sha);
  }

  private async findBranchPipeline(projectId: number, branch: string, sha: string): Promise<RawPipeline | undefined> {
    const list = await this.rest.get<RawPipeline[]>(`/projects/${pid(projectId)}/pipelines`, {
      ref: branch,
      sha,
      order_by: "id",
      sort: "desc",
    });
    return list[0];
  }

  /** Parents d'un commit (mis en cache : un commit est immuable). [] si illisible. */
  private async commitParents(projectId: number, sha: string, cache: Map<string, string[]>): Promise<string[]> {
    const cached = cache.get(sha);
    if (cached) return cached;
    try {
      const commit = await this.rest.get<RawCommit>(`/projects/${pid(projectId)}/repository/commits/${encodeURIComponent(sha)}`);
      const parents = commit.parent_ids ?? [];
      cache.set(sha, parents);
      return parents;
    } catch (err) {
      log.debug({ projectId, sha, err: errMsg(err) }, "Parents du commit de merge illisibles");
      return [];
    }
  }

  /**
   * Jobs en échec (hors allow_failure) d'un pipeline, y compris ceux des pipelines aval déclenchés par des
   * bridges en échec (enfants / multi-projets), jusqu'à MAX_DOWNSTREAM_DEPTH niveaux. Un bridge en échec
   * sans job aval exploitable est renvoyé lui-même.
   */
  private async failedJobsOf(projectId: number, pipelineId: number, depth = 0, namePrefix = ""): Promise<ProjectJob[]> {
    const raw = await this.rest.paginate<RawJob>(`/projects/${pid(projectId)}/pipelines/${pipelineId}/jobs`, {
      "scope[]": ["failed"],
    });
    const jobs = raw.filter((j) => !j.allow_failure).map((j) => toJob(j, projectId, namePrefix));
    let bridges: RawBridge[] = [];
    try {
      bridges = await this.rest.paginate<RawBridge>(`/projects/${pid(projectId)}/pipelines/${pipelineId}/bridges`, {
        "scope[]": ["failed"],
      });
    } catch (err) {
      log.warn({ projectId, pipelineId, err: errMsg(err) }, "Bridges du pipeline illisibles");
    }
    for (const bridge of bridges.filter((b) => !b.allow_failure)) {
      const ds = bridge.downstream_pipeline;
      let downstream: ProjectJob[] = [];
      if (ds && depth < MAX_DOWNSTREAM_DEPTH) {
        try {
          downstream = await this.failedJobsOf(ds.project_id, ds.id, depth + 1, `${namePrefix}${bridge.name} › `);
        } catch (err) {
          log.warn({ projectId: ds.project_id, pipelineId: ds.id, err: errMsg(err) }, "Jobs du pipeline aval illisibles");
        }
      }
      if (downstream.length > 0) jobs.push(...downstream);
      else jobs.push(toJob(bridge, projectId, namePrefix));
    }
    return jobs;
  }

  private async outcomeFor(projectId: number, p: RawPipeline): Promise<PipelineOutcome> {
    const pipeline = toPipeline(p);
    switch (p.status) {
      case "failed":
        return { kind: "failed", pipeline, failedJobs: await this.failedJobsOf(projectId, p.id) };
      case "canceled":
        return { kind: "canceled", pipeline };
      default:
        return { kind: "success", pipeline };
    }
  }

  /** Pipeline en attente dont aucun job ne peut être pris par un runner (GraphQL `CiJob.stuck`). */
  private async waitsForRunner(project: ProjectConfig, p: RawPipeline): Promise<boolean> {
    return p.status === "pending" && (await pipelineWaitsForRunner(this.rest, project.path, p.id));
  }

  /** Poll un pipeline connu jusqu'à statut final, attente sans runner ou deadline. */
  private async pollPipeline(
    project: ProjectConfig,
    initial: RawPipeline,
    deadline: number,
    pollMs: number,
  ): Promise<PipelineOutcome> {
    let current = initial;
    for (;;) {
      if (isFinalStatus(current.status)) return this.outcomeFor(project.id, current);
      if (await this.waitsForRunner(project, current)) return { kind: "no-runner", pipeline: toPipeline(current) };
      if (this.rest.now() >= deadline) return { kind: "timeout", pipeline: toPipeline(current) };
      await this.rest.sleep(pollMs);
      current = await this.rest.get<RawPipeline>(`/projects/${pid(project.id)}/pipelines/${current.id}`);
    }
  }

  async waitForPipeline(input: {
    project: ProjectConfig;
    sha: string;
    branch: string;
    mrIid?: number;
    timeoutMs: number;
    pollMs?: number;
    appearTimeoutMs?: number;
  }): Promise<PipelineOutcome> {
    const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
    const start = this.rest.now();
    const deadline = start + input.timeoutMs;
    const appearDeadline = start + (input.appearTimeoutMs ?? DEFAULT_APPEAR_TIMEOUT_MS);
    const mrMode = input.project.ciSource === "merge_request" && input.mrIid !== undefined;
    const parents = new Map<string, string[]>();
    for (;;) {
      const found = await this.findPipeline(input.project, input.sha, input.branch, input.mrIid, parents);
      if (found) return this.pollPipeline(input.project, found, deadline, pollMs);
      const now = this.rest.now();
      if (now >= deadline) return { kind: "timeout" };
      if (now >= appearDeadline) {
        if (mrMode) {
          // La CI ne déclenche peut-être pas de pipeline de MR (règles mal détectées) : pipeline de branche ?
          const branchPipeline = await this.findBranchPipeline(input.project.id, input.branch, input.sha);
          if (branchPipeline) {
            log.info(
              { project: input.project.name, sha: input.sha, pipeline: branchPipeline.id },
              "Aucun pipeline de MR : pipeline de branche suivi à la place",
            );
            return this.pollPipeline(input.project, branchPipeline, deadline, pollMs);
          }
        }
        return { kind: "none" };
      }
      await this.rest.sleep(pollMs);
    }
  }

  /**
   * Relance les jobs (dans leur projet : `job.projectId ?? project.id`) puis attend. On ne conclut jamais sur
   * le statut final d'avant la relance : on suit les nouveaux jobs renvoyés par `retry` jusqu'à leur fin.
   * Un nouveau job en échec → `failed` avec ces nouveaux jobs ; tous verts → on attend la fin du pipeline,
   * en ignorant un statut `failed` qui ne correspond plus à aucun job en échec (statut pas encore recalculé).
   */
  async retryJobsAndWait(input: {
    project: ProjectConfig;
    pipeline: Pipeline;
    jobs: Job[];
    timeoutMs: number;
    pollMs?: number;
  }): Promise<PipelineOutcome> {
    const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
    const projectId = input.project.id;
    const deadline = this.rest.now() + input.timeoutMs;
    const pipelinePath = `/projects/${pid(projectId)}/pipelines/${input.pipeline.id}`;

    const tracked: { projectId: number; id: number; prefix: string }[] = [];
    let retried = 0;
    for (const job of input.jobs as ProjectJob[]) {
      const jobProject = job.projectId ?? projectId;
      try {
        const fresh = await this.rest.post<RawJob | undefined>(`/projects/${pid(jobProject)}/jobs/${job.id}/retry`);
        retried++;
        if (fresh && typeof fresh.id === "number") {
          const prefix = fresh.name && job.name.endsWith(fresh.name) ? job.name.slice(0, job.name.length - fresh.name.length) : "";
          tracked.push({ projectId: jobProject, id: fresh.id, prefix });
        }
      } catch (err) {
        log.warn({ projectId: jobProject, job: job.id, name: job.name, err: errMsg(err) }, "Relance du job impossible");
      }
    }
    if (retried === 0) {
      // Rien n'a été relancé : l'état actuel est le bon.
      const current = await this.rest.get<RawPipeline>(pipelinePath);
      return this.pollPipeline(input.project, current, deadline, pollMs);
    }

    let sawActive = false;
    let first = true;
    for (;;) {
      // Laisse au pipeline le temps de repasser en running avant le premier relevé.
      await this.rest.sleep(first ? Math.min(pollMs, 5_000) : pollMs);
      first = false;
      const fresh: { raw: RawJob; projectId: number; prefix: string }[] = [];
      for (const t of tracked) {
        const raw = await this.rest.get<RawJob>(`/projects/${pid(t.projectId)}/jobs/${t.id}`);
        fresh.push({ raw, projectId: t.projectId, prefix: t.prefix });
      }
      const current = await this.rest.get<RawPipeline>(pipelinePath);
      if (!isFinalStatus(current.status)) sawActive = true;
      const jobsDone = fresh.every((j) => isFinalStatus(j.raw.status));
      // Sans id de nouveau job (réponse inattendue), il faut au moins avoir vu le pipeline repartir.
      if (jobsDone && (tracked.length > 0 || sawActive)) {
        const failedNew = fresh.filter((j) => j.raw.status === "failed" && !j.raw.allow_failure);
        if (failedNew.length > 0) {
          return {
            kind: "failed",
            pipeline: { ...toPipeline(current), status: "failed" },
            failedJobs: failedNew.map((j) => toJob(j.raw, j.projectId, j.prefix)),
          };
        }
        if (isFinalStatus(current.status)) {
          const outcome = await this.outcomeFor(projectId, current);
          if (outcome.kind !== "failed" || outcome.failedJobs.length > 0) return outcome;
        }
      }
      // Runner disparu depuis le premier passage : les jobs relancés ne partiront jamais.
      if (await this.waitsForRunner(input.project, current)) return { kind: "no-runner", pipeline: toPipeline(current) };
      if (this.rest.now() >= deadline) return { kind: "timeout", pipeline: toPipeline(current) };
    }
  }

  async latestFinishedPipeline(projectId: number, ref: string): Promise<Pipeline | null> {
    const list = await this.rest.get<RawPipeline[]>(`/projects/${pid(projectId)}/pipelines`, {
      ref,
      order_by: "id",
      sort: "desc",
      per_page: 50,
    });
    const p = list.find((x) => x.status === "success" || x.status === "failed" || x.status === "canceled");
    return p ? toPipeline(p) : null;
  }

  /** `projectId` : celui du job (`job.projectId ?? project.id` pour un job de pipeline aval). */
  async jobLog(projectId: number, jobId: number, maxChars = DEFAULT_JOB_LOG_CHARS): Promise<string> {
    const trace = await this.rest.text(`/projects/${pid(projectId)}/jobs/${jobId}/trace`);
    return tail(stripAnsi(trace), maxChars);
  }

  // --- Lecture seule (MCP) ---------------------------------------------------

  async searchIssues(
    projectId: number,
    query: string,
    state: "opened" | "closed" | "all",
    limit = 5,
  ): Promise<IssueSummary[]> {
    const issues = await this.rest.get<RawIssue[]>(`/projects/${pid(projectId)}/issues`, {
      search: query,
      state: state === "all" ? undefined : state,
      per_page: limit,
    });
    return issues.slice(0, limit).map(toSummary);
  }

  async closingMrs(projectId: number, iid: number): Promise<MrSummary[]> {
    const mrs = await this.rest.get<RawMr[]>(`${this.issuePath(projectId, iid)}/closed_by`);
    return mrs.map((m) => ({ iid: m.iid, webUrl: m.web_url, title: m.title, state: m.state, mergedAt: m.merged_at ?? null }));
  }

  async mrDiff(projectId: number, mrIid: number, maxChars = DEFAULT_DIFF_CHARS): Promise<string> {
    const diffs = await this.rest.paginate<RawDiff>(`/projects/${pid(projectId)}/merge_requests/${mrIid}/diffs`);
    return head(formatUnifiedDiff(diffs), maxChars);
  }
}

/**
 * Télécharge les images uploadées référencées dans `texts`. Chaque échec est journalisé (warn, avec le statut
 * HTTP) et renvoyé dans `failed` : l'API uploads peut répondre 403 selon le rôle du compte.
 */
export async function downloadImagesDetailed(
  rest: GitLabRest,
  project: ProjectConfig,
  texts: string[],
  destDir: string,
): Promise<DownloadImagesResult> {
  const refs = extractImageUploads(texts);
  const result: DownloadImagesResult = { saved: [], failed: [] };
  if (refs.length === 0) return result;
  await mkdir(destDir, { recursive: true });
  for (const ref of refs) {
    const path = `/projects/${pid(project.id)}/uploads/${ref.secret}/${ref.filename}`;
    const url = `/uploads/${ref.secret}/${ref.filename}`;
    try {
      const data = await rest.bytes(path);
      const file = join(destDir, safeLocalName(ref));
      await writeFile(file, data);
      result.saved.push(file);
    } catch (err) {
      const status = err instanceof GitLabHttpError && err.status > 0 ? err.status : undefined;
      log.warn(
        { project: project.name, upload: url, status, err: errMsg(err) },
        status === 403 || status === 401
          ? "Image non téléchargée : accès refusé par l'API uploads (rôle insuffisant ?)"
          : "Image non téléchargée",
      );
      result.failed.push(status === undefined ? { url } : { url, status });
    }
  }
  return result;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mimeOf(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
