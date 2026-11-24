/**
 * Outils MCP in-process de l'agent de configuration de `init` (ADR, amendement 5).
 *
 * Tout ce que l'agent sait du projet et de la machine passe par ces outils, limités au projet en cours de
 * configuration : infos du projet et config actuelle, labels, statuts natifs, config CI (lecture seule GitLab),
 * recherche bornée d'un checkout local, sondes de toolchain fixes, et `verify_commands`, exécuté par
 * l'orchestrateur dans un worktree jetable (3 tentatives au plus). Aucun outil n'écrit sur GitLab.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import type { ProjectConfig } from "../config/schema.js";
import { detectCiSource, type CiConfig, type LabelInfo, type NativeStatus, type ProjectInfo } from "../gitlab/discovery.js";
import type { CheckoutSearch, IgnoredListing } from "../init/local-checkout.js";
import { KNOWN_TOOLS } from "../init/toolchains.js";
import { formatReport, type VerificationReport, type VerifyInput } from "../init/verify.js";
import { resolveHome } from "../git/gitops.js";

export const INIT_MCP_SERVER_NAME = "sprintsaver";
export const MAX_VERIFY_ATTEMPTS = 3;
const CI_MAX_CHARS = 30_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** Nom complet d'un outil de ce serveur, tel que le voit le modèle. */
export const initToolName = (name: string) => `mcp__${INIT_MCP_SERVER_NAME}__${name}`;

export interface InitToolsDeps {
  info: ProjectInfo;
  prior?: ProjectConfig;
  /** Noms courts déjà pris par d'autres projets suivis. */
  takenNames: string[];
  /** Nom proposé par défaut (unique). */
  suggestedName: string;
  triggerLabel: string;
  listLabels: () => Promise<LabelInfo[]>;
  listStatuses: () => Promise<NativeStatus[]>;
  ciConfig: () => Promise<CiConfig>;
  findCheckouts: () => Promise<CheckoutSearch>;
  /** Le dossier est-il un checkout du projet ? */
  isCheckout: (dir: string) => Promise<boolean>;
  /** Fichiers ignorés présents dans un checkout du projet (noms seulement). */
  listIgnored: (checkout: string) => Promise<IgnoredListing>;
  probe: (tools: string[]) => Promise<string>;
  versionManagers: () => Promise<string>;
  verify: (input: VerifyInput, attempt: number) => Promise<VerificationReport>;
  say?: (s: string) => void;
}

/** État partagé avec l'orchestrateur : les vérifications réellement exécutées font foi, pas le récit de l'agent. */
export interface InitToolsState {
  reports: VerificationReport[];
  /** Tentatives refusées (plafond atteint, checkout invalide) : comptées pour information. */
  refusedCalls: number;
}

interface TextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const text = (t: string): TextResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): TextResult => ({ content: [{ type: "text", text: t }], isError: true });

async function guarded(action: string, fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(`Erreur (${action}) : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Images et versions déclarées dans une config CI (aide à la lecture, le YAML complet suit). */
export function ciImages(yaml: string): string[] {
  const found = new Set<string>();
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const inline = /^\s*(?:-\s*)?image:\s*["']?([^\s"'{}#]+)["']?\s*(?:#.*)?$/.exec(l);
    if (inline) found.add(inline[1]!);
    if (/^\s*(?:-\s*)?image:\s*$/.test(l)) {
      const name = /^\s*name:\s*["']?([^\s"']+)/.exec(lines[i + 1] ?? "");
      if (name) found.add(name[1]!);
    }
  }
  return [...found];
}

/** Définitions des outils (exportées pour tester les handlers sans démarrer le serveur). */
export function initTools(deps: InitToolsDeps, state: InitToolsState) {
  const say = deps.say ?? (() => {});
  const { info } = deps;

  const getProjectInfo = tool(
    "get_project_info",
    `Infos du projet GitLab ${info.pathWithNamespace} : chemin, branche par défaut, URL, nom court proposé, noms déjà pris, label déclencheur, et config SprintSaver actuelle du projet s'il en a une.`,
    {},
    async () =>
      guarded("get_project_info", async () => {
        const lines = [
          `Projet : ${info.pathWithNamespace} (id ${info.id})`,
          `Page : ${info.webUrl}`,
          `URL de clone : ${info.httpUrl}`,
          `Branche par défaut : ${info.defaultBranch}`,
          `Nom court proposé : ${deps.suggestedName}`,
          `Noms courts déjà pris par d'autres projets : ${deps.takenNames.length ? deps.takenNames.join(", ") : "aucun"}`,
          `Label déclencheur (créé par l'orchestrateur s'il manque) : ${deps.triggerLabel}`,
          "",
          deps.prior
            ? `Config SprintSaver actuelle du projet (à reprendre sauf si elle est fausse ou périmée) :\n${YAML.stringify(deps.prior).trimEnd()}`
            : "Pas de config SprintSaver actuelle pour ce projet.",
        ];
        return text(lines.join("\n"));
      }),
    { annotations: { ...READ_ONLY, openWorldHint: true, title: "Infos du projet" } },
  );

  const listLabels = tool(
    "list_labels",
    `Labels du projet ${info.pathWithNamespace}, y compris ceux des groupes parents.`,
    {},
    async () =>
      guarded("list_labels", async () => {
        const labels = await deps.listLabels();
        return text(labels.length ? labels.map((l) => l.name).join("\n") : "Aucun label.");
      }),
    { annotations: { ...READ_ONLY, openWorldHint: true, title: "Labels du projet" } },
  );

  const listStatuses = tool(
    "list_native_statuses",
    "Statuts natifs des work items disponibles sur le projet (champ Status de GitLab), avec leur id global.",
    {},
    async () =>
      guarded("list_native_statuses", async () => {
        const statuses = await deps.listStatuses();
        return text(
          statuses.length
            ? statuses.map((s) => `${s.id} — ${s.name}`).join("\n")
            : "Aucun statut natif disponible (instance ou tier sans statut des work items) : utilise des labels.",
        );
      }),
    { annotations: { ...READ_ONLY, openWorldHint: true, title: "Statuts natifs" } },
  );

  const analyseCi = tool(
    "analyse_ci",
    `Config CI de ${info.pathWithNamespace} sur ${info.defaultBranch} (includes développés quand GitLab le permet), avec les images utilisées et le type de pipeline déclenché par une MR.`,
    {},
    async () =>
      guarded("analyse_ci", async () => {
        const ci = await deps.ciConfig();
        if (ci.source === "none") return text("Pas de CI (.gitlab-ci.yml absent) : ciSource = branch.");
        const images = ciImages(ci.yaml);
        const yaml = ci.yaml.length > CI_MAX_CHARS ? `${ci.yaml.slice(0, CI_MAX_CHARS)}\n… (tronqué)` : ci.yaml;
        return text(
          [
            `Source : ${ci.source === "merged" ? "config fusionnée par GitLab (includes développés)" : ".gitlab-ci.yml brut (includes non développés)"}`,
            `Pipeline à surveiller selon l'heuristique : ${detectCiSource(ci.yaml)}`,
            `Images : ${images.length ? images.join(", ") : "aucune déclarée"}`,
            "",
            yaml,
          ].join("\n"),
        );
      }),
    { annotations: { ...READ_ONLY, openWorldHint: true, title: "Analyse de la CI" } },
  );

  const findCheckout = tool(
    "find_local_checkout",
    "Cherche sur la machine un checkout local de ce dépôt (dossiers usuels du dossier personnel, profondeur et durée bornées). C'est de là que l'orchestrateur copie les fichiers ignorés (.env…) et les dossiers de dépendances.",
    {},
    async () =>
      guarded("find_local_checkout", async () => {
        say("  Recherche d'un checkout local du dépôt…");
        const res = await deps.findCheckouts();
        const lines = [
          res.matches.length ? `Checkouts trouvés :\n${res.matches.map((m) => `  ${m}`).join("\n")}` : "Aucun checkout local trouvé.",
          `(${res.scanned} dossiers parcourus${res.truncated ? ", recherche arrêtée par son plafond : un checkout plus profond a pu échapper" : ""})`,
        ];
        return text(lines.join("\n"));
      }),
    { annotations: { ...READ_ONLY, title: "Checkout local" } },
  );

  const ignored = tool(
    "list_local_ignored_files",
    "Fichiers ignorés par git présents dans le checkout local de l'utilisateur (config d'environnement locale, secrets de dev, certificats…), qui n'existent pas dans un worktree neuf. Noms seulement : le contenu n'est jamais lu. Les dépendances et sorties de build sont exclues. Signale aussi les pendants ignorés de fichiers d'exemple versionnés (.env pour .env.example).",
    { local_checkout: z.string().min(1).describe("Checkout local du projet (trouvé par find_local_checkout)") },
    async (args) =>
      guarded("list_local_ignored_files", async () => {
        const dir = resolveHome(args.local_checkout.trim());
        if (!existsSync(dir) || !statSync(dir).isDirectory() || !(await deps.isCheckout(dir))) {
          return fail(`${dir} n'est pas un checkout de ${info.pathWithNamespace}.`);
        }
        say("  Fichiers ignorés du checkout local (noms seulement)…");
        const res = await deps.listIgnored(dir);
        const lines = [
          `Fichiers ignorés par git présents dans ${dir} (noms seulement, contenu jamais lu ; un nom terminé par / est un dossier entièrement ignoré) :`,
          ...(res.entries.length ? res.entries.map((e) => `  ${e}`) : ["  (aucun, hors dépendances et build)"]),
        ];
        if (res.truncated) lines.push(`  … liste coupée à ${res.entries.length} entrées.`);
        if (res.excluded) lines.push(`(${res.excluded} entrées de dépendances, build ou cache écartées.)`);
        lines.push(
          res.examplePairs.length
            ? `Pendants ignorés de fichiers d'exemple versionnés (à proposer dans worktreeInclude) :\n${res.examplePairs.map(([real, ex]) => `  ${real}  (exemple versionné : ${ex})`).join("\n")}`
            : "Aucun fichier d'exemple versionné n'a de pendant ignoré dans le checkout.",
        );
        return text(lines.join("\n"));
      }),
    { annotations: { ...READ_ONLY, title: "Fichiers ignorés du checkout" } },
  );

  const probe = tool(
    "probe_toolchains",
    "Sondes de version en lecture seule, lancées par l'orchestrateur : pour chaque outil demandé, toutes ses copies dans le PATH (la première est celle qu'une commande non qualifiée utilise), ses installations versionnées Homebrew et, pour Java sur macOS, les JDK de java_home.",
    {
      tools: z
        .array(z.string().min(1))
        .min(1)
        .max(15)
        .describe(`Outils à sonder, parmi : ${Object.keys(KNOWN_TOOLS).join(", ")}`),
    },
    async (args) =>
      guarded("probe_toolchains", async () => {
        say(`  Sondes de version : ${args.tools.join(", ")}`);
        return text(await deps.probe(args.tools));
      }),
    { annotations: { ...READ_ONLY, title: "Versions installées" } },
  );

  const managers = tool(
    "list_version_managers",
    "Gestionnaires de versions installés sur la machine (mise, asdf, fnm, volta, nvm, pyenv, uv, rbenv, jenv, sdkman, rustup…), les versions qu'ils ont déjà installées et comment les utiliser dans une commande non interactive.",
    {},
    async () =>
      guarded("list_version_managers", async () => {
        say("  Inventaire des gestionnaires de versions…");
        return text(await deps.versionManagers());
      }),
    { annotations: { ...READ_ONLY, title: "Gestionnaires de versions" } },
  );

  const verify = tool(
    "verify_commands",
    `Exécution réelle, par l'orchestrateur, des commandes proposées : worktree jetable de ${info.defaultBranch} préparé comme pour un ticket (fichiers ignorés copiés, dossiers de dépendances clonés depuis le checkout local), puis setup → test → build → test relancé avec timeout (le test juste après le setup comme dans un ticket, puis relancé dans le même worktree comme dans la boucle test/fix). Renvoie le verdict et un extrait utile de la sortie. ${MAX_VERIFY_ATTEMPTS} appels au plus pour tout le projet. Les commandes qui installent globalement, écrivent hors du worktree ou touchent au remote sont refusées sans être lancées.`,
    {
      setup_command: z.string().describe("Installation des dépendances (vide si rien)"),
      build_command: z.string().describe("Build (vide si aucun)"),
      test_command: z.string().describe("Suite de tests complète (vide si aucune)"),
      worktree_include: z.array(z.string()).describe("Fichiers ignorés par git à copier depuis le checkout local (motifs .gitignore)"),
      cow_dirs: z.array(z.string()).describe("Dossiers de dépendances à cloner en copy-on-write"),
      local_checkout: z.string().describe("Checkout local d'où copier fichiers ignorés et dépendances (vide si aucun)"),
    },
    async (args) =>
      guarded("verify_commands", async () => {
        if (state.reports.length >= MAX_VERIFY_ATTEMPTS) {
          state.refusedCalls++;
          return fail(
            `Plafond de ${MAX_VERIFY_ATTEMPTS} vérifications atteint : conclus avec la meilleure proposition, et décris dans la sortie ce qui reste cassé.`,
          );
        }
        const localCheckout = args.local_checkout.trim() ? resolveHome(args.local_checkout.trim()) : undefined;
        if (localCheckout) {
          const isDir = existsSync(localCheckout) && statSync(localCheckout).isDirectory();
          if (!isDir || !(await deps.isCheckout(localCheckout))) {
            state.refusedCalls++;
            return fail(`${localCheckout} n'est pas un checkout de ${info.pathWithNamespace} : passe un checkout trouvé par find_local_checkout, ou une chaîne vide.`);
          }
        }
        const attempt = state.reports.length + 1;
        say(`  Vérification ${attempt}/${MAX_VERIFY_ATTEMPTS} des commandes (worktree jetable de ${info.defaultBranch})…`);
        const input: VerifyInput = {
          setupCommand: args.setup_command.trim() || undefined,
          buildCommand: args.build_command.trim() || undefined,
          testCommand: args.test_command.trim() || undefined,
          worktreeInclude: args.worktree_include.map((s) => s.trim()).filter(Boolean),
          cowDirs: args.cow_dirs.map((s) => s.trim()).filter(Boolean),
          ...(localCheckout ? { localCheckout } : {}),
        };
        const report = await deps.verify(input, attempt);
        state.reports.push(report);
        const left = MAX_VERIFY_ATTEMPTS - state.reports.length;
        const hint =
          report.verdict === "passed"
            ? "Tout passe."
            : report.verdict === "baseline_red"
              ? "Le lanceur de tests tourne mais des tests échouent sur la branche par défaut. Vérifie dans l'extrait que ce sont de vrais échecs d'assertion (ligne de base rouge) et pas un problème d'environnement (version, module manquant, import) : dans ce dernier cas, la commande est cassée."
              : "Commande cassée : corrige-la (version de toolchain, commande, fichiers à copier) puis revérifie, ou déclare le prérequis manquant.";
        return text(`${formatReport(report)}\n\n${hint}\nVérifications restantes : ${left}.`);
      }),
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: "Vérifier les commandes" } },
  );

  return [getProjectInfo, listLabels, listStatuses, analyseCi, findCheckout, ignored, probe, managers, verify];
}

export function createInitServer(deps: InitToolsDeps, state: InitToolsState): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: INIT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions: `Données du projet GitLab ${deps.info.pathWithNamespace} et de la machine, pour proposer sa config SprintSaver. Aucune écriture sur GitLab n'est possible.`,
    tools: initTools(deps, state),
  });
}
