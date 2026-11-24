/**
 * Extrait utile d'une sortie de commande ou d'un log de job CI : erreurs avec un peu de contexte et fin de la sortie,
 * sans le bruit. Partagé par la vérification d'`init` et la boucle CI du moteur.
 */

export const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const IMPORTANT_RE =
  /\b(error|errors|erreur|err!|fail|failed|failure|failures|failing|exception|traceback|fatal|panic|not found|cannot|can't|could not|unable|denied|missing|unsupported|incompatible|requires?|required|expected|assert\w*|mismatch|undefined|refused|timeout|timed out|killed)\b|✗|✘|×/i;
const NOISE_RE =
  /^\s*(npm (warn|notice) |warning: |downloading|downloaded|fetching|resolving|collecting|using cached|requirement already satisfied|progress|\[?\d{1,3}%\]?|[-=#>.\s]*\d{1,3}%|[━─█▉▊▋▌▍▎▏░▒▓|/\\-]+\s*$)/i;

/** Lignes nettoyées : séquences ANSI retirées, barres de progression (\r) réduites à leur dernier état. */
function cleanLines(output: string): string[] {
  return output
    .replace(ANSI_RE, "")
    .split("\n")
    .map((l) => (l.split("\r").filter((x) => x.trim().length > 0).pop() ?? "").trimEnd());
}

/**
 * Extrait utile d'une sortie de commande : les lignes d'erreur avec un peu de contexte, et la fin de la sortie
 * (où les lanceurs de tests et les gestionnaires de paquets écrivent leur résumé). Le bruit (progression,
 * téléchargements, avertissements de dépréciation) et les lignes répétées sont retirés.
 */
export function usefulExcerpt(output: string, maxChars = 3_500, tailLines = 25): string {
  const raw = cleanLines(output);
  const lines: string[] = [];
  for (const l of raw) {
    if (l.trim() === "") continue;
    if (NOISE_RE.test(l) && !/\b(error|err!|fail)/i.test(l)) continue;
    if (lines.length > 0 && lines[lines.length - 1] === l) continue;
    lines.push(l.length > 400 ? `${l.slice(0, 400)}…` : l);
  }
  if (lines.length === 0) return "";
  const keep = new Set<number>();
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep.add(i);
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORTANT_RE.test(lines[i]!)) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
  }
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (prev !== -1 && i > prev + 1) out.push("…");
    if (prev === -1 && i > 0) out.push("…");
    out.push(lines[i]!);
    prev = i;
  }
  const text = out.join("\n");
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}
