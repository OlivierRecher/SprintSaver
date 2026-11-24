import { describe, expect, it } from "vitest";
import {
  analyseProject,
  createLabel,
  defaultProjectName,
  detectCiSource,
  detectStacks,
  checkProjectAccess,
  findUserByUsername,
  getCiConfig,
  getProject,
  getUserDetails,
  guessForRole,
  InvalidTokenError,
  resolveApiBase,
  UserLookupUnavailableError,
  guessTypeLabels,
  listAllowedStatuses,
  listMemberProjects,
} from "../../src/gitlab/discovery.js";
import { fakeFetch, type FakeRoute } from "../helpers/fake-fetch.js";
import { createGitLabRest } from "../../src/gitlab/rest.js";

function rest(routes: FakeRoute[]) {
  const ff = fakeFetch(routes);
  return { rest: createGitLabRest("https://gitlab.example.com", "t", { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 }), calls: ff.calls };
}

describe("detectStacks", () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

  it("node : gestionnaire selon le lockfile, scripts build/test, cowDirs node_modules", () => {
    expect(detectStacks(["package.json", "package-lock.json"], { "package.json": pkg({ test: "vitest", build: "tsc" }) })[0]).toEqual({
      stack: "node",
      setupCommand: "npm ci",
      buildCommand: "npm run build",
      testCommand: "npm test",
      cowDirs: ["node_modules"],
    });
    expect(detectStacks(["package.json", "pnpm-lock.yaml", "tsconfig.json"], { "package.json": pkg({ test: "x" }) })[0]).toMatchObject({
      stack: "node-typescript",
      setupCommand: "pnpm i --frozen-lockfile",
      testCommand: "pnpm test",
      buildCommand: undefined,
    });
    expect(detectStacks(["package.json", "yarn.lock"], { "package.json": pkg({ test: "x" }) })[0]?.setupCommand).toBe("yarn --frozen-lockfile");
    expect(detectStacks(["package.json", "yarn.lock", ".yarnrc.yml"], {})[0]?.setupCommand).toBe("yarn install --immutable");
  });

  it("dotnet, maven, gradle, python, go", () => {
    expect(detectStacks(["App.sln", "src"])[0]).toMatchObject({ stack: "dotnet", setupCommand: "dotnet restore", testCommand: "dotnet test" });
    expect(detectStacks(["pom.xml"])[0]).toMatchObject({ stack: "maven", testCommand: "mvn -q -B test" });
    expect(detectStacks(["build.gradle.kts", "gradlew"])[0]).toMatchObject({ stack: "gradle", testCommand: "./gradlew test" });
    expect(detectStacks(["pyproject.toml", "uv.lock"])[0]).toMatchObject({ stack: "python", testCommand: "uv run pytest" });
    expect(detectStacks(["requirements.txt"])[0]?.testCommand).toContain("pytest");
    expect(detectStacks(["go.mod"])[0]).toMatchObject({ stack: "go", testCommand: "go test ./..." });
    expect(detectStacks(["README.md"])).toEqual([]);
  });

  it("package.json sans script de test passe après une autre stack", () => {
    const stacks = detectStacks(["package.json", "pom.xml"], { "package.json": pkg({ lint: "x" }) });
    expect(stacks.map((s) => s.stack)).toEqual(["maven", "node"]);
  });
});

describe("détections diverses", () => {
  it("detectCiSource", () => {
    expect(detectCiSource(null)).toBe("branch");
    expect(detectCiSource("test:\n  script: npm test\n")).toBe("branch");
    expect(detectCiSource('workflow:\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n')).toBe("merge_request");
    expect(detectCiSource("include:\n  - template: 'Workflows/MergeRequest-Pipelines.gitlab-ci.yml'\n")).toBe("merge_request");
    expect(detectCiSource("test:\n  only:\n    - merge_requests\n")).toBe("merge_request");
  });

  it("detectCiSource : une règle merge_request_event suivie de when: never, niée ou commentée ne compte pas", () => {
    const yaml = (...lines: string[]) => `${lines.join("\n")}\n`;
    // règle qui EXCLUT les pipelines de MR
    expect(
      detectCiSource(
        yaml("workflow:", "  rules:", '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"', "      when: never", "    - when: always"),
      ),
    ).toBe("branch");
    expect(detectCiSource(yaml("job:", "  rules:", `    - { if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: never }`, "    - when: on_success"))).toBe("branch");
    expect(detectCiSource(yaml("job:", "  rules:", "    - when: never", '      if: $CI_PIPELINE_SOURCE == "merge_request_event"', "    - when: always"))).toBe("branch");
    expect(detectCiSource(yaml("job:", "  rules:", '    - if: $CI_PIPELINE_SOURCE != "merge_request_event"'))).toBe("branch");
    expect(detectCiSource(yaml("job:", "  rules:", '    # - if: $CI_PIPELINE_SOURCE == "merge_request_event"', "    - when: always"))).toBe("branch");
    expect(detectCiSource(yaml("test:", "  except:", "    - merge_requests"))).toBe("branch");
    expect(detectCiSource(yaml("test:", "  except:", "    refs:", "      - merge_requests"))).toBe("branch");

    // règles qui DÉCLENCHENT sur merge_request_event
    expect(
      detectCiSource(
        yaml(
          "workflow:",
          "  rules:",
          '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
          "    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS",
          "      when: never",
          "    - if: $CI_COMMIT_BRANCH",
        ),
      ),
    ).toBe("merge_request");
    expect(detectCiSource(yaml("job:", "  rules:", '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"', "      when: manual"))).toBe("merge_request");
    expect(detectCiSource(yaml("job:", "  rules:", "    - if: $CI_PIPELINE_SOURCE =~ /merge_request_event/"))).toBe("merge_request");
    expect(detectCiSource(yaml("job:", "  rules:", '    - if: $CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "merge_request_event"'))).toBe("merge_request");
    expect(detectCiSource(yaml("test:", "  only:", "    refs:", "      - merge_requests"))).toBe("merge_request");
    expect(detectCiSource(yaml("test:", "  only: [merge_requests]"))).toBe("merge_request");
    expect(detectCiSource(yaml("test:", "  except: [merge_requests]"))).toBe("branch");
  });

  it("defaultProjectName, guessForRole, guessTypeLabels", () => {
    expect(defaultProjectName("grp/sous/Mon Projet.Web")).toBe("mon-projet-web");
    expect(guessForRole("inProgress", ["To do", "In progress", "Done"])).toBe("In progress");
    expect(guessForRole("inReview", ["workflow::in review"])).toBe("workflow::in review");
    expect(guessForRole("blocked", ["Done"])).toBeUndefined();
    expect(guessTypeLabels("bug", ["type::bug", "feature", "Bug"])).toEqual(["type::bug", "Bug"]);
    expect(guessTypeLabels("feature", ["type::bug", "feature", "enhancement"])).toEqual(["feature", "enhancement"]);
  });
});

describe("appels réseau (simulés)", () => {
  it("listMemberProjects pagine avec membership et archived=false", async () => {
    const proj = (id: number) => ({ id, name: `p${id}`, path_with_namespace: `g/p${id}`, http_url_to_repo: `h${id}`, web_url: `w${id}`, default_branch: id === 2 ? null : "dev" });
    const { rest: r, calls } = rest([
      { path: "/projects", respond: (req) => (req.query.get("page") === "1" ? { json: [proj(1)], headers: { "x-next-page": "2" } } : { json: [proj(2)] }) },
    ]);
    const list = await listMemberProjects(r);
    expect(list.map((p) => [p.id, p.defaultBranch])).toEqual([
      [1, "dev"],
      [2, "main"],
    ]);
    expect(calls[0]!.query.get("membership")).toBe("true");
    expect(calls[0]!.query.get("archived")).toBe("false");
  });

  it("analyseProject lit l'arbre, package.json et .gitlab-ci.yml", async () => {
    const { rest: r } = rest([
      {
        path: "/projects/5/repository/tree",
        respond: { json: ["package.json", "package-lock.json", ".gitlab-ci.yml", ".worktreeinclude"].map((name) => ({ name, type: "blob" })) },
      },
      { path: "/projects/5/repository/files/package.json/raw", respond: { text: '{"scripts":{"test":"vitest"}}' } },
      { path: "/projects/5/repository/files/.gitlab-ci.yml/raw", respond: { text: "rules:\n  - if: $CI_PIPELINE_SOURCE == 'merge_request_event'" } },
    ]);
    const a = await analyseProject(r, 5, "main");
    expect(a.stacks[0]).toMatchObject({ stack: "node", testCommand: "npm test" });
    expect(a.ciSource).toBe("merge_request");
    expect(a.hasWorktreeInclude).toBe(true);
  });

  it("listAllowedStatuses préfère le type Issue et renvoie [] en cas d'erreur", async () => {
    const { rest: r } = rest([
      {
        method: "POST",
        path: "/api/graphql",
        respond: {
          json: {
            data: {
              project: {
                workItemTypes: {
                  nodes: [
                    { name: "Epic", widgetDefinitions: [{ allowedStatuses: [{ id: "e1", name: "E" }] }] },
                    { name: "Issue", widgetDefinitions: [{}, { allowedStatuses: [{ id: "s1", name: "To do" }, { id: "s2", name: "In progress" }] }] },
                  ],
                },
              },
            },
          },
        },
      },
    ]);
    expect(await listAllowedStatuses(r, "g/p")).toEqual([
      { id: "s1", name: "To do" },
      { id: "s2", name: "In progress" },
    ]);
    const { rest: bad } = rest([{ method: "POST", path: "/api/graphql", respond: { json: { errors: [{ message: "Field 'workItemTypes' doesn't exist" }] } } }]);
    expect(await listAllowedStatuses(bad, "g/p")).toEqual([]);
  });

  it("createLabel poste nom et couleur", async () => {
    const { rest: r, calls } = rest([{ method: "POST", path: "/projects/5/labels", respond: { status: 201, json: {} } }]);
    await createLabel(r, 5, "auto::ready");
    expect(calls[0]!.body).toEqual({ name: "auto::ready", color: "#6699cc" });
  });
});

describe("type de jeton (ADR, amendement 1)", () => {
  it("GET /user 200 → Personal Access Token avec l'identité de son propriétaire", async () => {
    const { rest: r } = rest([
      { path: "/user", respond: { json: { id: 5, username: "olivier", name: "Olivier", commit_email: "o@x.fr" } } },
    ]);
    expect(await getUserDetails(r)).toEqual({
      kind: "personal",
      user: { id: 5, username: "olivier", name: "Olivier", email: "o@x.fr" },
    });
  });

  it.each([404, 403])("GET /user %i → jeton de projet", async (status) => {
    const { rest: r } = rest([{ path: "/user", respond: { status, json: { message: "nope" } } }]);
    expect(await getUserDetails(r)).toEqual({ kind: "project" });
  });

  it("GET /user renvoie un compte bot → jeton de projet", async () => {
    const { rest: r } = rest([{ path: "/user", respond: { json: { id: 900, username: "project_42_bot", name: "bot", bot: true } } }]);
    expect(await getUserDetails(r)).toEqual({ kind: "project" });
  });

  it("GET /user 401 → erreur de jeton invalide, en français", async () => {
    const { rest: r } = rest([{ path: "/user", respond: { status: 401, json: { message: "401 Unauthorized" } } }]);
    const err = await getUserDetails(r).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect((err as Error).message).toMatch(/Jeton GitLab refusé \(HTTP 401\).*invalide, expiré ou révoqué/);
  });

  it("une autre erreur (500) n'est pas prise pour un jeton de projet", async () => {
    const { rest: r } = rest([{ path: "/user", respond: { status: 500, text: "boom" } }]);
    await expect(getUserDetails(r)).rejects.toThrow(/HTTP 500/);
  });
});

describe("findUserByUsername", () => {
  it("résout l'id d'un humain par GET /users?username=, en ignorant un @ initial", async () => {
    const { rest: r, calls } = rest([
      { path: "/users", respond: { json: [{ id: 5, username: "Olivier", name: "Olivier R", public_email: "" }] } },
    ]);
    expect(await findUserByUsername(r, "@olivier")).toEqual({ id: 5, username: "Olivier", name: "Olivier R", email: undefined });
    expect(calls[0]?.query.get("username")).toBe("olivier");
  });

  it("username inconnu → null ; username vide → null sans appel", async () => {
    const { rest: r, calls } = rest([{ path: "/users", respond: { json: [] } }]);
    expect(await findUserByUsername(r, "ghost")).toBeNull();
    expect(await findUserByUsername(r, "  ")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("401 → InvalidTokenError", async () => {
    const { rest: r } = rest([{ path: "/users", respond: { status: 401, json: {} } }]);
    await expect(findUserByUsername(r, "olivier")).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe("checkProjectAccess", () => {
  it("projet lisible et scopes du jeton", async () => {
    const { rest: r } = rest([
      { path: "/projects/42", respond: { json: { id: 42 } } },
      { path: "/personal_access_tokens/self", respond: { json: { scopes: ["api", "read_repository"] } } },
    ]);
    expect(await checkProjectAccess(r, 42)).toEqual({ accessible: true, scopes: ["api", "read_repository"] });
  });

  it("projet inaccessible (404) et scopes illisibles", async () => {
    const { rest: r } = rest([{ path: "/personal_access_tokens/self", respond: { status: 403, json: {} } }]);
    expect(await checkProjectAccess(r, 42)).toEqual({ accessible: false, status: 404 });
  });
});

describe("resolveApiBase", () => {
  /** Faux GitLab : l'API n'existe qu'à `apiRoot` (401 JSON) ; ailleurs, redirection HTML vers la connexion (302). */
  function instance(apiRoot: string) {
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      return url === `${apiRoot}/api/v4/version`
        ? new Response('{"message":"401 Unauthorized"}', { status: 401, headers: { "content-type": "application/json" } })
        : new Response("<html>", { status: 302, headers: { "content-type": "text/html", location: "/users/sign_in" } });
    };
    return { fetchFn, seen };
  }

  it("URL de projet collée par erreur : retrouve l'instance et le projet (cas réel de mines-ales)", async () => {
    const { fetchFn, seen } = instance("https://gitlab.etu.mines-ales.fr");
    expect(await resolveApiBase("https://gitlab.etu.mines-ales.fr/volunear/volunear", fetchFn)).toEqual({
      base: "https://gitlab.etu.mines-ales.fr",
      projectPath: "volunear/volunear",
    });
    expect(seen).toEqual([
      "https://gitlab.etu.mines-ales.fr/volunear/volunear/api/v4/version",
      "https://gitlab.etu.mines-ales.fr/volunear/api/v4/version",
      "https://gitlab.etu.mines-ales.fr/api/v4/version",
    ]);
  });

  it("URL d'un ticket ou d'un .git : ignore la partie après /-/ et l'extension", async () => {
    const { fetchFn } = instance("https://gitlab.com");
    expect(await resolveApiBase("https://gitlab.com/grp/sub/app/-/issues/12", fetchFn)).toEqual({ base: "https://gitlab.com", projectPath: "grp/sub/app" });
    expect(await resolveApiBase("https://gitlab.com/grp/app.git", fetchFn)).toEqual({ base: "https://gitlab.com", projectPath: "grp/app" });
  });

  it("instance installée sous un chemin, et adresse déjà correcte", async () => {
    const { fetchFn } = instance("https://exemple.fr/gitlab");
    expect(await resolveApiBase("https://exemple.fr/gitlab/grp/app", fetchFn)).toEqual({ base: "https://exemple.fr/gitlab", projectPath: "grp/app" });
    expect(await resolveApiBase("https://exemple.fr/gitlab/", fetchFn)).toEqual({ base: "https://exemple.fr/gitlab" });
  });

  it("aucune API trouvée : erreur qui dit quoi saisir", async () => {
    const { fetchFn } = instance("https://ailleurs.example");
    await expect(resolveApiBase("https://pas-gitlab.example/x", fetchFn)).rejects.toThrow(/adresse de l'instance/);
  });
});

describe("findUserByUsername : recherche refusée par l'instance", () => {
  it.each([403, 404])("GET /users %i → UserLookupUnavailableError", async (status) => {
    const { rest: r } = rest([{ path: "/users", respond: { status, json: {} } }]);
    await expect(findUserByUsername(r, "olivier.recher")).rejects.toBeInstanceOf(UserLookupUnavailableError);
  });
});

describe("config CI et projet par chemin (init, ADR amendement 5)", () => {
  it("getCiConfig : config fusionnée de l'API de validation, includes développés", async () => {
    const { rest: r, calls } = rest([{ path: "/projects/7/ci/lint", respond: { json: { valid: true, merged_yaml: "test:\n  image: node:20\n" } } }]);
    expect(await getCiConfig(r, 7, "main")).toEqual({ source: "merged", yaml: "test:\n  image: node:20\n" });
    expect(calls[0]!.query.get("content_ref")).toBe("main");
  });

  it("getCiConfig : repli sur le .gitlab-ci.yml brut si la validation est refusée, « none » sans CI", async () => {
    const { rest: r } = rest([
      { path: "/projects/7/ci/lint", respond: { status: 403, json: {} } },
      { path: "/projects/7/repository/files/.gitlab-ci.yml/raw", respond: { text: "include: x.yml\n" } },
    ]);
    expect(await getCiConfig(r, 7, "main")).toEqual({ source: "raw", yaml: "include: x.yml\n" });
    const { rest: none } = rest([{ path: "/projects/7/ci/lint", respond: { json: { valid: false, merged_yaml: null } } }]);
    expect(await getCiConfig(none, 7, "main")).toEqual({ source: "none", yaml: "" });
  });

  it("getProject : par chemin encodé ou par id", async () => {
    const p = { id: 7, name: "shop", path_with_namespace: "team/shop", http_url_to_repo: "https://g/team/shop.git", web_url: "https://g/team/shop", default_branch: null };
    const { rest: r, calls } = rest([{ path: "/projects/team/shop", respond: { json: p } }]);
    expect(await getProject(r, "team/shop")).toEqual({ id: 7, name: "shop", pathWithNamespace: "team/shop", httpUrl: "https://g/team/shop.git", webUrl: "https://g/team/shop", defaultBranch: "main" });
    expect(calls[0]!.path).toBe("/projects/team%2Fshop");
  });
});
