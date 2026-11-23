import { describe, expect, it } from "vitest";
import { ProjectConfigSchema, type ProjectConfig } from "../../src/config/schema.js";
import {
  DEFAULT_STATUS_LABELS,
  ensureGlabConnection,
  statusChoices,
  typeLabelChoices,
  reservedProjectNames,
  resolveHumanUser,
  suggestProjectName,
  validateProjectName,
} from "../../src/cli/init.js";
import { createGitLabRest } from "../../src/gitlab/rest.js";
import { fakeFetch } from "../helpers/fake-fetch.js";
import { GlabAuthError, type ExecFn } from "../../src/gitlab/glab-auth.js";

function prior(id: number, name: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    name,
    id,
    path: `grp/${name}`,
    httpUrl: `https://gitlab.example.com/grp/${name}.git`,
    status: { mode: "labels", inProgress: "a", inReview: "b", blocked: "c" },
  });
}

describe("noms de projets (init)", () => {
  const priorById = new Map([
    [1, prior(1, "api")],
    [2, prior(2, "front")],
  ]);

  it("réserve les noms des projets existants re-sélectionnés (pas ceux désélectionnés)", () => {
    expect([...reservedProjectNames([3, 1], priorById)]).toEqual(["api"]);
    expect([...reservedProjectNames([1, 2], priorById)].sort()).toEqual(["api", "front"]);
  });

  it("un nouveau projet traité avant un projet existant ne peut pas prendre son nom", () => {
    const used = reservedProjectNames([3, 1], priorById);
    // projet 3 (nouveau, path grp/api) configuré en premier
    expect(suggestProjectName("api", used)).toBe("api-2");
    expect(validateProjectName("api", used)).toMatch(/déjà utilisé/);
    expect(validateProjectName("api-2", used)).toBe(true);
    // le projet existant garde son propre nom
    expect(validateProjectName("api", used, "api")).toBe(true);
    expect(suggestProjectName("api", used, "api")).toBe("api");
  });

  it("refuse les caractères invalides", () => {
    expect(validateProjectName("-x", new Set())).toMatch(/Lettres/);
  });
});

describe("jeton de projet dans init (ADR, amendement 1)", () => {
  it("resolveHumanUser redemande tant que le username est introuvable, puis renvoie l'humain", async () => {
    const ff = fakeFetch([
      {
        path: "/users",
        respond: (req) =>
          req.query.get("username") === "olivier" ? { json: [{ id: 5, username: "olivier", name: "Olivier" }] } : { json: [] },
      },
    ]);
    const rest = createGitLabRest("https://gitlab.example.com", "glpat-bot", { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 });
    const answers = ["olivir", "@olivier"];
    const defaults: (string | undefined)[] = [];
    const said: string[] = [];
    const user = await resolveHumanUser(
      rest,
      async (def) => {
        defaults.push(def);
        return answers.shift()!;
      },
      "ancien",
      (s) => said.push(s),
    );
    expect(user).toEqual({ id: 5, username: "olivier", name: "Olivier", email: undefined });
    expect(defaults).toEqual(["ancien", undefined]);
    expect(said.join("\n")).toMatch(/« olivir » introuvable/);
  });

});

describe("resolveHumanUser : recherche d'utilisateurs refusée", () => {
  it("demande l'id directement au lieu d'échouer", async () => {
    const ff = fakeFetch([{ path: "/users", respond: { status: 404, json: {} } }]);
    const rest = createGitLabRest("https://gitlab.example.com", "t", { fetch: ff.fetch, sleep: async () => {}, retryDelayMs: 1 });
    const said: string[] = [];
    const user = await resolveHumanUser(rest, async () => "@olivier.recher", undefined, (s) => said.push(s), async (u) => {
      expect(u).toBe("olivier.recher");
      return 1234;
    });
    expect(user).toEqual({ id: 1234, username: "olivier.recher", name: "olivier.recher" });
    expect(said.join("\n")).toMatch(/HTTP 404.*Indique ton id/);
  });
});

describe("connexion glab dans init (ADR, amendement 2)", () => {
  /** Faux glab : `--version` répond si installé ; `auth status` donne un jeton une fois `loggedIn` vrai. */
  function fakeGlab(state: { installed: boolean; loggedIn: boolean }): ExecFn {
    return async (_cmd, args) => {
      if (!state.installed) return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "--version") return { code: 0, stdout: "glab 1.60.0 (2026-10-01)\n", stderr: "" };
      return state.loggedIn
        ? { code: 0, stdout: "", stderr: "gitlab.com\n  ✓ Logged in to gitlab.com as olivier\n  ✓ Token: glpat-from-glab\n" }
        : { code: 1, stdout: "", stderr: "gitlab.com\n  x No token provided\n" };
    };
  }
  const quiet = () => {};

  it("glab absent : erreur explicite qui dit comment l'installer", async () => {
    const err = await ensureGlabConnection("gitlab.com", { exec: fakeGlab({ installed: false, loggedIn: false }), say: quiet }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlabAuthError);
    expect((err as Error).message).toMatch(/brew install glab/);
  });

  it("glab connecté : renvoie le fournisseur sans rien demander", async () => {
    const provider = await ensureGlabConnection("gitlab.com", {
      exec: fakeGlab({ installed: true, loggedIn: true }),
      confirmLogin: async () => {
        throw new Error("ne doit pas demander");
      },
      say: quiet,
    });
    expect(await provider.get()).toBe("glpat-from-glab");
  });

  it("glab non connecté : propose glab auth login, puis relit la connexion", async () => {
    const state = { installed: true, loggedIn: false };
    const logins: string[] = [];
    const provider = await ensureGlabConnection("gitlab.com", {
      exec: fakeGlab(state),
      confirmLogin: async () => true,
      login: async (host) => {
        logins.push(host);
        state.loggedIn = true;
        return true;
      },
      say: quiet,
    });
    expect(logins).toEqual(["gitlab.com"]);
    expect(await provider.get()).toBe("glpat-from-glab");
  });

  it("glab non connecté et connexion refusée : erreur qui indique la commande à lancer", async () => {
    const err = await ensureGlabConnection("gitlab.example.com", {
      exec: fakeGlab({ installed: true, loggedIn: false }),
      confirmLogin: async () => false,
      say: quiet,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/glab auth login --hostname gitlab\.example\.com/);
  });
});

describe("statuts et labels proposés par init", () => {
  const natives = [
    { id: "gid://s/1", name: "To do" },
    { id: "gid://s/2", name: "In progress" },
    { id: "gid://s/3", name: "Done" },
  ];

  it("cas réel : seul « en cours » a un statut natif → natif pour en cours, création de label proposée pour les autres", () => {
    const inProgress = statusChoices("inProgress", natives, [], undefined);
    expect(inProgress.defaultValue).toBe("native:gid://s/2");
    const inReview = statusChoices("inReview", natives, [], undefined);
    expect(inReview.defaultValue).toBe(`create:${DEFAULT_STATUS_LABELS.inReview.name}`);
    const blocked = statusChoices("blocked", natives, [], undefined);
    expect(blocked.defaultValue).toBe(`create:${DEFAULT_STATUS_LABELS.blocked.name}`);
    // Chaque rôle propose les trois sortes de cible, plus un nom libre.
    expect(blocked.choices.map((c) => c.name)).toEqual([
      "Statut natif : To do",
      "Statut natif : In progress",
      "Statut natif : Done",
      "Créer le label « sprintsaver::bloque »",
      "Créer un autre label…",
    ]);
  });

  it("un label existant qui ressemble au rôle est choisi par défaut, et la création n'est plus proposée s'il existe", () => {
    const c = statusChoices("blocked", [], ["Blocked", "sprintsaver::bloque"], undefined);
    expect(c.defaultValue).toBe("label:Blocked");
    expect(c.choices.some((x) => x.choice.kind === "create")).toBe(false);
  });

  it("la cible actuelle est reprise ; un ancien label disparu est proposé à la recréation", () => {
    expect(statusChoices("inReview", natives, ["review"], { kind: "label", name: "review" }).defaultValue).toBe("label:review");
    const gone = statusChoices("inReview", natives, [], { kind: "label", name: "ancien::review" });
    expect(gone.defaultValue).toBe("create:ancien::review");
    expect(gone.choices[0]?.name).toBe("Créer le label « ancien::review »");
  });

  it("labels de type : création cochée d'office quand aucun label ne correspond", () => {
    expect(typeLabelChoices("bug", [], undefined)).toEqual([{ name: "Créer le label « bug »", value: "\u0000create:bug", checked: true }]);
    const withGuess = typeLabelChoices("bug", ["defect", "doc"], undefined);
    expect(withGuess.filter((c) => c.checked).map((c) => c.value)).toEqual(["defect"]);
    expect(withGuess.at(-1)).toEqual({ name: "Créer le label « bug »", value: "\u0000create:bug", checked: false });
    expect(typeLabelChoices("feature", ["feature"], undefined)).toEqual([{ name: "feature", value: "feature", checked: true }]);
  });
});
