/** Description de MR (format ADR § 7). */
import type { Criterion, CriterionProof, Finding, TestEntry } from "../contracts.js";
import { lineDiff } from "./line-diff.js";
import { clip, codeSpan, escapeHtml, fenceFor, oneLine } from "./markdown.js";

/** Changement de contrat de données ou d'API, montré en diff avant/après. */
export interface DataChange {
  subject: string;
  kind: "endpoint" | "data";
  change: "added" | "modified" | "removed";
  before: string;
  after: string;
  note: string;
}

/** Paire de captures d'un écran, images déjà téléversées (markdown GitLab). */
export interface ScreenCapture {
  label: string;
  /** Markdown de l'image avant ; absent si l'écran n'existait pas. */
  beforeMarkdown?: string;
  /** Markdown de l'image après ; absent si la capture n'a pas pu être publiée. */
  afterMarkdown?: string;
  note: string;
}

export interface MrDescriptionInput {
  iid: number;
  issueUrl: string;
  summary: string;
  criteria: Criterion[];
  proofs: CriterionProof[];
  tests: TestEntry[];
  assumptions: string[];
  nits: Finding[];
  flakyJobs: string[];
  /** Pipeline resté en attente faute de runner : la CI n'a pas tourné sur le code livré. */
  ciNoRunnerPipelineUrl?: string;
  /** CI rouge acceptée manuellement (`run --accept-ci`). */
  ciAccepted?: boolean;
  /** Captures avant/après des écrans modifiés (changement d'interface). */
  captures?: ScreenCapture[];
  /** Changement d'interface sans captures complètes : pourquoi (une ligne). */
  capturesMissing?: string;
  /** Changements de données ou d'API, en diff avant/après. */
  dataChanges?: DataChange[];
  /** true tant que la MR est en Draft (ajoute une bannière "en cours"). */
  inProgress: boolean;
}

export const IN_PROGRESS_BANNER = "> 🚧 Travail en cours — SprintSaver itère encore sur cette MR.";

/** Longueurs visibles : la description se relit d'un coup d'œil, le détail reste dans le ticket et le diff. */
const CRITERION_CHARS = 140;
const REASON_CHARS = 160;
const NOTE_CHARS = 200;

export function renderMrDescription(input: MrDescriptionInput): string {
  const blocks: string[] = [];

  if (input.inProgress) blocks.push(IN_PROGRESS_BANNER);
  blocks.push(`Closes #${input.iid}`);
  blocks.push(input.summary.trim() || "_Pas de résumé._");

  const warnings = renderWarnings(input);
  if (warnings.length > 0) blocks.push(section("À vérifier", warnings));

  const captures = input.captures ?? [];
  const missing = oneLine(input.capturesMissing ?? "");
  if (captures.length > 0 || missing !== "") {
    const lines = captures.flatMap(renderCapture);
    if (missing !== "") lines.push("", `> Captures ${captures.length > 0 ? "incomplètes" : "non réalisées"} : ${clip(missing, NOTE_CHARS)}`);
    blocks.push(section("Captures", lines));
  }

  const dataChanges = input.dataChanges ?? [];
  if (dataChanges.length > 0) blocks.push(section("Changements d'API et de données", dataChanges.flatMap(renderDataChange)));
  blocks.push(renderCriteria(input.criteria, input.proofs));
  blocks.push(section("Tests", renderTests(input.tests)));

  const assumptions = input.assumptions.map(oneLine).filter((a) => a !== "");
  if (assumptions.length > 0) blocks.push(collapsible(`Hypothèses (${assumptions.length})`, assumptions.map((a) => `- ${a}`)));
  if (input.nits.length > 0) blocks.push(collapsible(`Nits restants (${input.nits.length})`, input.nits.map(renderNit)));

  return blocks.join("\n\n") + "\n";
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines].join("\n");
}

/** Bloc repliable GitLab : le titre reste visible, le détail s'ouvre au clic. */
function collapsible(summary: string, lines: string[]): string {
  return [`<details><summary>${escapeHtml(summary)}</summary>`, "", ...lines, "", "</details>"].join("\n");
}

/** Ce que la CI n'a pas garanti : en tête, pour que le relecteur ne le rate pas. */
function renderWarnings(input: MrDescriptionInput): string[] {
  const lines: string[] = [];
  if (input.ciAccepted) {
    lines.push("- **CI rouge acceptée manuellement** (`sprintsaver run --accept-ci`) : aucun pipeline vert sur ce code.");
  }
  const noRunner = oneLine(input.ciNoRunnerPipelineUrl ?? "");
  if (noRunner !== "") lines.push(`- **CI non exécutée** : aucun runner disponible ([pipeline](${noRunner})).`);
  const flaky = [...new Set(input.flakyJobs.map(oneLine).filter((j) => j !== ""))];
  if (flaky.length > 0) {
    lines.push(`- ${flaky.length > 1 ? "Jobs instables" : "Job instable"} : ${flaky.map((j) => codeSpan(j)).join(", ")} (vert à la 2ᵉ tentative).`);
  }
  return lines;
}

/** Critères : ce qui reste à vérifier est visible, les critères prouvés sont repliés avec leurs tests. */
function renderCriteria(criteria: Criterion[], proofs: CriterionProof[]): string {
  if (criteria.length === 0) return section("Critères", ["Aucun critère."]);
  const proofByIndex = new Map(proofs.map((p) => [p.index, p]));
  const sorted = [...criteria].sort((a, b) => a.index - b.index);
  const testable = sorted.filter((c) => c.testable !== false);
  const proven: string[] = [];
  const open: string[] = [];
  for (const criterion of sorted) {
    const text = clip(oneLine(criterion.text), CRITERION_CHARS);
    const proof = proofByIndex.get(criterion.index);
    if (criterion.testable !== false && proof?.proven) {
      const tests = proof.tests.map(codeSpan).join(", ");
      proven.push(`- [x] ${text}${tests !== "" ? ` → ${tests}` : ""}`);
    } else if (criterion.testable === false) {
      open.push(`- [ ] ${text} — à vérifier à la main : ${clip(oneLine(criterion.reason ?? ""), REASON_CHARS) || "raison non précisée"}`);
    } else {
      open.push(`- [ ] ${text} — non prouvé : ${clip(oneLine(proof?.reason ?? ""), REASON_CHARS) || "aucun test ne le prouve"}`);
    }
  }
  const title = testable.length > 0 ? `Critères : ${proven.length}/${testable.length} prouvés` : "Critères";
  const parts = [section(title, open)];
  if (proven.length > 0) parts.push(collapsible(`Critères prouvés (${proven.length})`, proven));
  return parts.join("\n\n");
}

/** Une ligne par fichier de test : le nom des tests se lit dans le diff. */
function renderTests(tests: TestEntry[]): string[] {
  if (tests.length === 0) return ["Aucun test ajouté ou modifié."];
  const byFile = new Map<string, { added: number; modified: number }>();
  for (const t of tests) {
    const n = byFile.get(t.file) ?? { added: 0, modified: 0 };
    if (t.change === "added") n.added += 1;
    else n.modified += 1;
    byFile.set(t.file, n);
  }
  return [...byFile].map(([file, n]) => {
    const parts = [
      n.added > 0 ? `${n.added} ajouté${n.added > 1 ? "s" : ""}` : "",
      n.modified > 0 ? `${n.modified} modifié${n.modified > 1 ? "s" : ""}` : "",
    ].filter((p) => p !== "");
    return `- ${codeSpan(file)} : ${parts.join(", ")}`;
  });
}

function renderCapture(capture: ScreenCapture): string[] {
  const before = capture.beforeMarkdown ?? "_écran inexistant avant ce changement_";
  const after = capture.afterMarkdown ?? "_capture indisponible_";
  const lines = ["", `### ${oneLine(capture.label) || "Écran"}`, "", "| Avant | Après |", "|---|---|", `| ${before} | ${after} |`];
  const note = clip(oneLine(capture.note), NOTE_CHARS);
  if (note !== "") lines.push("", note);
  return lines;
}

const DATA_KIND_LABELS: Record<DataChange["kind"], string> = { endpoint: "API", data: "données" };
const DATA_CHANGE_LABELS: Record<DataChange["change"], string> = { added: "ajouté", modified: "modifié", removed: "supprimé" };

function renderDataChange(change: DataChange): string[] {
  const before = change.change === "added" ? "" : change.before;
  const after = change.change === "removed" ? "" : change.after;
  const diff = lineDiff(before, after);
  const lines = ["", `### ${codeSpan(change.subject)} (${DATA_KIND_LABELS[change.kind]}, ${DATA_CHANGE_LABELS[change.change]})`];
  const note = clip(oneLine(change.note), NOTE_CHARS);
  if (note !== "") lines.push("", note);
  if (diff.length > 0) {
    const fence = fenceFor(diff.join("\n"));
    lines.push("", `${fence}diff`, ...diff, fence);
  }
  return lines;
}

function renderNit(nit: Finding): string {
  const location = nit.file ? codeSpan(nit.line !== undefined ? `${nit.file}:${nit.line}` : nit.file) + " " : "";
  return `- ${location}${oneLine(nit.description)}`;
}
