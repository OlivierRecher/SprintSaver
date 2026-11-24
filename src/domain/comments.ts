/** Textes des commentaires postés sur le ticket (français, markdown GitLab). ADR § 4. */
import type { AnalysisResult } from "../contracts.js";
import { codeSpan, escapeHtml, fenceFor, listItem, mentionList, oneLine } from "./markdown.js";

export const DEFAULT_TRIGGER_LABEL = "auto::ready";
export const SIGNATURE = "<sub>SprintSaver</sub>";

const TYPE_LABELS: Record<string, string> = { bug: "bug", feature: "fonctionnalité" };

export function pickupComment(analysis: AnalysisResult, branch: string): string {
  const sorted = [...analysis.criteria].sort((a, b) => a.index - b.index);
  const testable = sorted.filter((c) => c.testable !== false);
  const untestable = sorted.filter((c) => c.testable === false);
  const type = TYPE_LABELS[analysis.type] ?? analysis.type;
  const head = [
    "**Pris en charge par SprintSaver**",
    analysis.typeSource === "agent" ? `${type} (type déduit)` : type,
    sorted.length > 0 ? `${testable.length}/${sorted.length} critères testables` : "aucune case à cocher",
    `branche ${codeSpan(branch)}`,
  ];
  const blocks: string[] = [head.join(" · ")];

  if (analysis.summary.trim() !== "") blocks.push(analysis.summary.trim());
  if (untestable.length > 0) {
    blocks.push(
      [
        "À vérifier à la main (non testables) :",
        ...untestable.map((c) => `- ${oneLine(c.text)} — ${oneLine(c.reason ?? "") || "raison non précisée"}`),
      ].join("\n"),
    );
  }
  if (analysis.plan.length > 0) {
    blocks.push(collapsible(`Plan (${analysis.plan.length} étapes)`, analysis.plan.map((step, i) => listItem(`${i + 1}.`, step))));
  }
  if (analysis.assumptions.length > 0) {
    blocks.push(collapsible(`Hypothèses (${analysis.assumptions.length})`, analysis.assumptions.map((a) => listItem("-", a))));
  }
  const precedents = analysis.precedents.filter((p) => p.relevant);
  if (precedents.length > 0) {
    blocks.push(
      collapsible(
        `Précédents (${precedents.length})`,
        precedents.map((p) => `- ${oneLine(p.ref)}${oneLine(p.why) ? ` : ${oneLine(p.why)}` : ""}`),
      ),
    );
  }
  return finish(blocks);
}

/** Bloc repliable GitLab : le titre reste visible, le détail s'ouvre au clic. */
function collapsible(summary: string, lines: string[]): string {
  return [`<details><summary>${escapeHtml(summary)}</summary>`, "", ...lines, "", "</details>"].join("\n");
}

/** Pied des commentaires de blocage : où est le travail et comment relancer. */
function relaunchLine(input: { branch: string; mrUrl?: string; triggerLabel?: string; acceptCiRef?: string }, unblock: string): string {
  const where = [`Branche ${codeSpan(input.branch)}`, ...(input.mrUrl ? [`[MR brouillon](${input.mrUrl})`] : [])].join(" · ");
  const lines = [`${where}. ${unblock}, puis remettez ${codeSpan(input.triggerLabel ?? DEFAULT_TRIGGER_LABEL)}.`];
  if (input.acceptCiRef) lines.push(`Pour livrer sans CI verte : ${codeSpan(`sprintsaver run ${input.acceptCiRef} --accept-ci`)}.`);
  return lines.join("\n");
}

export function needsInfoComment(questions: string[], mentions: string[], triggerLabel: string = DEFAULT_TRIGGER_LABEL): string {
  const blocks: string[] = [];
  const who = mentionList(mentions);
  if (who.length > 0) blocks.push(who.join(" "));
  blocks.push("**Précisions nécessaires** avant de traiter ce ticket :");
  const items = questions.map((q) => q.trim()).filter((q) => q !== "");
  if (items.length > 0) blocks.push(items.map((q, i) => listItem(`${i + 1}.`, q)).join("\n"));
  blocks.push(
    `Répondez en commentaire, puis remettez ${codeSpan(triggerLabel)}.`,
  );
  return finish(blocks);
}

/** Job CI en échec et extrait utile de son log, montrés dans un commentaire de blocage. */
export interface JobLogExcerpt {
  name: string;
  webUrl: string;
  excerpt: string;
}

/** Un bloc repliable par job : le lien, puis l'extrait de son log (erreurs et fin). */
function jobExcerptBlocks(jobs: JobLogExcerpt[] | undefined): string[] {
  return (jobs ?? []).map((job) => {
    const head = `${codeSpan(job.name)} : ${job.webUrl}`;
    const excerpt = job.excerpt.trim();
    if (excerpt === "") return `- ${head}`;
    const fence = fenceFor(excerpt);
    return [
      `<details><summary>Log du job ${escapeHtml(oneLine(job.name))} (extrait)</summary>`,
      "",
      head,
      "",
      `${fence}text`,
      excerpt,
      fence,
      "",
      "</details>",
    ].join("\n");
  });
}

export function blockedComment(input: {
  reason: string;
  details: string[];
  branch: string;
  mrUrl?: string;
  mentions: string[];
  /** Jobs CI en échec, avec un extrait de leur log. */
  jobs?: JobLogExcerpt[];
  /** Extrait de la sortie d'une commande en échec. */
  output?: string;
  /** Blocage pendant la CI : `<projet>#<iid>`, pour proposer `run --accept-ci`. */
  acceptCiRef?: string;
  /** Label déclencheur (défaut `auto::ready`). */
  triggerLabel?: string;
}): string {
  const blocks: string[] = [];
  const who = mentionList(input.mentions);
  if (who.length > 0) blocks.push(who.join(" "));
  blocks.push(`**Bloqué** : ${oneLine(input.reason)}`);

  const details = input.details.map((d) => d.trim()).filter((d) => d !== "");
  if (details.length > 0) blocks.push(details.map((d) => listItem("-", d)).join("\n"));
  const output = input.output?.trim() ?? "";
  if (output !== "") {
    const fence = fenceFor(output);
    blocks.push([`${fence}text`, output, fence].join("\n"));
  }
  blocks.push(...jobExcerptBlocks(input.jobs));
  blocks.push(relaunchLine(input, "Levez le blocage"));
  return finish(blocks);
}

export function baseCiBrokenComment(input: {
  defaultBranch: string;
  pipelineUrl: string;
  branch: string;
  mentions: string[];
  /** Jobs en échec sur la branche du ticket comme sur la branche par défaut (blocage sans relance). */
  sharedJobs?: string[];
  /** Jobs en échec sur la branche du ticket, avec un extrait de leur log. */
  jobs?: JobLogExcerpt[];
  /** `<projet>#<iid>`, pour proposer `run --accept-ci`. */
  acceptCiRef?: string;
  /** Label déclencheur (défaut `auto::ready`). */
  triggerLabel?: string;
}): string {
  const blocks: string[] = [];
  const who = mentionList(input.mentions);
  if (who.length > 0) blocks.push(who.join(" "));
  blocks.push(
    `**Bloqué : CI de ${codeSpan(input.defaultBranch)} cassée**, indépendamment de ce ticket ([dernier pipeline](${input.pipelineUrl})).`,
  );
  const shared = input.sharedJobs ?? [];
  if (shared.length > 0) {
    blocks.push(`En échec ici comme sur ${codeSpan(input.defaultBranch)} : ${shared.map((name) => codeSpan(name)).join(", ")} (non relancés).`);
  }
  blocks.push(...jobExcerptBlocks(input.jobs));
  blocks.push(relaunchLine(input, `Réparez la CI de ${codeSpan(input.defaultBranch)}`));
  return finish(blocks);
}

export function deliveredComment(input: { mrUrl: string; provenCount: number; totalTestable: number; untestable: string[] }): string {
  const head = `**MR prête à relire** : ${input.mrUrl}`;
  const blocks = [input.totalTestable > 0 ? `${head} · ${input.provenCount}/${input.totalTestable} critères prouvés` : head];
  const untestable = input.untestable.map(oneLine).filter((u) => u !== "");
  if (untestable.length > 0) blocks.push(["À vérifier à la main :", ...untestable.map((u) => `- ${u}`)].join("\n"));
  return finish(blocks);
}

function finish(blocks: string[]): string {
  return [...blocks, SIGNATURE].join("\n\n") + "\n";
}
