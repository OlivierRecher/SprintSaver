/** Textes des commentaires postés sur le ticket (français, markdown GitLab). ADR § 4. */
import type { AnalysisResult } from "../contracts.js";
import { codeSpan, listItem, mentionList, oneLine } from "./markdown.js";

export const DEFAULT_TRIGGER_LABEL = "auto::ready";
export const SIGNATURE = "<sub>SprintSaver</sub>";

const TYPE_LABELS: Record<string, string> = { bug: "bug", feature: "fonctionnalité" };
const TYPE_SOURCES: Record<AnalysisResult["typeSource"], string> = {
  labels: "d'après les labels du ticket",
  issue_type: "d'après le type GitLab du ticket",
  agent: "déduit par l'analyse",
};

export function pickupComment(analysis: AnalysisResult, branch: string): string {
  const blocks: string[] = ["**Pris en charge par SprintSaver.**"];

  const type = TYPE_LABELS[analysis.type] ?? analysis.type;
  blocks.push(`**Type retenu** : ${type} (${TYPE_SOURCES[analysis.typeSource]})`);

  if (analysis.summary.trim() !== "") blocks.push(`### Résumé\n${analysis.summary.trim()}`);

  if (analysis.plan.length > 0) {
    blocks.push(["### Plan", ...analysis.plan.map((step, i) => listItem(`${i + 1}.`, step))].join("\n"));
  }

  blocks.push(renderCriteria(analysis.criteria));

  const precedents = analysis.precedents.filter((p) => p.relevant);
  if (precedents.length > 0) {
    blocks.push(
      [
        "### Précédents retenus",
        ...precedents.map((p) => `- ${oneLine(p.ref)}${oneLine(p.why) ? ` : ${oneLine(p.why)}` : ""}`),
      ].join("\n"),
    );
  }

  if (analysis.assumptions.length > 0) {
    blocks.push(["### Hypothèses", ...analysis.assumptions.map((a) => listItem("-", a))].join("\n"));
  }

  blocks.push(`Branche de travail : ${codeSpan(branch)}`);
  return finish(blocks);
}

function renderCriteria(criteria: AnalysisResult["criteria"]): string {
  const sorted = [...criteria].sort((a, b) => a.index - b.index);
  const testable = sorted.filter((c) => c.testable !== false);
  const untestable = sorted.filter((c) => c.testable === false);
  const lines = ["### Critères"];
  if (sorted.length === 0) {
    lines.push("Aucune case à cocher dans la description.");
    return lines.join("\n");
  }
  lines.push(`**Testables (${testable.length})** — seront prouvés par un test :`);
  lines.push(...(testable.length > 0 ? testable.map((c) => `- ${oneLine(c.text)}`) : ["- _aucun_"]));
  if (untestable.length > 0) {
    lines.push("", `**Non testables (${untestable.length})** — à vérifier manuellement, ne bloquent pas la livraison :`);
    lines.push(
      ...untestable.map((c) => `- ${oneLine(c.text)} — ${oneLine(c.reason ?? "") || "raison non précisée"}`),
    );
  }
  return lines.join("\n");
}

export function needsInfoComment(questions: string[], mentions: string[], triggerLabel: string = DEFAULT_TRIGGER_LABEL): string {
  const blocks: string[] = [];
  const who = mentionList(mentions);
  if (who.length > 0) blocks.push(who.join(" "));
  blocks.push("SprintSaver a besoin de précisions avant de pouvoir traiter ce ticket :");
  const items = questions.map((q) => q.trim()).filter((q) => q !== "");
  if (items.length > 0) blocks.push(items.map((q, i) => listItem(`${i + 1}.`, q)).join("\n"));
  blocks.push(
    `Répondez en commentaire puis remettez le label ${codeSpan(triggerLabel)} : SprintSaver reprendra le ticket en tenant compte de vos réponses.`,
  );
  return finish(blocks);
}

export function blockedComment(input: {
  reason: string;
  details: string[];
  branch: string;
  mrUrl?: string;
  mentions: string[];
  /** Label déclencheur (défaut `auto::ready`). */
  triggerLabel?: string;
}): string {
  const blocks: string[] = [];
  const who = mentionList(input.mentions);
  if (who.length > 0) blocks.push(who.join(" "));
  blocks.push(`**SprintSaver est bloqué sur ce ticket** : ${oneLine(input.reason)}`);

  const details = input.details.map((d) => d.trim()).filter((d) => d !== "");
  if (details.length > 0) blocks.push(["Détails :", ...details.map((d) => listItem("-", d))].join("\n"));

  const state = [`- Travail en cours poussé sur la branche ${codeSpan(input.branch)}.`];
  if (input.mrUrl) state.push(`- Merge request (brouillon) : ${input.mrUrl}`);
  blocks.push(state.join("\n"));

  blocks.push(
    `Pour relancer : levez le blocage (réponse en commentaire, correction…) puis remettez le label ${codeSpan(input.triggerLabel ?? DEFAULT_TRIGGER_LABEL)}. SprintSaver reprendra sur la branche existante.`,
  );
  return finish(blocks);
}

export function baseCiBrokenComment(input: {
  defaultBranch: string;
  pipelineUrl: string;
  branch: string;
  mentions: string[];
  /** Label déclencheur (défaut `auto::ready`). */
  triggerLabel?: string;
}): string {
  const blocks: string[] = [];
  const who = mentionList(input.mentions);
  if (who.length > 0) blocks.push(who.join(" "));
  blocks.push(
    `**La CI de ${codeSpan(input.defaultBranch)} est cassée, indépendamment de ce ticket.** SprintSaver s'arrête ici plutôt que de chercher à corriger une erreur qui n'est pas la sienne.`,
  );
  blocks.push(
    [
      `- Dernier pipeline de ${codeSpan(input.defaultBranch)} : ${input.pipelineUrl}`,
      `- Travail en cours poussé sur la branche ${codeSpan(input.branch)}.`,
    ].join("\n"),
  );
  blocks.push(
    `Une fois la CI de ${codeSpan(input.defaultBranch)} réparée, remettez le label ${codeSpan(input.triggerLabel ?? DEFAULT_TRIGGER_LABEL)} pour relancer.`,
  );
  return finish(blocks);
}

export function deliveredComment(input: {
  mrUrl: string;
  summary: string;
  provenCount: number;
  totalTestable: number;
  untestable: string[];
}): string {
  const blocks: string[] = [`**Merge request prête à relire** : ${input.mrUrl}`];
  if (input.summary.trim() !== "") blocks.push(input.summary.trim());
  blocks.push(`Critères testables prouvés par un test : **${input.provenCount}/${input.totalTestable}** (cases cochées dans la description).`);
  const untestable = input.untestable.map(oneLine).filter((u) => u !== "");
  if (untestable.length > 0) {
    blocks.push(["Critères non testables, à vérifier manuellement :", ...untestable.map((u) => `- ${u}`)].join("\n"));
  }
  return finish(blocks);
}

function finish(blocks: string[]): string {
  return [...blocks, SIGNATURE].join("\n\n") + "\n";
}
