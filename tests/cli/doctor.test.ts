import { describe, expect, it } from "vitest";
import { checkGitLabConnection, parseGitVersion } from "../../src/cli/doctor.js";
import { GlabAuthError, staticToken, type TokenProvider } from "../../src/gitlab/glab-auth.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { createGitLabRest } from "../../src/gitlab/rest.js";
import { fakeFetch, type FakeRoute } from "../helpers/fake-fetch.js";

describe("parseGitVersion", () => {
  it("lit majeure et mineure", () => {
    expect(parseGitVersion("git version 2.43.0")).toEqual([2, 43]);
    expect(parseGitVersion("git version 2.29.2 (Apple Git-128)")).toEqual([2, 29]);
    expect(parseGitVersion("n/a")).toBeNull();
  });
});

describe("checkGitLabConnection (ADR, amendements 1 et 2)", () => {
  const status = { mode: "labels", inProgress: "a", inReview: "b", blocked: "c" };
  const projectCfg = (id: number, name: string) => ({
    name,
    id,
    path: `grp/${name}`,
    httpUrl: `https://gitlab.example.com/grp/${name}.git`,
    status,
  });
  const config = (projects: object[]) => ConfigSchema.parse({ gitlab: { url: "https://gitlab.example.com", username: "olivier", userId: 5 }, projects });

  function run(cfg: ReturnType<typeof config>, routes: FakeRoute[], token: TokenProvider = staticToken("glab-tok", "connexion glab (gitlab.example.com)")) {
    const ff = fakeFetch(routes);
    return checkGitLabConnection(cfg, token, (t) =>
      createGitLabRest("https://gitlab.example.com", t, { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 }),
    );
  }

  it("glab non connecté : un seul échec explicite, rien d'autre n'est vérifié", async () => {
    const notLogged: TokenProvider = {
      label: "connexion glab (gitlab.example.com)",
      get: async () => {
        throw new GlabAuthError("glab n'est pas connecté à gitlab.example.com : lance `glab auth login --hostname gitlab.example.com`, puis relance.");
      },
      refresh: async () => "",
    };
    const lines = await run(config([projectCfg(42, "app")]), [], notLogged);
    expect(lines).toEqual([{ level: "fail", msg: expect.stringMatching(/glab auth login --hostname gitlab\.example\.com/) }]);
  });

  it("jeton de projet (bot) : pas de comparaison à l'utilisateur, projet accessible et scope api vérifiés", async () => {
    const lines = await run(config([projectCfg(42, "app")]), [
      { path: "/user", respond: { status: 404, json: {} } },
      { path: "/projects/42", respond: { json: { id: 42 } } },
      { path: "/personal_access_tokens/self", respond: { json: { scopes: ["api"] } } },
    ]);
    expect(lines).toEqual([
      { level: "ok", msg: "connexion glab (gitlab.example.com) : connecté" },
      { level: "ok", msg: "glab utilise un jeton de projet (bot) : utilisateur non comparé, MR assignées à @olivier" },
      { level: "ok", msg: "app : projet accessible, scope « api » présent" },
    ]);
  });

  it("scope api manquant, projet inaccessible, scopes illisibles", async () => {
    const lines = await run(config([projectCfg(42, "app"), projectCfg(43, "web")]), [
      { path: "/user", respond: { json: { id: 5, username: "olivier", name: "O" } } },
      { path: "/projects/42", respond: { json: { id: 42 } } },
      { path: "/personal_access_tokens/self", respond: { json: { scopes: ["read_api"] } } },
    ]);
    expect(lines.map((l) => l.level)).toEqual(["ok", "ok", "fail", "fail"]);
    expect(lines[2]?.msg).toMatch(/app : le jeton glab n'a pas le scope « api » \(scopes : read_api\)/);
    expect(lines[3]?.msg).toMatch(/web : projet grp\/web inaccessible avec la connexion glab \(HTTP 404\)/);

    const oauth = await run(config([projectCfg(42, "app")]), [
      { path: "/user", respond: { json: { id: 5, username: "olivier", name: "O" } } },
      { path: "/projects/42", respond: { json: { id: 42 } } },
    ]);
    expect(oauth.at(-1)).toEqual({ level: "warn", msg: "app : projet accessible, scope « api » non vérifiable (connexion OAuth ?)" });
  });

  it("glab connecté avec le compte d'un autre utilisateur : avertissement", async () => {
    const lines = await run(config([]), [{ path: "/user", respond: { json: { id: 9, username: "bob", name: "Bob" } } }]);
    expect(lines.at(-1)).toEqual({
      level: "warn",
      msg: "glab est connecté en tant que bob (id 9), différent de la config (olivier, id 5)",
    });
  });
});
