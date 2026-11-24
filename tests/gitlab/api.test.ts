import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, ProjectConfigSchema, type ProjectConfig } from "../../src/config/schema.js";
import { createGitLabApi, type GitLabApiImpl, type ProjectJob } from "../../src/gitlab/api.js";
import { fakeFetch, type FakeRoute } from "../helpers/fake-fetch.js";
import { PIPELINE_PENDING_JOBS_QUERY, SET_STATUS_MUTATION, WORK_ITEM_ID_QUERY } from "../../src/gitlab/graphql.js";

const TOKEN = "glpat-SECRET";

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return ProjectConfigSchema.parse({
    name: "app",
    id: 42,
    path: "grp/app",
    httpUrl: "https://gitlab.example.com/grp/app.git",
    status: { mode: "labels", inProgress: "st::doing", inReview: "st::review", blocked: "st::blocked" },
    ...over,
  });
}

function setup(routes: FakeRoute[], clock?: { t: number }) {
  const ff = fakeFetch(routes);
  const sleeps: number[] = [];
  const config = ConfigSchema.parse({
    gitlab: { url: "https://gitlab.example.com/", username: "me", userId: 1 },
  });
  const api = createGitLabApi(config, {
    fetch: ff.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (clock) clock.t += ms;
    },
    now: clock ? () => clock.t : undefined,
    retryDelayMs: 1,
  }, TOKEN);
  return { api, calls: ff.calls, sleeps };
}

const rawIssue = (iid: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + iid,
  iid,
  project_id: 42,
  title: `T${iid}`,
  state: "opened",
  web_url: `https://gitlab.example.com/grp/app/-/issues/${iid}`,
  labels: ["auto::ready"],
  description: null,
  issue_type: "issue",
  author: { username: "alice" },
  created_at: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("client REST", () => {
  it("envoie le token en header, retente sur 5xx et n'expose pas le token dans les erreurs", async () => {
    let n = 0;
    const { api, calls } = setup([
      { path: "/user", respond: () => (++n < 3 ? { status: 502, text: "bad" } : { json: { id: 1, username: "me", name: "Me" } }) },
    ]);
    expect(await api.currentUser()).toEqual({ id: 1, username: "me", name: "Me" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBe(TOKEN);

    const failing = setup([{ path: "/projects/42/issues/1", respond: { status: 500, text: `oops ${TOKEN}` } }]);
    const err = await failing.api.getIssue(42, 1).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GET /projects/42/issues/1");
    expect((err as Error).message).toContain("HTTP 500");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(failing.calls).toHaveLength(3);
  });

  it("ne rejoue pas un POST sur 500", async () => {
    const { api, calls } = setup([{ method: "POST", path: "/projects/42/issues/1/notes", respond: { status: 500 } }]);
    await expect(api.comment(42, 1, "hi")).rejects.toThrow(/POST .*HTTP 500/);
    expect(calls).toHaveLength(1);
  });
});

describe("tickets", () => {
  it("listQueuedIssues trie FIFO sur la date du dernier ajout du label, tous projets confondus", async () => {
    const p1 = project();
    const p2 = project({ name: "lib", id: 7, path: "grp/lib" });
    const { api } = setup([
      { path: "/projects/42/issues", respond: { json: [rawIssue(1), rawIssue(2)] } },
      { path: "/projects/7/issues", respond: { json: [{ ...rawIssue(5), project_id: 7 }] } },
      {
        path: "/projects/42/issues/1/resource_label_events",
        respond: {
          json: [
            { id: 1, action: "add", created_at: "2026-01-02T00:00:00Z", label: { id: 9, name: "auto::ready" } },
            { id: 2, action: "remove", created_at: "2026-01-03T00:00:00Z", label: { id: 9, name: "auto::ready" } },
            { id: 3, action: "add", created_at: "2026-01-10T00:00:00Z", label: { id: 9, name: "auto::ready" } },
            { id: 4, action: "add", created_at: "2026-01-20T00:00:00Z", label: { id: 8, name: "other" } },
          ],
        },
      },
      {
        path: "/projects/42/issues/2/resource_label_events",
        respond: { json: [{ id: 5, action: "add", created_at: "2026-01-05T00:00:00Z", label: { id: 9, name: "auto::ready" } }] },
      },
      {
        path: "/projects/7/issues/5/resource_label_events",
        respond: { json: [{ id: 6, action: "add", created_at: "2026-01-07T00:00:00Z", label: { id: 9, name: "auto::ready" } }] },
      },
    ]);
    const q = await api.listQueuedIssues([p1, p2], "auto::ready");
    expect(q.map((x) => `${x.project.name}#${x.iid}@${x.labeledAt.slice(0, 10)}`)).toEqual([
      "app#2@2026-01-05",
      "lib#5@2026-01-07",
      "app#1@2026-01-10",
    ]);
  });

  it("getIssueNotes exclut les notes système, pagine et trie chronologiquement", async () => {
    const { api, calls } = setup([
      {
        path: "/projects/42/issues/3/notes",
        respond: (req) =>
          req.query.get("page") === "1"
            ? {
                json: [
                  { id: 3, body: "b", system: false, author: { username: "bob" }, created_at: "2026-01-03T00:00:00Z" },
                  { id: 2, body: "changed label", system: true, author: { username: "bob" }, created_at: "2026-01-02T00:00:00Z" },
                ],
                headers: { "x-next-page": "2" },
              }
            : { json: [{ id: 1, body: "a", system: false, author: { username: "al" }, created_at: "2026-01-01T00:00:00Z" }], headers: { "x-next-page": "" } },
      },
    ]);
    const notes = await api.getIssueNotes(42, 3);
    expect(notes.map((n) => n.body)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
  });

  it("getIssue et getLinkedIssues mappent les champs", async () => {
    const { api } = setup([
      { path: "/projects/42/issues/1", respond: { json: rawIssue(1, { description: "desc", issue_type: "INCIDENT" }) } },
      { path: "/projects/42/issues/1/links", respond: { json: [{ ...rawIssue(9), project_id: 99, link_type: "relates_to" }] } },
    ]);
    const issue = await api.getIssue(42, 1);
    expect(issue).toMatchObject({ projectId: 42, iid: 1, description: "desc", issueType: "incident", authorUsername: "alice", state: "opened" });
    const linked = await api.getLinkedIssues(42, 1);
    expect(linked[0]).toMatchObject({ projectId: 99, iid: 9, description: "" });
  });

  it("downloadImages télécharge les images, ignore les échecs et les non-images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-img-"));
    try {
      const s1 = "a".repeat(32);
      const s2 = "b".repeat(32);
      const { api } = setup([
        { path: `/projects/42/uploads/${s1}/shot.png`, respond: { bytes: new Uint8Array([1, 2, 3]) } },
        { path: `/projects/42/uploads/${s2}/missing.jpg`, respond: { status: 404 } },
      ]);
      const files = await api.downloadImages(
        project(),
        [
          `voir ![x](/uploads/${s1}/shot.png) et ![y](/uploads/${s1}/shot.png)`,
          `![z](https://gitlab.example.com/-/project/42/uploads/${s2}/missing.jpg) [log](/uploads/${s1}/log.txt)`,
        ],
        dir,
      );
      expect(files).toHaveLength(1);
      expect([...(await readFile(files[0]!))]).toEqual([1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("écritures", () => {
  it("setStatus labels ajoute le rôle et retire les deux autres", async () => {
    const { api, calls } = setup([{ method: "PUT", path: "/projects/42/issues/4", respond: { json: {} } }]);
    await api.setStatus(project(), 4, "inReview");
    expect(calls[0]!.body).toEqual({ add_labels: "st::review", remove_labels: "st::doing,st::blocked" });
  });

  it("setStatus native : récupère le gid puis mute le statut ; lève si errors", async () => {
    const native = project({
      status: {
        inProgress: { kind: "native", id: "gid://gitlab/WorkItems::Statuses::SystemDefined::Status/2", name: "In progress" },
        inReview: { kind: "native", id: "gid://x/3", name: "Review" },
        blocked: { kind: "native", id: "gid://x/4", name: "Blocked" },
      },
    });
    let errors: string[] = [];
    const { api, calls } = setup([
      {
        method: "POST",
        path: "/api/graphql",
        respond: (req) => {
          const body = req.body as { query: string; variables: Record<string, unknown> };
          if (body.query === WORK_ITEM_ID_QUERY) return { json: { data: { project: { workItems: { nodes: [{ id: "gid://gitlab/WorkItem/77" }] } } } } };
          if (body.query === SET_STATUS_MUTATION) return { json: { data: { workItemUpdate: { errors, workItem: { id: "x" } } } } };
          return { status: 400 };
        },
      },
    ]);
    await api.setStatus(native, 12, "inProgress");
    expect(calls[0]!.body).toMatchObject({ variables: { fullPath: "grp/app", iid: "12" } });
    expect(calls[1]!.body).toMatchObject({
      variables: { id: "gid://gitlab/WorkItem/77", status: "gid://gitlab/WorkItems::Statuses::SystemDefined::Status/2" },
    });
    errors = ["Status is not allowed"];
    await expect(api.setStatus(native, 12, "blocked")).rejects.toThrow(/Status is not allowed/);
  });

  it("setStatus mixte : rôle natif → statut du work item puis retrait des labels des autres rôles ; rôle label → ajout", async () => {
    const mixed = project({
      status: {
        inProgress: { kind: "native", id: "gid://x/2", name: "In progress" },
        inReview: { kind: "label", name: "sprintsaver::en-review" },
        blocked: { kind: "label", name: "sprintsaver::bloque" },
      },
    });
    const { api, calls } = setup([
      { method: "PUT", path: "/projects/42/issues/12", respond: { json: {} } },
      {
        method: "POST",
        path: "/api/graphql",
        respond: (req) =>
          (req.body as { query: string }).query === WORK_ITEM_ID_QUERY
            ? { json: { data: { project: { workItems: { nodes: [{ id: "gid://gitlab/WorkItem/77" }] } } } } }
            : { json: { data: { workItemUpdate: { errors: [] } } } },
      },
    ]);
    await api.setStatus(mixed, 12, "inProgress");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/graphql", "POST /api/graphql", "PUT /projects/42/issues/12"]);
    expect(calls[2]!.body).toEqual({ remove_labels: "sprintsaver::en-review,sprintsaver::bloque" });

    calls.length = 0;
    await api.setStatus(mixed, 12, "blocked");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ add_labels: "sprintsaver::bloque", remove_labels: "sprintsaver::en-review" });
  });

  it("createDraftMr préfixe Draft et demande la suppression de la branche source", async () => {
    const { api, calls } = setup([
      { method: "POST", path: "/projects/42/merge_requests", respond: { json: { iid: 3, web_url: "u" } } },
    ]);
    expect(await api.createDraftMr({ projectId: 42, sourceBranch: "b", targetBranch: "main", title: "fix: x", description: "d" })).toEqual({ iid: 3, webUrl: "u" });
    expect(calls[0]!.body).toEqual({ source_branch: "b", target_branch: "main", title: "Draft: fix: x", description: "d", remove_source_branch: true });
  });

  it("markMrReady retire le préfixe Draft ; updateMr envoie assignee_ids", async () => {
    const { api, calls } = setup([
      { path: "/projects/42/merge_requests/3", respond: { json: { iid: 3, web_url: "u", title: "[Draft] Draft: fix: x", state: "opened" } } },
      { method: "PUT", path: "/projects/42/merge_requests/3", respond: { json: {} } },
    ]);
    await api.markMrReady(42, 3);
    expect(calls[1]!.body).toEqual({ title: "fix: x" });
    await api.updateMr(42, 3, { assigneeIds: [1] });
    expect(calls[2]!.body).toEqual({ assignee_ids: [1] });
  });

  it("uploadFile : POST multipart sur les uploads du projet, renvoie le markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-upload-"));
    const file = join(dir, "1-apres.png");
    await writeFile(file, "png-bytes");
    const { api, calls } = setup([
      {
        method: "POST",
        path: "/projects/42/uploads",
        respond: { status: 201, json: { alt: "1-apres", url: "/uploads/abc/1-apres.png", markdown: "![1-apres](/uploads/abc/1-apres.png)" } },
      },
    ]);
    expect(await api.uploadFile(42, file)).toEqual({ url: "/uploads/abc/1-apres.png", markdown: "![1-apres](/uploads/abc/1-apres.png)" });
    const sent = calls[0]!.form!.get("file") as File;
    expect(sent.name).toBe("1-apres.png");
    expect(sent.type).toBe("image/png");
    expect(await sent.text()).toBe("png-bytes");
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("findOpenMrForBranch", async () => {
    const { api, calls } = setup([{ path: "/projects/42/merge_requests", respond: { json: [{ iid: 8, web_url: "w" }] } }]);
    expect(await api.findOpenMrForBranch(42, "sprintsaver/1-x")).toEqual({ iid: 8, webUrl: "w" });
    expect(calls[0]!.query.get("source_branch")).toBe("sprintsaver/1-x");
    expect(calls[0]!.query.get("state")).toBe("opened");
  });
});

describe("pipelines", () => {
  const pl = (id: number, status: string, sha = "abc", ref = "b") => ({ id, status, sha, ref, web_url: `p/${id}` });

  it("pipeline de MR : choisit le sha, poll jusqu'à failed et renvoie les jobs en échec hors allow_failure", async () => {
    const clock = { t: 0 };
    const statuses = ["running", "failed"];
    const { api, calls } = setup(
      [
        { path: "/projects/42/merge_requests/3/pipelines", respond: { json: [pl(11, "running", "other"), pl(10, "pending")] } },
        { path: "/projects/42/pipelines/10", respond: () => ({ json: pl(10, statuses.shift() ?? "failed") }) },
        {
          path: "/projects/42/pipelines/10/jobs",
          respond: {
            json: [
              { id: 1, name: "lint", stage: "test", status: "failed", web_url: "j1", allow_failure: true },
              { id: 2, name: "unit", stage: "test", status: "failed", web_url: "j2", allow_failure: false },
            ],
          },
        },
      ],
      clock,
    );
    const out = await api.waitForPipeline({ project: project(), sha: "abc", branch: "b", mrIid: 3, timeoutMs: 600_000, pollMs: 1000 });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error();
    expect(out.pipeline.id).toBe(10);
    expect(out.failedJobs.map((j) => j.name)).toEqual(["unit"]);
    expect(calls.find((c) => c.path.endsWith("/jobs"))!.query.getAll("scope[]")).toEqual(["failed"]);
  });

  it("pipeline de branche : manual est considéré comme succès", async () => {
    const { api, calls } = setup([{ path: "/projects/42/pipelines", respond: { json: [pl(5, "manual")] } }], { t: 0 });
    const out = await api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 1000 });
    expect(out.kind).toBe("success");
    expect(calls[0]!.query.get("ref")).toBe("b");
    expect(calls[0]!.query.get("sha")).toBe("abc");
  });

  it("aucun pipeline avant appearTimeoutMs → none ; pipeline bloqué → timeout", async () => {
    const clock = { t: 0 };
    const a = setup([{ path: "/projects/42/pipelines", respond: { json: [] } }], clock);
    const none = await a.api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 3_600_000 });
    expect(none).toEqual({ kind: "none" });
    expect(clock.t).toBeGreaterThanOrEqual(180_000);
    expect(a.sleeps.every((s) => s === 20_000)).toBe(true);

    const b = setup(
      [
        { path: "/projects/42/pipelines", respond: { json: [pl(5, "running")] } },
        { path: "/projects/42/pipelines/5", respond: { json: pl(5, "running") } },
      ],
      { t: 0 },
    );
    const to = await b.api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 60_000, pollMs: 10_000 });
    expect(to.kind).toBe("timeout");
    if (to.kind === "timeout") expect(to.pipeline?.id).toBe(5);
  });

  /** Route GraphQL des jobs en attente : `stuck` de chaque job, ou erreur HTTP. */
  const pendingJobs = (stuck: boolean[] | { status: number }): FakeRoute => ({
    method: "POST",
    path: "/api/graphql",
    respond: (req) => {
      expect((req.body as { query: string }).query).toBe(PIPELINE_PENDING_JOBS_QUERY);
      return Array.isArray(stuck)
        ? { json: { data: { project: { pipeline: { jobs: { nodes: stuck.map((s) => ({ stuck: s })) } } } } } }
        : stuck;
    },
  });

  it("pipeline en attente dont tous les jobs sont stuck → no-runner, sans attendre la fin", async () => {
    const clock = { t: 0 };
    const { api, calls } = setup(
      [{ path: "/projects/42/pipelines", respond: { json: [pl(5, "pending")] } }, pendingJobs([true, true])],
      clock,
    );
    const out = await api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 3_600_000 });
    expect(out).toEqual({ kind: "no-runner", pipeline: { id: 5, status: "pending", sha: "abc", ref: "b", webUrl: "p/5" } });
    expect(clock.t).toBe(0);
    const gql = calls.find((c) => c.path === "/api/graphql")!;
    expect((gql.body as { variables: unknown }).variables).toEqual({ fullPath: "grp/app", id: "gid://gitlab/Ci::Pipeline/5" });
  });

  it("pipeline en attente avec un job pris en charge possible (non stuck) : on continue d'attendre", async () => {
    const statuses = ["pending", "running", "success"];
    const { api } = setup(
      [
        { path: "/projects/42/pipelines", respond: { json: [pl(5, "pending")] } },
        { path: "/projects/42/pipelines/5", respond: () => ({ json: pl(5, statuses.shift() ?? "success") }) },
        pendingJobs([true, false]),
      ],
      { t: 0 },
    );
    const out = await api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 600_000, pollMs: 1000 });
    expect(out.kind).toBe("success");
  });

  it("jobs en attente illisibles (GraphQL en erreur) : on continue d'attendre jusqu'au timeout", async () => {
    const { api } = setup(
      [
        { path: "/projects/42/pipelines", respond: { json: [pl(5, "pending")] } },
        { path: "/projects/42/pipelines/5", respond: { json: pl(5, "pending") } },
        pendingJobs({ status: 403 }),
      ],
      { t: 0 },
    );
    const out = await api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 60_000, pollMs: 10_000 });
    expect(out.kind).toBe("timeout");
  });

  it("pipeline en cours (running) : jamais no-runner, même si des jobs sont stuck", async () => {
    const statuses = ["running", "success"];
    const { api, calls } = setup(
      [
        { path: "/projects/42/pipelines", respond: { json: [pl(5, "running")] } },
        { path: "/projects/42/pipelines/5", respond: () => ({ json: pl(5, statuses.shift() ?? "success") }) },
        pendingJobs([true]),
      ],
      { t: 0 },
    );
    const out = await api.waitForPipeline({ project: project({ ciSource: "branch" }), sha: "abc", branch: "b", timeoutMs: 600_000, pollMs: 1000 });
    expect(out.kind).toBe("success");
    expect(calls.some((c) => c.path === "/api/graphql")).toBe(false);
  });

  it("retryJobsAndWait : jobs relancés restés en attente faute de runner → no-runner", async () => {
    const { api } = setup(
      [
        { method: "POST", path: "/projects/42/jobs/2/retry", respond: { json: { id: 20, name: "unit", stage: "test", status: "pending", web_url: "j20", allow_failure: false } } },
        { path: "/projects/42/jobs/20", respond: { json: { id: 20, name: "unit", stage: "test", status: "pending", web_url: "j20", allow_failure: false } } },
        { path: "/projects/42/pipelines/10", respond: { json: pl(10, "pending") } },
        pendingJobs([true]),
      ],
      { t: 0 },
    );
    const out = await api.retryJobsAndWait({
      project: project(),
      pipeline: { id: 10, status: "failed", sha: "abc", ref: "b", webUrl: "" },
      jobs: [{ id: 2, name: "unit", stage: "test", status: "failed", webUrl: "", allowFailure: false }],
      timeoutMs: 600_000,
      pollMs: 1000,
    });
    expect(out.kind).toBe("no-runner");
  });

  it("retryJobsAndWait relance chaque job puis attend le même pipeline", async () => {
    const statuses = ["running", "success"];
    const { api, calls } = setup(
      [
        { method: "POST", path: /^\/projects\/42\/jobs\/\d+\/retry$/, respond: { json: {} } },
        { path: "/projects/42/pipelines/10", respond: () => ({ json: pl(10, statuses.shift() ?? "success") }) },
      ],
      { t: 0 },
    );
    const job = { id: 2, name: "unit", stage: "test", status: "failed", webUrl: "", allowFailure: false };
    const out = await api.retryJobsAndWait({
      project: project(),
      pipeline: { id: 10, status: "failed", sha: "abc", ref: "b", webUrl: "" },
      jobs: [job, { ...job, id: 3 }],
      timeoutMs: 600_000,
      pollMs: 1000,
    });
    expect(out.kind).toBe("success");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/projects/42/jobs/2/retry", "/projects/42/jobs/3/retry"]);
  });

  it("latestFinishedPipeline ignore les pipelines en cours", async () => {
    const { api } = setup([{ path: "/projects/42/pipelines", respond: { json: [pl(9, "running"), pl(8, "skipped"), pl(7, "failed")] } }]);
    expect((await api.latestFinishedPipeline(42, "main"))?.id).toBe(7);
  });

  it("jobLog retire l'ANSI et garde la fin", async () => {
    const trace = "section_start:1:step\r\x1b[0K\x1b[32mhello\x1b[0m\r\nworld";
    const { api } = setup([{ path: "/projects/42/jobs/5/trace", respond: { text: trace } }]);
    expect(await api.jobLog(42, 5)).toBe("hello\nworld");
    expect(await api.jobLog(42, 5, 5)).toMatch(/world$/);
  });
});

describe("lecture seule", () => {
  it("searchIssues, closingMrs, mrDiff", async () => {
    const { api, calls } = setup([
      { path: "/projects/42/issues", respond: { json: [rawIssue(1, { state: "closed" })] } },
      { path: "/projects/42/issues/1/closed_by", respond: { json: [{ iid: 4, web_url: "m", title: "fix", state: "merged", merged_at: "2026-01-01" }] } },
      {
        path: "/projects/42/merge_requests/4/diffs",
        respond: {
          json: [
            { old_path: "a.ts", new_path: "a.ts", a_mode: "100644", b_mode: "100644", new_file: false, renamed_file: false, deleted_file: false, diff: "@@ -1 +1 @@\n-a\n+b\n" },
            { old_path: "n.ts", new_path: "n.ts", a_mode: "0", b_mode: "100644", new_file: true, renamed_file: false, deleted_file: false, diff: "@@ -0,0 +1 @@\n+n\n" },
          ],
        },
      },
    ]);
    const found = await api.searchIssues(42, "crash login", "all");
    expect(found[0]).toMatchObject({ iid: 1, state: "closed" });
    expect(calls[0]!.query.get("search")).toBe("crash login");
    expect(calls[0]!.query.has("state")).toBe(false);
    expect(calls[0]!.query.get("per_page")).toBe("5");
    expect(await api.closingMrs(42, 1)).toEqual([{ iid: 4, webUrl: "m", title: "fix", state: "merged", mergedAt: "2026-01-01" }]);
    const diff = await api.mrDiff(42, 4);
    expect(diff).toContain("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@");
    expect(diff).toContain("new file mode 100644\n--- /dev/null\n+++ b/n.ts");
    expect(await api.mrDiff(42, 4, 10)).toMatch(/tronqué/);
  });
});


describe("correctifs relecture", () => {
  const pl = (id: number, status: string, sha = "abc", ref = "b", extra: Record<string, unknown> = {}) => ({
    id,
    status,
    sha,
    ref,
    web_url: `p/${id}`,
    ...extra,
  });
  const recent = { created_at: "1970-01-01T00:00:00Z" };

  it("merged results : un pipeline de l'ancien head n'est pas pris pour le nouveau sha ; celui dont le commit a sha pour parent l'est", async () => {
    const clock = { t: 0 };
    let listCalls = 0;
    const old = pl(20, "failed", "m-old", "refs/merge-requests/3/merge", recent);
    const fresh = pl(21, "success", "m-new", "refs/merge-requests/3/merge", recent);
    const { api, calls } = setup(
      [
        { path: "/projects/42/merge_requests/3/pipelines", respond: () => ({ json: ++listCalls >= 3 ? [fresh, old] : [old] }) },
        { path: "/projects/42/merge_requests/3", respond: { json: { iid: 3, web_url: "u", title: "t", state: "opened", sha: "abc" } } },
        { path: "/projects/42/repository/commits/m-old", respond: { json: { id: "m-old", parent_ids: ["main1", "old-head"] } } },
        { path: "/projects/42/repository/commits/m-new", respond: { json: { id: "m-new", parent_ids: ["main1", "abc"] } } },
      ],
      clock,
    );
    const out = await api.waitForPipeline({ project: project(), sha: "abc", branch: "b", mrIid: 3, timeoutMs: 600_000, pollMs: 1000 });
    expect(out.kind).toBe("success");
    if (out.kind === "success") expect(out.pipeline.id).toBe(21);
    // le commit de l'ancien pipeline n'est lu qu'une fois (cache)
    expect(calls.filter((c) => c.path.endsWith("/commits/m-old"))).toHaveLength(1);
  });

  it("mode MR : sans pipeline de MR avant appearTimeoutMs, suit le pipeline de branche du même sha, sinon none", async () => {
    const pending = ["running", "success"];
    const a = setup(
      [
        { path: "/projects/42/merge_requests/3/pipelines", respond: { json: [] } },
        { path: "/projects/42/pipelines", respond: { json: [pl(7, "running")] } },
        { path: "/projects/42/pipelines/7", respond: () => ({ json: pl(7, pending.shift() ?? "success") }) },
      ],
      { t: 0 },
    );
    const out = await a.api.waitForPipeline({ project: project(), sha: "abc", branch: "b", mrIid: 3, timeoutMs: 3_600_000, appearTimeoutMs: 60_000, pollMs: 10_000 });
    expect(out.kind).toBe("success");
    if (out.kind === "success") expect(out.pipeline.id).toBe(7);
    const branchCall = a.calls.find((c) => c.path === "/projects/42/pipelines")!;
    expect(branchCall.query.get("ref")).toBe("b");
    expect(branchCall.query.get("sha")).toBe("abc");

    const b = setup(
      [
        { path: "/projects/42/merge_requests/3/pipelines", respond: { json: [] } },
        { path: "/projects/42/pipelines", respond: { json: [] } },
      ],
      { t: 0 },
    );
    expect(await b.api.waitForPipeline({ project: project(), sha: "abc", branch: "b", mrIid: 3, timeoutMs: 3_600_000, appearTimeoutMs: 60_000 })).toEqual({ kind: "none" });
  });

  it("remonte les jobs en échec des pipelines aval (bridges), avec leur projet ; relance et log dans ce projet", async () => {
    const job = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, name, stage: "test", status: "failed", web_url: `j${id}`, allow_failure: false, ...extra });
    const { api, calls } = setup(
      [
        { path: "/projects/42/merge_requests/3/pipelines", respond: { json: [pl(10, "failed")] } },
        { path: "/projects/42/pipelines/10/jobs", respond: { json: [job(1, "unit")] } },
        {
          path: "/projects/42/pipelines/10/bridges",
          respond: {
            json: [
              job(50, "child", { downstream_pipeline: { id: 77, project_id: 42 } }),
              job(51, "deploy", { downstream_pipeline: { id: 88, project_id: 99 } }),
              job(52, "cfg", { downstream_pipeline: null }),
              job(53, "optional", { allow_failure: true, downstream_pipeline: { id: 66, project_id: 42 } }),
            ],
          },
        },
        { path: "/projects/42/pipelines/77/jobs", respond: { json: [job(2, "child-unit")] } },
        { path: "/projects/42/pipelines/77/bridges", respond: { json: [] } },
        { path: "/projects/99/pipelines/88/jobs", respond: { json: [job(3, "e2e"), job(4, "lint", { allow_failure: true })] } },
        { path: "/projects/99/pipelines/88/bridges", respond: { json: [] } },
        { method: "POST", path: "/projects/99/jobs/3/retry", respond: { json: job(30, "e2e", { status: "pending" }) } },
        { path: "/projects/99/jobs/30", respond: { json: job(30, "e2e", { status: "failed" }) } },
        { path: "/projects/42/pipelines/10", respond: { json: pl(10, "running") } },
        { path: "/projects/99/jobs/30/trace", respond: { text: "boom" } },
      ],
      { t: 0 },
    );
    const out = await api.waitForPipeline({ project: project(), sha: "abc", branch: "b", mrIid: 3, timeoutMs: 600_000 });
    if (out.kind !== "failed") throw new Error(out.kind);
    const jobs = out.failedJobs as ProjectJob[];
    expect(jobs.map((j) => [j.name, j.projectId])).toEqual([
      ["unit", 42],
      ["child › child-unit", 42],
      ["deploy › e2e", 99],
      ["cfg", 42],
    ]);
    expect(calls.find((c) => c.path.endsWith("/10/bridges"))!.query.getAll("scope[]")).toEqual(["failed"]);

    const retry = await api.retryJobsAndWait({ project: project(), pipeline: out.pipeline, jobs: [jobs[2]!], timeoutMs: 600_000, pollMs: 1000 });
    if (retry.kind !== "failed") throw new Error(retry.kind);
    expect(retry.failedJobs).toEqual([expect.objectContaining({ id: 30, name: "deploy › e2e", projectId: 99 })]);
    const retried = retry.failedJobs[0] as ProjectJob;
    expect(await api.jobLog(retried.projectId ?? 42, retried.id)).toBe("boom");
  });

  it("retryJobsAndWait ne conclut pas sur le statut final d'avant la relance", async () => {
    const pipelineStatuses = ["failed", "failed", "running", "success"];
    const jobStatuses = ["pending", "running", "success"];
    const { api } = setup(
      [
        { method: "POST", path: "/projects/42/jobs/2/retry", respond: { json: { id: 20, name: "unit", stage: "test", status: "pending", web_url: "j20", allow_failure: false } } },
        { path: "/projects/42/jobs/20", respond: () => ({ json: { id: 20, name: "unit", stage: "test", status: jobStatuses.shift() ?? "success", web_url: "j20", allow_failure: false } }) },
        { path: "/projects/42/pipelines/10", respond: () => ({ json: pl(10, pipelineStatuses.shift() ?? "success") }) },
      ],
      { t: 0 },
    );
    const job = { id: 2, name: "unit", stage: "test", status: "failed", webUrl: "", allowFailure: false };
    const out = await api.retryJobsAndWait({
      project: project(),
      pipeline: { id: 10, status: "failed", sha: "abc", ref: "b", webUrl: "" },
      jobs: [job],
      timeoutMs: 600_000,
      pollMs: 1000,
    });
    expect(out.kind).toBe("success");
  });

  it("retryJobsAndWait : pipeline encore « failed » sans job en échec = statut pas recalculé ; borne = timeoutMs", async () => {
    const clock = { t: 0 };
    const { api } = setup(
      [
        { method: "POST", path: "/projects/42/jobs/2/retry", respond: { json: { id: 20, name: "unit", stage: "test", status: "pending", web_url: "j20", allow_failure: false } } },
        { path: "/projects/42/jobs/20", respond: { json: { id: 20, name: "unit", stage: "test", status: "success", web_url: "j20", allow_failure: false } } },
        { path: "/projects/42/pipelines/10", respond: { json: pl(10, "failed") } },
        { path: "/projects/42/pipelines/10/jobs", respond: { json: [] } },
        { path: "/projects/42/pipelines/10/bridges", respond: { json: [] } },
      ],
      clock,
    );
    const out = await api.retryJobsAndWait({
      project: project(),
      pipeline: { id: 10, status: "failed", sha: "abc", ref: "b", webUrl: "" },
      jobs: [{ id: 2, name: "unit", stage: "test", status: "failed", webUrl: "", allowFailure: false }],
      timeoutMs: 30_000,
      pollMs: 10_000,
    });
    expect(out.kind).toBe("timeout");
    expect(clock.t).toBeGreaterThanOrEqual(30_000);
  });

  it("POST : rejoué seulement si la requête n'est pas partie (ECONNREFUSED), propagé sinon (ECONNRESET)", async () => {
    const config = ConfigSchema.parse({ gitlab: { url: "https://gitlab.example.com/", username: "me", userId: 1 } });
    const netErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    let calls = 0;
    const refused = createGitLabApi(config, {
      fetch: async () => {
        if (++calls === 1) throw netErr("ECONNREFUSED");
        return new Response("{}", { status: 201 });
      },
      sleep: async () => {},
      retryDelayMs: 1,
    }, TOKEN);
    await refused.comment(42, 1, "hi");
    expect(calls).toBe(2);

    calls = 0;
    const reset = createGitLabApi(config, {
      fetch: async () => {
        calls++;
        throw netErr("ECONNRESET");
      },
      sleep: async () => {},
      retryDelayMs: 1,
    }, TOKEN);
    await expect(reset.comment(42, 1, "hi")).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(1);
  });

  it("createDraftMr : en cas d'erreur (409…), renvoie la MR ouverte existante pour la branche, sinon propage", async () => {
    const { api } = setup([
      { method: "POST", path: "/projects/42/merge_requests", respond: { status: 409, json: { message: ["Another open merge request already exists"] } } },
      { path: "/projects/42/merge_requests", respond: { json: [{ iid: 8, web_url: "w" }] } },
    ]);
    expect(await api.createDraftMr({ projectId: 42, sourceBranch: "b", targetBranch: "main", title: "x", description: "d" })).toEqual({ iid: 8, webUrl: "w" });

    const none = setup([
      { method: "POST", path: "/projects/42/merge_requests", respond: { status: 409 } },
      { path: "/projects/42/merge_requests", respond: { json: [] } },
    ]);
    await expect(none.api.createDraftMr({ projectId: 42, sourceBranch: "b", targetBranch: "main", title: "x", description: "d" })).rejects.toThrow(/409/);
  });

  it("downloadImagesDetailed renvoie les échecs avec leur statut", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-img-"));
    try {
      const s1 = "a".repeat(32);
      const s2 = "c".repeat(32);
      const { api } = setup([
        { path: `/projects/42/uploads/${s1}/ok.png`, respond: { bytes: new Uint8Array([9]) } },
        { path: `/projects/42/uploads/${s2}/denied.png`, respond: { status: 403 } },
      ]);
      const res = await (api as GitLabApiImpl).downloadImagesDetailed(project(), [`![a](/uploads/${s1}/ok.png) ![b](/uploads/${s2}/denied.png)`], dir);
      expect(res.saved).toHaveLength(1);
      expect(res.failed).toEqual([{ url: `/uploads/${s2}/denied.png`, status: 403 }]);
      expect(await api.downloadImages(project(), [`![b](/uploads/${s2}/denied.png)`], dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("connexion glab (ADR, amendement 2)", () => {
  function glabSetup(routes: FakeRoute[], tokens: string[]) {
    const ff = fakeFetch(routes);
    const config = ConfigSchema.parse({ gitlab: { url: "https://gitlab.example.com", username: "olivier", userId: 5 } });
    let reads = 0;
    const provider = {
      label: "connexion glab (test)",
      get: async () => tokens[Math.min(reads, tokens.length - 1)]!,
      refresh: async () => tokens[Math.min(++reads, tokens.length - 1)]!,
    };
    const api = createGitLabApi(config, { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 }, provider);
    return { api, calls: ff.calls, reads: () => reads };
  }

  it("envoie le jeton glab en Authorization: Bearer, jamais en PRIVATE-TOKEN", async () => {
    const { api, calls } = glabSetup([{ path: "/user", respond: { json: { id: 5, username: "olivier", name: "O" } } }], ["glab-tok"]);
    await api.currentUser();
    expect(calls[0]?.headers.Authorization).toBe("Bearer glab-tok");
    expect(calls[0]?.headers["PRIVATE-TOKEN"]).toBeUndefined();
  });

  it("sur un 401, relit glab une fois (jeton OAuth expiré) puis réessaie", async () => {
    const { api, calls, reads } = glabSetup(
      [
        {
          path: "/projects/42/issues/1",
          respond: (req) => (req.headers.Authorization === "Bearer neuf" ? { json: rawIssue(1) } : { status: 401, json: {} }),
        },
      ],
      ["expiré", "neuf"],
    );
    expect((await api.getIssue(42, 1)).iid).toBe(1);
    expect(reads()).toBe(1);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer expiré", "Bearer neuf"]);
  });

  it("401 persistant après relecture : erreur sans boucle ni jeton dans le message", async () => {
    const { api, calls } = glabSetup([{ path: "/projects/42/issues/1", respond: { status: 401, text: "bad glab-same" } }], ["glab-same"]);
    const err = (await api.getIssue(42, 1).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain("glab-same");
    expect(calls).toHaveLength(1);
  });
});
