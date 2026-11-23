/**
 * Sélection déterministe des skills injectés dans le prompt système d'une session (ADR § 9).
 *
 * Ordre : phase (obligatoire) → type de ticket (phases d'ingénierie) → projet → conventions du dépôt cible.
 * Aucune trace d'un ticket passé n'est injectée ici (ADR § 10).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPhase, ProjectConfig, TicketType } from "../config/schema.js";
import { skillsDir } from "../config/paths.js";

/** Phases qui reçoivent le skill de type (bug / feature). */
export const TYPE_SKILL_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  "analyse",
  "write-tests",
  "implement",
  "review",
  "verify-criteria",
]);

export interface SkillContextInput {
  phase: AgentPhase;
  ticketType: TicketType;
  /** Skills de type à charger à la place de `ticketType` (type pas encore tranché : les deux). */
  typeSkills?: TicketType[];
  project: ProjectConfig;
  worktreePath: string;
  skillsRoot?: string;
}

export interface SkillContext {
  /** Texte à ajouter au prompt système. */
  text: string;
  /** Identifiants des blocs chargés, dans l'ordre (ex. "phases/analyse", "repo:CLAUDE.md"). */
  loaded: string[];
}

/** Retire un frontmatter YAML (`---` ... `---`) en tête de fichier. */
export function stripFrontmatter(content: string): string {
  const text = content.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function buildSkillContext(input: SkillContextInput): Promise<SkillContext> {
  const root = input.skillsRoot ?? skillsDir();
  const blocks: string[] = [];
  const loaded: string[] = [];

  // 1. Skill de phase : obligatoire.
  const phasePath = join(root, "phases", input.phase, "SKILL.md");
  const phaseContent = await readIfExists(phasePath);
  if (phaseContent === null) {
    throw new Error(`Skill de phase introuvable pour "${input.phase}" : ${phasePath}`);
  }
  blocks.push(`# Skill de phase : ${input.phase}\n\n${stripFrontmatter(phaseContent)}`);
  loaded.push(`phases/${input.phase}`);

  // 2. Skill de type, pour les phases d'ingénierie.
  // Type pas encore tranché (analyse sans label) : les deux skills, pour profiter aussi de la recherche
  // de précédents du skill `bug`.
  if (TYPE_SKILL_PHASES.has(input.phase)) {
    const types = input.typeSkills && input.typeSkills.length > 0 ? [...new Set(input.typeSkills)] : [input.ticketType];
    for (const type of types) {
      const typeContent = await readIfExists(join(root, "types", type, "SKILL.md"));
      if (typeContent !== null) {
        blocks.push(`# Skill de type de ticket : ${type}\n\n${stripFrontmatter(typeContent)}`);
        loaded.push(`types/${type}`);
      }
    }
  }

  // 3. Connaissances propres au projet.
  const projectContent = await readIfExists(join(root, "projects", `${input.project.name}.md`));
  if (projectContent !== null) {
    blocks.push(`# Connaissances du projet : ${input.project.name}\n\n${stripFrontmatter(projectContent)}`);
    loaded.push(`projects/${input.project.name}`);
  }

  // 4. Conventions du dépôt cible (CLAUDE.md, à défaut AGENTS.md).
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const content = await readIfExists(join(input.worktreePath, name));
    if (content !== null) {
      blocks.push(`# Conventions du dépôt cible (${name})\n\n${content.trim()}`);
      loaded.push(`repo:${name}`);
      break;
    }
  }

  return { text: blocks.join("\n\n---\n\n"), loaded };
}
