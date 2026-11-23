/**
 * Diff ligne à ligne entre deux textes, au format unifié des blocs ```diff : « - » retiré, « + » ajouté, espace inchangé.
 * Sert à montrer explicitement un changement de données ou d'API dans la description de MR.
 */

/** Au-delà, le calcul LCS (n × m) est évité : tout l'avant en « - », tout l'après en « + ». */
const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return normalized === "" ? [] : normalized.split("\n");
}

export function lineDiff(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_LCS_CELLS) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];

  // lcs[i][j] = longueur de la plus longue sous-séquence commune de a[i..] et b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out;
}
