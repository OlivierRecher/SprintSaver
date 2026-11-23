/**
 * Construction des prompts de chaque phase agent (fonctions pures).
 *
 * - `context` : ajouté au prompt système après les skills. Il décrit le ticket courant (et seulement lui,
 *   ADR § 10), les critères indexés et, selon la phase, l'analyse.
 * - `prompt` : message utilisateur de la session = consigne de la phase + données propres à l'itération
 *   (sortie de tests, findings, diff, logs), tronquées raisonnablement.
 *
 * Les sessions de review et de vérification des critères sont indépendantes : elles ne reçoivent jamais
 * le résumé de l'implémenteur.
 */
import type {
  AnalysisResult,
  Criterion,
  CriterionProof,
  Finding,
  Issue,
  Note,
  PhaseSummary,
  TestEntry,
} from "../contracts.js";
import type { TicketType } from "../config/schema.js";

export const MAX_DIFF_CHARS = 80_000;
export const MAX_LOG_CHARS = 20_000;
export const MAX_LINKED_DESCRIPTION_CHARS = 4_000;

export interface PromptBundle {
  prompt: string;
  context: string;
}

/** Données du ticket courant, relues sur GitLab (le ticket est considéré gelé pendant le traitement). */
export interface TicketContext {
  issue: Issue;
  notes: Note[];
  linked: Issue[];
  /** Chemins des images téléchargées, relatifs au worktree. */
  imagePaths: string[];
  /** Images référencées par le ticket mais non téléchargées (URL, statut éventuel). */
  imagesFailed?: string[];
  /** Dépôt de travail : branche du ticket et branche par défaut (base des diffs et du rebase). */
  repo: {
    branch: string;
    defaultBranch: string;
    /** Commande de test du projet (config). */
    testCommand?: string;
    /** Commande de build du projet (config). */
    buildCommand?: string;
    /** `local` (défaut) ou `ci-only` : les tests ne peuvent pas tourner en local, la CI fait foi. */
    testMode?: "local" | "ci-only";
  };
}

/** Case à cocher brute (avant analyse). */
export interface RawCriterion {
  index: number;
  text: string;
  checked: boolean;
}

// ---------------------------------------------------------------------------
// Troncatures
// ---------------------------------------------------------------------------

/** Garde le début du texte (diffs : les premiers fichiers sont les plus lisibles). */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n\n[… tronqué : ${dropped} caractères supprimés à la fin]`;
}

/** Garde la fin du texte (logs, sorties de tests : l'erreur est en bas). */
export function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `[… tronqué : ${dropped} caractères supprimés au début]\n\n${text.slice(text.length - max)}`;
}

// ---------------------------------------------------------------------------
// Diffs envoyés aux sessions
// ---------------------------------------------------------------------------

/** Lockfiles et fichiers générés : leur diff est remplacé par une ligne (bruit, et il mange le budget). */
const GENERATED_FILES: RegExp[] = [
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(?:^|\/)(?:Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json|mix\.lock|pubspec\.lock)$/,
  /\.min\.(?:js|css|mjs)$/,
  /\.(?:js|css)\.map$/,
  /(?:^|\/)dist\//,
];
/** Snapshots : omis seulement s'ils sont volumineux. */
const SNAPSHOT_FILE = /\.snap$/;
export const MAX_SNAPSHOT_DIFF_CHARS = 10_000;
const MAX_LISTED_FILES = 300;

export interface FileDiff {
  path: string;
  text: string;
}

/** Découpe un diff unifié git par fichier (le préambule éventuel est rattaché à un chemin vide). */
export function splitDiffByFile(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    if (chunk === "") continue;
    const first = chunk.slice(0, chunk.indexOf("\n") === -1 ? chunk.length : chunk.indexOf("\n"));
    const m = /^diff --git (?:"?a\/)?(.*?)"? (?:"?b\/)(.*?)"?$/.exec(first);
    out.push({ path: m ? (m[2] ?? m[1] ?? "") : "", text: chunk });
  }
  return out;
}

/** Fichiers touchés par un diff unifié git. */
export function diffFiles(diff: string): string[] {
  return splitDiffByFile(diff)
    .map((f) => f.path)
    .filter((p) => p !== "");
}

export function isGeneratedFile(path: string, diffChars = 0): boolean {
  if (GENERATED_FILES.some((re) => re.test(path))) return true;
  return SNAPSHOT_FILE.test(path) && diffChars > MAX_SNAPSHOT_DIFF_CHARS;
}

/**
 * Section « Diff » d'un prompt : lockfiles et fichiers générés remplacés par une ligne ; si le diff reste
 * trop long, il est tronqué et suivi de la liste des fichiers modifiés et de la commande pour lire le reste.
 */
export function diffSection(diff: string, defaultBranch: string, max = MAX_DIFF_CHARS): string {
  const files = splitDiffByFile(diff);
  const omitted: string[] = [];
  const kept = files.map((f) => {
    if (f.path && isGeneratedFile(f.path, f.text.length)) {
      omitted.push(f.path);
      return `diff --git a/${f.path} b/${f.path}\n# fichier ${f.path} modifié (diff omis : lockfile ou fichier généré)\n`;
    }
    return f.text;
  });
  const filtered = kept.join("");
  const lines = ["## Diff", "", fenced(truncateHead(filtered, max), "diff")];
  if (omitted.length > 0) {
    lines.push("", `Diff omis (lockfiles / fichiers générés) : ${omitted.map((p) => `\`${p}\``).join(", ")}.`);
  }
  if (filtered.length > max) {
    const paths = files.map((f) => f.path).filter((p) => p !== "");
    lines.push(
      "",
      `## Fichiers modifiés (${paths.length}) — le diff ci-dessus est tronqué`,
      "",
      ...paths.slice(0, MAX_LISTED_FILES).map((p) => `- ${p}`),
      ...(paths.length > MAX_LISTED_FILES ? [`- … et ${paths.length - MAX_LISTED_FILES} autre(s)`] : []),
      "",
      `Pour lire le diff d'un fichier non affiché : \`git diff origin/${defaultBranch}...HEAD -- <fichier>\`.`,
    );
  }
  return lines.join("\n");
}

function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Blocs de contexte
// ---------------------------------------------------------------------------

export function ticketBlock(ticket: TicketContext): string {
  const { issue, notes, linked, imagePaths, repo } = ticket;
  const out: string[] = [];
  out.push("# Dépôt", "");
  out.push(`Branche de travail : \`${repo.branch}\``);
  out.push(`Branche par défaut : \`${repo.defaultBranch}\` (base : \`origin/${repo.defaultBranch}\`)`);
  const ciOnly = repo.testMode === "ci-only";
  out.push(
    `Mode de test : ${ciOnly ? "`ci-only` (les tests ne peuvent pas tourner en local : la CI fait foi)" : "`local`"}`,
  );
  if (repo.testCommand) out.push(`Commande de test : \`${repo.testCommand}\`${ciOnly ? " (exécutée par la CI)" : ""}`);
  else out.push("Commande de test : non configurée (repère-la dans le dépôt si besoin)");
  if (repo.buildCommand) out.push(`Commande de build : \`${repo.buildCommand}\``);
  out.push("Fichiers temporaires : `.sprintsaver/tmp/` (exclu de git).", "");
  out.push(`# Ticket #${issue.iid} : ${issue.title}`);
  out.push(`URL : ${issue.webUrl}`);
  out.push(`Auteur : @${issue.authorUsername}`);
  if (issue.labels.length > 0) out.push(`Labels : ${issue.labels.join(", ")}`);
  out.push(`Type GitLab : ${issue.issueType}`);
  out.push("", "## Description", "", issue.description.trim() || "(vide)");

  out.push("", `## Commentaires (${notes.length})`);
  if (notes.length === 0) out.push("", "(aucun)");
  for (const note of notes) {
    out.push("", `### @${note.authorUsername} — ${note.createdAt}`, "", note.body.trim());
  }

  if (linked.length > 0) {
    out.push("", "## Tickets liés (un niveau)");
    for (const l of linked) {
      out.push(
        "",
        `### #${l.iid} ${l.title} (${l.state}) — ${l.webUrl}`,
        "",
        truncateHead(l.description.trim() || "(vide)", MAX_LINKED_DESCRIPTION_CHARS),
      );
    }
  }

  if (imagePaths.length > 0) {
    out.push("", "## Images jointes (chemins relatifs au dépôt, à ouvrir avec l'outil Read)");
    for (const p of imagePaths) out.push(`- ${p}`);
  }
  if (ticket.imagesFailed && ticket.imagesFailed.length > 0) {
    out.push(
      "",
      "## Images non téléchargées",
      "",
      "Ces images sont référencées par le ticket mais n'ont pas pu être récupérées : tu ne peux pas les voir.",
      "Si leur contenu est nécessaire pour comprendre le besoin, dis-le (hypothèse documentée ou question bloquante).",
      ...ticket.imagesFailed.map((u) => `- ${u}`),
    );
  }
  return out.join("\n");
}

function criterionLine(c: Criterion | RawCriterion): string {
  const base = `- [${c.index}] ${c.text}`;
  if (!("testable" in c) || c.testable === undefined) return base;
  return c.testable
    ? `${base}\n  → testable${c.reason ? ` : ${c.reason}` : ""}`
    : `${base}\n  → non testable${c.reason ? ` : ${c.reason}` : ""}`;
}

export function criteriaBlock(criteria: (Criterion | RawCriterion)[]): string {
  const lines = ["# Critères d'acceptation (cases à cocher du ticket, index stables)"];
  if (criteria.length === 0) lines.push("", "(aucun)");
  else lines.push("", ...criteria.map(criterionLine));
  return lines.join("\n");
}

export function analysisBlock(analysis: AnalysisResult): string {
  const out: string[] = ["# Analyse du ticket"];
  out.push("", `Type retenu : ${analysis.type} (source : ${analysis.typeSource})`);
  out.push("", "## Résumé", "", analysis.summary.trim());
  if (analysis.plan.length > 0) {
    out.push("", "## Plan", "", ...analysis.plan.map((s, i) => `${i + 1}. ${s}`));
  }
  if (analysis.assumptions.length > 0) {
    out.push("", "## Hypothèses retenues", "", ...analysis.assumptions.map((a) => `- ${a}`));
  }
  const relevant = analysis.precedents.filter((p) => p.relevant);
  if (relevant.length > 0) {
    out.push("", "## Précédents retenus", "", ...relevant.map((p) => `- ${p.ref} : ${p.why}`));
  }
  return out.join("\n");
}

export function testsBlock(tests: TestEntry[], title = "# Tests écrits pour ce ticket"): string {
  const lines = [title];
  if (tests.length === 0) lines.push("", "(aucun)");
  for (const t of tests) {
    const crit = t.criteria.length > 0 ? ` — critères ${t.criteria.map((i) => `[${i}]`).join(", ")}` : "";
    lines.push(`- \`${t.name}\` (${t.file}, ${t.change === "added" ? "ajouté" : "modifié"})${crit} : ${t.explanation}`);
  }
  return lines.join("\n");
}

function findingLine(f: Finding, i: number): string {
  const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
  return `${i + 1}. [${f.category}]${loc} ${f.description}`;
}

function testableCriteria(analysis: AnalysisResult): Criterion[] {
  return analysis.criteria.filter((c) => c.testable === true);
}

function join(...blocks: (string | null | undefined | false)[]): string {
  return blocks.filter((b): b is string => typeof b === "string" && b.trim() !== "").join("\n\n---\n\n");
}

function engineeringContext(ticket: TicketContext, analysis: AnalysisResult, tests?: TestEntry[]): string {
  return join(ticketBlock(ticket), criteriaBlock(analysis.criteria), analysisBlock(analysis), tests && testsBlock(tests));
}

function isCiOnly(ticket: TicketContext): boolean {
  return ticket.repo.testMode === "ci-only";
}

/**
 * Bloc « Travail existant sur la branche » (reprise d'un ticket bloqué) : commits du ticket déjà présents,
 * `git log --oneline origin/<défaut>..HEAD` au moment de la préparation.
 */
export function existingWorkBlock(commits: string[] | undefined, defaultBranch: string, phase: "write-tests" | "implement"): string | null {
  if (!commits || commits.length === 0) return null;
  const lines = [
    "## Travail existant sur la branche",
    "",
    `La branche contient déjà des commits de ce ticket (\`git log --oneline origin/${defaultBranch}..HEAD\`) :`,
    "",
    ...commits.map((c) => `- ${c}`),
    "",
    "Complète ou ajuste ce travail ; ne le réécris pas et ne supprime pas ce qui fonctionne.",
  ];
  lines.push(
    phase === "write-tests"
      ? "Red-first seulement pour les critères qui ne sont pas encore couverts par un test existant : pour ceux déjà couverts (et déjà implémentés), garde et ajuste les tests existants sans exiger qu'ils échouent, et déclare-les dans `tests` avec `change: \"modified\"` ou `\"added\"` selon le cas."
      : "Repars du code existant : corrige ou complète ce qui manque pour faire passer les tests, sans tout réimplémenter.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export function buildAnalysePrompt(input: {
  ticket: TicketContext;
  criteria: RawCriterion[];
  /** Type déjà tranché par les labels ou le type GitLab ; null si c'est à l'agent de décider. */
  typeHint: { type: TicketType; source: "labels" | "issue_type" } | null;
}): PromptBundle {
  const typeLine = input.typeHint
    ? `Le type du ticket est déjà fixé à « ${input.typeHint.type} » (source : ${input.typeHint.source}). Reporte-le tel quel dans \`type\`.`
    : "Le type du ticket n'est pas déterminé par ses labels : décide-le (`bug` pour un défaut du comportement existant, sinon `feature`).";
  const prompt = [
    "Phase : analyse du ticket décrit dans le contexte.",
    "",
    "1. Lis la description, tous les commentaires, les images jointes et les tickets liés.",
    "2. Cherche des précédents (tickets fermés, MR mergées, historique git) selon ton skill, et juge leur pertinence.",
    `3. Classe chacune des ${input.criteria.length} cases à cocher (index 0 à ${Math.max(0, input.criteria.length - 1)}) en testable ou non testable, avec une raison d'une ligne. Une entrée par index, sans en omettre.`,
    "4. Rédige un plan court et liste les hypothèses prises sur les ambiguïtés mineures.",
    "5. Ne pose une question bloquante que si, sans réponse, l'implémentation risque d'être fausse. Sinon, prends une hypothèse.",
    "",
    typeLine,
    "",
    "Ne modifie aucun fichier du dépôt pendant cette phase.",
  ].join("\n");
  return { prompt, context: join(ticketBlock(input.ticket), criteriaBlock(input.criteria)) };
}

export function buildWriteTestsPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  /** Commits du ticket déjà sur la branche (reprise après blocage). */
  existingWork?: string[];
}): PromptBundle {
  const testable = testableCriteria(input.analysis);
  const ciOnly = isCiOnly(input.ticket);
  const lines = [
    "Phase : écriture des tests, avant toute implémentation (red-first).",
    "",
    `Écris des tests qui prouvent les critères testables suivants : ${testable.map((c) => `[${c.index}]`).join(", ")}.`,
    input.analysis.type === "bug"
      ? "C'est un bug : commence par un test qui reproduit le défaut."
      : "C'est une fonctionnalité : chaque test doit asserter le comportement attendu par le critère.",
    ciOnly
      ? "Projet en mode `ci-only` : les tests ne peuvent pas tourner en local, n'essaie pas d'obtenir une preuve d'échec locale. Dans `redEvidence`, donne à la place le raisonnement qui montre que chaque nouveau test échoue sans l'implémentation (ce qu'il asserte et pourquoi le code actuel ne le satisfait pas). Vérifie au moins que le code compile ou se charge si c'est possible sans lancer la suite."
      : "Lance les nouveaux tests et vérifie qu'ils échouent pour la bonne raison (pas d'erreur de compilation ou d'import).",
    "N'implémente pas le code de production. Ne commite pas : l'orchestrateur s'en charge.",
    "Indique pour chaque test les index des critères qu'il prouve.",
  ];
  const existing = existingWorkBlock(input.existingWork, input.ticket.repo.defaultBranch, "write-tests");
  if (existing) lines.push("", existing);
  return { prompt: lines.join("\n"), context: engineeringContext(input.ticket, input.analysis) };
}

export function buildImplementPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  tests: TestEntry[];
  /** Commits du ticket déjà sur la branche (reprise après blocage). */
  existingWork?: string[];
}): PromptBundle {
  const lines = [
    "Phase : implémentation.",
    "",
    "Implémente le changement décrit par le ticket et l'analyse, de façon à faire passer les tests listés dans le contexte sans les affaiblir.",
    isCiOnly(input.ticket)
      ? "Projet en mode `ci-only` : la suite ne peut pas tourner en local (la CI fera foi). Relis soigneusement le code et les tests, et vérifie au moins la compilation ou le build si c'est possible. Si tu dois ajuster ou ajouter un test, déclare-le dans `testsAdjusted`."
      : "Lance la suite de tests du projet. Si tu dois ajuster ou ajouter un test, déclare-le dans `testsAdjusted`.",
    "Ne commite pas : l'orchestrateur s'en charge.",
  ];
  const existing = existingWorkBlock(input.existingWork, input.ticket.repo.defaultBranch, "implement");
  if (existing) lines.push("", existing);
  return { prompt: lines.join("\n"), context: engineeringContext(input.ticket, input.analysis, input.tests) };
}

export function buildTestFixPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  tests: TestEntry[];
  command: string;
  output: string;
  exitCode: number;
  timedOut: boolean;
  iteration: number;
}): PromptBundle {
  const status = input.timedOut ? "a dépassé le délai imparti" : `a échoué (code de sortie ${input.exitCode})`;
  const prompt = [
    `Phase : correction des tests (itération ${input.iteration}).`,
    "",
    `La commande de test \`${input.command}\` ${status}. Fin de la sortie :`,
    "",
    fenced(truncateTail(input.output, MAX_LOG_CHARS)),
    "",
    "Trouve la cause et corrige le code (ou le test s'il est faux par rapport au critère, sans l'affaiblir).",
    "Relance les tests concernés pour vérifier. Si l'échec est sans rapport avec le ticket, dis-le dans `unrelatedToTicket`.",
    "Ne commite pas : l'orchestrateur s'en charge.",
  ].join("\n");
  return { prompt, context: engineeringContext(input.ticket, input.analysis, input.tests) };
}

export type ReviewMode = "full" | "delta" | "rebase";

export function buildReviewPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  diff: string;
  mode: ReviewMode;
  /** Fichiers en conflit résolus lors d'un rebase (mode "rebase"). */
  conflictedFiles?: string[];
}): PromptBundle {
  const scope =
    input.mode === "full"
      ? "Voici le diff complet de la branche par rapport à la branche par défaut."
      : input.mode === "delta"
        ? "Voici uniquement le delta ajouté depuis la dernière review (correctifs de CI ou de review). Le reste a déjà été relu."
        : `La branche vient d'être rebasée et des conflits ont été résolus dans : ${(input.conflictedFiles ?? []).join(", ") || "(non précisé)"}. Voici le diff de la branche par rapport à la nouvelle base ; concentre-toi sur la résolution de ces conflits.`;
  const prompt = [
    "Phase : review indépendante. Tu n'as pas écrit ce code.",
    "",
    scope,
    "",
    "Classe chaque finding :",
    "- `blocking` : bug, critère du ticket non couvert, faille de sécurité, régression ;",
    "- `nit` : tout le reste (style, lisibilité, perf mineure…).",
    "Décris pour chaque bloquant le scénario concret qui le déclenche. Ne modifie aucun fichier.",
    "",
    diffSection(input.diff, input.ticket.repo.defaultBranch),
  ].join("\n");
  return { prompt, context: join(ticketBlock(input.ticket), criteriaBlock(input.analysis.criteria), analysisBlock(input.analysis)) };
}

export function buildVerifyCriteriaPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  tests: TestEntry[];
}): PromptBundle {
  const testable = testableCriteria(input.analysis);
  const lines = [
    "Phase : vérification indépendante des critères.",
    "",
    "Pour chaque critère testable ci-dessous, ouvre les tests associés et vérifie qu'au moins un test asserte réellement ce critère",
    "(pas seulement qu'il exécute le code). Un critère n'est prouvé que si c'est le cas. Ne modifie aucun fichier.",
    "",
    "## Critères testables et tests associés",
  ];
  for (const c of testable) {
    const linked = input.tests.filter((t) => t.criteria.includes(c.index));
    lines.push("", `- [${c.index}] ${c.text}`);
    if (linked.length === 0) lines.push("  - aucun test déclaré : cherche dans le diff s'il en existe un, sinon le critère n'est pas prouvé");
    for (const t of linked) lines.push(`  - \`${t.name}\` (${t.file}) : ${t.explanation}`);
  }
  lines.push("", "Réponds avec une entrée par critère testable, même index.");
  return {
    prompt: lines.join("\n"),
    context: join(ticketBlock(input.ticket), criteriaBlock(input.analysis.criteria)),
  };
}

export function buildReviewFixPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  tests: TestEntry[];
  findings: Finding[];
  iteration: number;
}): PromptBundle {
  const prompt = [
    `Phase : correction des retours de review (itération ${input.iteration}).`,
    "",
    "Une review indépendante a relevé ces problèmes bloquants :",
    "",
    ...input.findings.map(findingLine),
    "",
    "Corrige chacun d'eux. Pour un critère non prouvé, ajoute ou renforce un test qui l'asserte réellement et déclare-le dans `testsAdjusted`.",
    "Relance les tests concernés. Ne commite pas : l'orchestrateur s'en charge.",
  ].join("\n");
  return { prompt, context: engineeringContext(input.ticket, input.analysis, input.tests) };
}

export function buildCiFixPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  tests: TestEntry[];
  pipelineUrl: string;
  jobs: { name: string; stage: string; webUrl: string; log: string }[];
  iteration: number;
}): PromptBundle {
  const perJob = Math.max(2_000, Math.floor(MAX_LOG_CHARS / Math.max(1, input.jobs.length)));
  const lines = [
    `Phase : correction de la CI (itération ${input.iteration}).`,
    "",
    `Le pipeline ${input.pipelineUrl} a échoué, même après une relance des jobs en échec. La CI de la branche par défaut est verte.`,
    "",
  ];
  for (const job of input.jobs) {
    lines.push(`## Job \`${job.name}\` (stage ${job.stage}) — ${job.webUrl}`, "", fenced(truncateTail(job.log, perJob)), "");
  }
  lines.push(
    "Trouve la cause et corrige-la dans le dépôt. Reproduis localement si possible.",
    "Si l'échec est sans rapport avec le ticket (environnement, runner, dépendance externe), dis-le dans `unrelatedToTicket`.",
    "Ne commite pas et ne pousse pas : l'orchestrateur s'en charge.",
  );
  return { prompt: lines.join("\n"), context: engineeringContext(input.ticket, input.analysis, input.tests) };
}

export function buildRebaseFixPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  defaultBranch: string;
  conflictedFiles: string[];
  attempt: number;
}): PromptBundle {
  const prompt = [
    `Phase : résolution de conflits de rebase (tentative ${input.attempt}).`,
    "",
    `Un rebase sur origin/${input.defaultBranch} est en cours et s'est arrêté sur des conflits dans :`,
    ...input.conflictedFiles.map((f) => `- ${f}`),
    "",
    "Résous chaque conflit en conservant à la fois l'intention du ticket et les changements de la branche par défaut.",
    "Retire tous les marqueurs de conflit. N'exécute ni `git rebase --continue` ni `--abort`, ne commite pas : l'orchestrateur s'en charge.",
  ].join("\n");
  return { prompt, context: engineeringContext(input.ticket, input.analysis) };
}

export function buildMrWriteupPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  tests: TestEntry[];
  proofs: CriterionProof[];
  nits: Finding[];
  diff: string;
}): PromptBundle {
  const proven = input.proofs.filter((p) => p.proven).map((p) => `[${p.index}]`);
  const prompt = [
    "Phase : rédaction de la merge request.",
    "",
    "Propose un titre concis (sans préfixe Draft ni numéro de ticket : l'orchestrateur ajoute « (#iid) ») et un résumé de 3 à 6 lignes destiné au relecteur :",
    "ce qui change, pourquoi, et où regarder en priorité. Les critères, tests et nits sont rendus par l'orchestrateur, ne les recopie pas.",
    "",
    "Classe aussi le changement (`changeKinds`) d'après le diff :",
    "- `ui` : le rendu d'un écran de l'application de CE dépôt change (pas une bibliothèque sans application). Liste alors dans `uiScreens` les écrans à capturer avant/après (une autre session fera les captures) ;",
    "- `data` ou `endpoint` : un format de données ou un contrat d'API change. Décris alors chaque contrat dans `dataChanges` avec un exemple avant et le même exemple après,",
    "  tirés du code et des tests (vrais noms de champs, de routes, de colonnes). L'orchestrateur en fait un diff ligne à ligne dans la MR.",
    "Un changement purement interne (refactor, logique sans effet visible sur un écran ni sur un contrat) n'a aucune de ces natures.",
    "",
    `Critères prouvés : ${proven.join(", ") || "aucun"}. Nits restants : ${input.nits.length}.`,
    "",
    diffSection(input.diff, input.ticket.repo.defaultBranch),
  ].join("\n");
  return { prompt, context: engineeringContext(input.ticket, input.analysis, input.tests) };
}

export function buildUiCapturesPrompt(input: {
  ticket: TicketContext;
  analysis: AnalysisResult;
  screens: { label: string; howToReach: string }[];
  /** Worktree détaché sur la base du ticket (état AVANT), chemin absolu. */
  basePath: string;
  /** Dossier où écrire les captures, relatif au worktree. */
  capturesDir: string;
  diff: string;
}): PromptBundle {
  const lines = [
    "Phase : captures d'écran avant/après pour la merge request.",
    "",
    "Le code du ticket est terminé, relu et validé par la CI. Tu ne modifies aucun fichier source : tu lances l'application et tu captures.",
    "",
    `- APRÈS : le répertoire courant (worktree du ticket).`,
    `- AVANT : ${input.basePath} (même dépôt, sur la base du ticket, dépendances et fichiers locaux préparés). Tu peux y écrire (build, cache).`,
    `- Écris chaque capture en PNG dans \`${input.capturesDir}/\` du répertoire courant, nommée \`<n>-avant.png\` et \`<n>-apres.png\`.`,
    "- Même viewport, mêmes données et même parcours pour l'avant et l'après : seule la version du code doit différer.",
    "- Arrête tous les serveurs que tu as lancés avant de terminer.",
    "",
    "## Écrans à capturer",
    "",
    ...input.screens.map((screen, i) => `${i + 1}. ${screen.label} — ${screen.howToReach}`),
    "",
    "Si un écran ne peut pas être capturé, n'insiste pas au-delà de quelques tentatives : renseigne `skippedReason`.",
    "",
    diffSection(input.diff, input.ticket.repo.defaultBranch),
  ];
  return { prompt: lines.join("\n"), context: engineeringContext(input.ticket, input.analysis) };
}

export function buildRetroPrompt(input: {
  projectName: string;
  outcome: "finalized" | "blocked";
  blockedReason?: string;
  summaries: PhaseSummary[];
  /** Contenu actuel de skills/projects/<projet>.md, ou null s'il n'existe pas. */
  projectSkill: string | null;
}): PromptBundle {
  const lines = [
    "Phase : rétrospective sur le traitement d'un ticket.",
    "",
    `Projet : ${input.projectName}`,
    `Issue : ${input.outcome === "finalized" ? "livré (MR prête)" : `bloqué — ${input.blockedReason ?? "raison inconnue"}`}`,
    "",
    "À partir des seuls résumés factuels ci-dessous, identifie ce qui a coûté des itérations et ce qu'il aurait fallu savoir.",
    "Propose si utile un patch (diff unifié applicable avec `git apply` à la racine du dépôt SprintSaver) sur `skills/`,",
    `en priorité sur \`skills/projects/${input.projectName}.md\`. Le patch doit être général : aucune donnée propre à ce ticket.`,
    "N'applique pas le patch toi-même.",
    "",
    "## Résumés de phase",
    "",
  ];
  if (input.summaries.length === 0) lines.push("(aucun)");
  for (const s of input.summaries) {
    const meta = [
      `itération ${s.iteration}`,
      `issue ${s.outcome}`,
      `${Math.round(s.durationMs / 1000)} s`,
      s.numTurns !== undefined ? `${s.numTurns} tours` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`### ${s.phase} (${meta})`);
    for (const f of s.facts) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push(`## Contenu actuel de skills/projects/${input.projectName}.md`, "");
  lines.push(input.projectSkill === null ? "(fichier absent : tu peux le créer dans le patch)" : fenced(input.projectSkill, "markdown"));
  return { prompt: lines.join("\n"), context: "" };
}
