/** Description de MR (format ADR § 7). */
import type { Criterion, CriterionProof, Finding, TestEntry } from "../contracts.js";
import { lineDiff } from "./line-diff.js";
import { codeSpan, oneLine } from "./markdown.js";

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

export function renderMrDescription(input: MrDescriptionInput): string {
  const blocks: string[] = [];

  if (input.inProgress) blocks.push(IN_PROGRESS_BANNER);
  blocks.push(`Closes #${input.iid}`);
  blocks.push(section("Résumé", [input.summary.trim() || "_Pas de résumé._"]));

  const captures = input.captures ?? [];
  const missing = oneLine(input.capturesMissing ?? "");
  if (captures.length > 0 || missing !== "") {
    const lines = captures.flatMap(renderCapture);
    if (missing !== "") lines.push("", `> Captures ${captures.length > 0 ? "incomplètes" : "non réalisées"} : ${missing}`);
    blocks.push(section("Captures avant / après", lines));
  }

  const dataChanges = input.dataChanges ?? [];
  if (dataChanges.length > 0) blocks.push(section("Changements de données et d'API", dataChanges.flatMap(renderDataChange)));
  blocks.push(section("Critères", renderCriteria(input.criteria, input.proofs)));
  blocks.push(
    section("Tests ajoutés / modifiés", input.tests.length > 0 ? input.tests.map(renderTest) : ["Aucun test ajouté ou modifié."]),
  );

  const assumptions = input.assumptions.map(oneLine).filter((a) => a !== "");
  if (assumptions.length > 0) blocks.push(section("Hypothèses", assumptions.map((a) => `- ${a}`)));

  if (input.nits.length > 0) blocks.push(section("Nits restants", input.nits.map(renderNit)));

  const flaky = [...new Set(input.flakyJobs.map(oneLine).filter((j) => j !== ""))];
  if (flaky.length > 0) {
    blocks.push(section("Jobs CI instables", flaky.map((job) => `- ${codeSpan(job)} : passé à la 2ᵉ tentative`)));
  }

  return blocks.join("\n\n") + "\n";
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines].join("\n");
}

function renderCriteria(criteria: Criterion[], proofs: CriterionProof[]): string[] {
  if (criteria.length === 0) return ["Aucun critère."];
  const proofByIndex = new Map(proofs.map((p) => [p.index, p]));
  return [...criteria]
    .sort((a, b) => a.index - b.index)
    .map((criterion) => {
      const text = oneLine(criterion.text);
      const proof = proofByIndex.get(criterion.index);

      if (proof?.proven) {
        const tests = proof.tests.map(codeSpan).join(", ");
        const reason = oneLine(proof.reason);
        let line = `- [x] ${text}`;
        if (tests !== "") line += ` → ${tests}`;
        if (reason !== "") line += ` : ${reason}`;
        return line;
      }
      if (criterion.testable === false) {
        return `- [ ] ${text} (non testable : ${oneLine(criterion.reason ?? "") || "raison non précisée"})`;
      }
      return `- [ ] ${text} (non prouvé : ${oneLine(proof?.reason ?? "") || "aucun test ne le prouve"})`;
    });
}

function renderCapture(capture: ScreenCapture): string[] {
  const before = capture.beforeMarkdown ?? "_écran inexistant avant ce changement_";
  const after = capture.afterMarkdown ?? "_capture indisponible_";
  const lines = ["", `### ${oneLine(capture.label) || "Écran"}`, "", "| Avant | Après |", "|---|---|", `| ${before} | ${after} |`];
  const note = oneLine(capture.note);
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
  const note = oneLine(change.note);
  if (note !== "") lines.push("", note);
  if (diff.length > 0) {
    const fence = fenceFor(diff.join("\n"));
    lines.push("", `${fence}diff`, ...diff, fence);
  }
  return lines;
}

/** Délimiteur de bloc de code plus long que toute suite de backticks du contenu (3 au minimum). */
function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

function renderTest(test: TestEntry): string {
  const change = test.change === "added" ? "ajouté" : "modifié";
  const explanation = oneLine(test.explanation);
  return `- ${codeSpan(test.name)} (${change}, ${codeSpan(test.file)})${explanation ? ` : ${explanation}` : ""}`;
}

function renderNit(nit: Finding): string {
  const location = nit.file ? codeSpan(nit.line !== undefined ? `${nit.file}:${nit.line}` : nit.file) + " " : "";
  return `- ${location}${oneLine(nit.description)}`;
}
