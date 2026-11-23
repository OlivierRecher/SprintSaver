import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ConfigSchema, ProjectConfigSchema } from "../../src/config/schema.js";

const status = { mode: "labels", inProgress: "a", inReview: "b", blocked: "c" };
const project = (id: number, extra: object = {}) => ({
  name: `p${id}`,
  id,
  path: `grp/p${id}`,
  httpUrl: `https://gitlab.example.com/grp/p${id}.git`,
  status,
  ...extra,
});

describe("aucun jeton dans la config (ADR, amendement 2)", () => {
  it("une config sans jeton est valide : la connexion est celle de glab", () => {
    const config = ConfigSchema.parse({ gitlab: { username: "olivier", userId: 5 }, projects: [project(1)] });
    expect(config.gitlab).toEqual({ url: "https://gitlab.com", username: "olivier", userId: 5 });
  });

  it("une ancienne config avec des jetons en clair se charge, et les jetons ne sont plus réécrits", () => {
    const config = ConfigSchema.parse({
      gitlab: { token: "glpat-old-global", username: "olivier", userId: 5 },
      projects: [project(1, { token: "glpat-old-project" })],
    });
    const saved = YAML.stringify(config);
    expect(saved).not.toContain("glpat-old");
    expect(saved).not.toMatch(/\btoken\b/);
  });
});

describe("statuts : une cible par rôle", () => {
  const base = { name: "app", id: 1, path: "g/app", httpUrl: "https://gitlab.example.com/g/app.git" };

  it("ancien format « labels » converti en cibles label", () => {
    const p = ProjectConfigSchema.parse({ ...base, status: { mode: "labels", inProgress: "a", inReview: "b", blocked: "c" } });
    expect(p.status).toEqual({
      inProgress: { kind: "label", name: "a" },
      inReview: { kind: "label", name: "b" },
      blocked: { kind: "label", name: "c" },
    });
  });

  it("ancien format « native » converti en cibles natives", () => {
    const p = ProjectConfigSchema.parse({
      ...base,
      status: { mode: "native", inProgress: { id: "g1", name: "In progress" }, inReview: { id: "g2", name: "R" }, blocked: { id: "g3", name: "B" } },
    });
    expect(p.status.inProgress).toEqual({ kind: "native", id: "g1", name: "In progress" });
  });

  it("format mixte : natif pour en cours, labels pour les autres", () => {
    const status = {
      inProgress: { kind: "native", id: "g1", name: "In progress" },
      inReview: { kind: "label", name: "sprintsaver::en-review" },
      blocked: { kind: "label", name: "sprintsaver::bloque" },
    };
    expect(ProjectConfigSchema.parse({ ...base, status }).status).toEqual(status);
    expect(ProjectConfigSchema.safeParse({ ...base, status: { ...status, blocked: { kind: "label", name: "" } } }).success).toBe(false);
  });
});

describe("captures avant/après (ADR, amendement 3)", () => {
  it("activées par défaut, désactivables ; phase ui-captures sur Sonnet", async () => {
    const { modelFor, SONNET } = await import("../../src/config/schema.js");
    const config = ConfigSchema.parse({ gitlab: { username: "o", userId: 5 } });
    expect(config.screenshots).toEqual({ enabled: true });
    expect(ConfigSchema.parse({ gitlab: { username: "o", userId: 5 }, screenshots: { enabled: false } }).screenshots.enabled).toBe(false);
    expect(modelFor(config, "ui-captures")).toBe(SONNET);
  });
});
