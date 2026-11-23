import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import { ConfigSchema, type Config, type ProjectConfig } from "./schema.js";
import { paths } from "./paths.js";

export class ConfigError extends Error {}

export async function loadConfig(file = paths.config()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`Config introuvable : ${file}. Lance d'abord \`sprintsaver init\`.`);
  }
  const parsed = ConfigSchema.safeParse(YAML.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`)
      .join("\n");
    throw new ConfigError(`Config invalide (${file}) :\n${issues}`);
  }
  return parsed.data;
}

export async function saveConfig(config: Config, file = paths.config()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, YAML.stringify(config), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

export function findProject(config: Config, name: string): ProjectConfig {
  const p = config.projects.find((x) => x.name === name);
  if (!p) {
    const known = config.projects.map((x) => x.name).join(", ") || "aucun";
    throw new ConfigError(`Projet inconnu : ${name} (projets configurés : ${known})`);
  }
  return p;
}
