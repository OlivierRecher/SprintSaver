import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/config/schema.js";
import { buildSkillContext, stripFrontmatter } from "../../src/agent/skills.js";

const project = { name: "webapp", id: 42, path: "g/webapp" } as ProjectConfig;

let root: string;
let skills: string;
let wt: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ss-skills-"));
  skills = join(root, "skills");
  wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  await put(join(skills, "phases", "analyse", "SKILL.md"), "---\nname: analyse\ndescription: x\n---\n\nAnalyse le ticket.\n");
  await put(join(skills, "phases", "mr-writeup", "SKILL.md"), "Rédige la MR.");
  await put(join(skills, "types", "bug", "SKILL.md"), "---\nname: bug\n---\nReproduis d'abord.");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("stripFrontmatter", () => {
  it("retire un frontmatter YAML en tête", () => {
    expect(stripFrontmatter("---\nname: a\n---\n\nCorps")).toBe("Corps");
  });
  it("laisse un texte sans frontmatter", () => {
    expect(stripFrontmatter("Corps\n---\nsuite")).toBe("Corps\n---\nsuite");
  });
});

describe("buildSkillContext", () => {
  it("charge phase + type + projet + CLAUDE.md dans l'ordre", async () => {
    await put(join(skills, "projects", "webapp.md"), "Utilise pnpm.");
    await writeFile(join(wt, "CLAUDE.md"), "Conventions maison.");
    await writeFile(join(wt, "AGENTS.md"), "Ignoré car CLAUDE.md existe.");
    const ctx = await buildSkillContext({ phase: "analyse", ticketType: "bug", project, worktreePath: wt, skillsRoot: skills });
    expect(ctx.loaded).toEqual(["phases/analyse", "types/bug", "projects/webapp", "repo:CLAUDE.md"]);
    expect(ctx.text).toContain("# Skill de phase : analyse");
    expect(ctx.text).toContain("Analyse le ticket.");
    expect(ctx.text).toContain("# Skill de type de ticket : bug");
    expect(ctx.text).toContain("# Connaissances du projet : webapp");
    expect(ctx.text).toContain("Conventions du dépôt cible (CLAUDE.md)");
    expect(ctx.text.includes("name: analyse")).toBe(false);
    expect(ctx.text.includes("Ignoré car")).toBe(false);
    expect(ctx.text.indexOf("analyse") < ctx.text.indexOf("Reproduis")).toBe(true);
  });

  it("n'injecte pas le skill de type pour mr-writeup et se rabat sur AGENTS.md", async () => {
    await writeFile(join(wt, "AGENTS.md"), "Conventions agents.");
    const ctx = await buildSkillContext({ phase: "mr-writeup", ticketType: "bug", project, worktreePath: wt, skillsRoot: skills });
    expect(ctx.loaded).toEqual(["phases/mr-writeup", "repo:AGENTS.md"]);
    expect(ctx.text).toContain("Conventions agents.");
  });

  it("type pas encore tranché : charge les deux skills de type (bug puis feature)", async () => {
    await put(join(skills, "types", "feature", "SKILL.md"), "Décris le comportement attendu.");
    const ctx = await buildSkillContext({
      phase: "analyse",
      ticketType: "feature",
      typeSkills: ["bug", "feature"],
      project,
      worktreePath: wt,
      skillsRoot: skills,
    });
    expect(ctx.loaded).toEqual(["phases/analyse", "types/bug", "types/feature"]);
    expect(ctx.text).toContain("Reproduis d'abord.");
    expect(ctx.text).toContain("Décris le comportement attendu.");
  });

  it("ignore les skills optionnels absents", async () => {
    const ctx = await buildSkillContext({ phase: "analyse", ticketType: "feature", project, worktreePath: wt, skillsRoot: skills });
    expect(ctx.loaded).toEqual(["phases/analyse"]);
  });

  it("lève une erreur claire si le skill de phase manque", async () => {
    await expect(
      buildSkillContext({ phase: "review", ticketType: "bug", project, worktreePath: wt, skillsRoot: skills }),
    ).rejects.toThrow(/Skill de phase introuvable pour "review"/);
  });
});

describe("buildSkillContext — navigateur (Claude in Chrome)", () => {
  it("ajoute le skill tools/chrome juste après le skill de phase quand la session a le navigateur", async () => {
    await put(join(skills, "tools", "chrome", "SKILL.md"), "---\nname: chrome\n---\nHôte local uniquement.");
    const ctx = await buildSkillContext({ phase: "analyse", ticketType: "bug", project, worktreePath: wt, skillsRoot: skills, browser: true });
    expect(ctx.loaded).toEqual(["phases/analyse", "tools/chrome", "types/bug"]);
    expect(ctx.text).toContain("Hôte local uniquement.");
    const without = await buildSkillContext({ phase: "analyse", ticketType: "bug", project, worktreePath: wt, skillsRoot: skills });
    expect(without.loaded).not.toContain("tools/chrome");
  });
  it("skill du navigateur absent : erreur explicite", async () => {
    await expect(
      buildSkillContext({ phase: "mr-writeup", ticketType: "bug", project, worktreePath: wt, skillsRoot: skills, browser: true }),
    ).rejects.toThrow(/navigateur introuvable/);
  });
  it("le skill livré dans le dépôt existe", async () => {
    const ctx = await buildSkillContext({ phase: "review", ticketType: "feature", project, worktreePath: wt, browser: true });
    expect(ctx.loaded.slice(0, 2)).toEqual(["phases/review", "tools/chrome"]);
    expect(ctx.text).toContain("save_to_disk");
  });
});
