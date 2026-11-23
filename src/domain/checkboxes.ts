/** Cases à cocher markdown de la description d'un ticket (ADR § 5). */

export interface Checkbox {
  /** Index 0-based dans l'ordre d'apparition (hors blocs de code et commentaires HTML). */
  index: number;
  text: string;
  checked: boolean;
  /** Ligne 0-based dans le markdown source. */
  line: number;
}

interface LocatedCheckbox extends Checkbox {
  /** Offset absolu (dans le markdown) du caractère entre crochets (` `, `x` ou `X`). */
  markOffset: number;
}

/**
 * Élément de liste avec case : indentation libre, puce `-`/`*`/`+` ou numéro `1.`/`1)`,
 * au moins un blanc, puis `[ ]`/`[x]`/`[X]` suivi d'un blanc ou de la fin de ligne.
 */
const TASK_ITEM = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\](?=[ \t]|$)(.*)$/;

/** Ouverture de bloc de code clôturé, éventuellement indentée ou portée par une puce de liste. */
const FENCE_OPEN = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;

interface Line {
  /** Contenu sans fin de ligne (`\n` ou `\r\n`). */
  content: string;
  /** Offset absolu du début de ligne. */
  start: number;
}

function splitLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= markdown.length) {
    const nl = markdown.indexOf("\n", start);
    const end = nl === -1 ? markdown.length : nl;
    let content = markdown.slice(start, end);
    if (content.endsWith("\r")) content = content.slice(0, -1);
    lines.push({ content, start });
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines;
}

/**
 * Vrai si `text` laisse un commentaire HTML `<!--` ouvert à la fin (les `<!-- … -->` complets sont ignorés,
 * de même que ceux situés dans du code inline).
 */
function leavesCommentOpen(text: string): boolean {
  const s = text.replace(/`+[^`]*`+/g, "");
  let from = 0;
  for (;;) {
    const open = s.indexOf("<!--", from);
    if (open === -1) return false;
    const close = s.indexOf("-->", open + 4);
    if (close === -1) return true;
    from = close + 3;
  }
}

function scan(markdown: string): LocatedCheckbox[] {
  const result: LocatedCheckbox[] = [];
  /** Bloc de code ouvert : caractère et longueur de la clôture. */
  let fence: { char: string; length: number } | null = null;
  /** Commentaire HTML `<!--` ouvert sur une ligne précédente et pas encore refermé. */
  let inComment = false;

  splitLines(markdown).forEach((line, lineNo) => {
    const { content } = line;

    if (fence) {
      const trimmed = content.trim();
      const close = new RegExp(`^${fence.char === "`" ? "`" : "~"}{${fence.length},}$`);
      if (close.test(trimmed)) fence = null;
      return;
    }

    if (inComment) {
      // Toute la ligne qui referme le commentaire appartient encore au bloc HTML : pas de case possible.
      const close = content.indexOf("-->");
      if (close !== -1) inComment = leavesCommentOpen(content.slice(close + 3));
      return;
    }

    const open = FENCE_OPEN.exec(content);
    if (open) {
      const marker = open[1] ?? "";
      const info = open[2] ?? "";
      // Une clôture en backticks ne peut pas avoir de backtick dans sa chaîne d'info (CommonMark).
      if (!(marker.startsWith("`") && info.includes("`"))) {
        fence = { char: marker.charAt(0), length: marker.length };
        return;
      }
    }

    // Une case peut précéder un commentaire sur la même ligne ; les lignes suivantes sont masquées.
    if (leavesCommentOpen(content)) inComment = true;

    const task = TASK_ITEM.exec(content);
    if (!task) return;
    const prefix = task[1] ?? "";
    const mark = task[2] ?? " ";
    result.push({
      index: result.length,
      text: (task[3] ?? "").trim(),
      checked: mark !== " ",
      line: lineNo,
      markOffset: line.start + prefix.length,
    });
  });

  return result;
}

/**
 * Extrait les cases `- [ ]`, `* [ ]`, `+ [ ]`, `1. [ ]` (x/X = cochée), y compris imbriquées,
 * hors blocs de code clôturés et hors commentaires HTML `<!-- … -->` (même sur plusieurs lignes).
 */
export function parseCheckboxes(markdown: string): Checkbox[] {
  return scan(markdown).map(({ index, text, checked, line }) => ({ index, text, checked, line }));
}

/**
 * Retourne le markdown avec les cases d'index donnés cochées. Ne touche à rien d'autre (préserve fins de ligne).
 * Les cases déjà cochées (`[x]` ou `[X]`) sont laissées telles quelles ; les index inconnus sont ignorés.
 */
export function checkBoxes(markdown: string, indices: number[]): string {
  const wanted = new Set(indices);
  const offsets = scan(markdown)
    .filter((box) => wanted.has(box.index) && !box.checked)
    .map((box) => box.markOffset);
  return applyMarks(markdown, offsets);
}

/** Texte de case comparable : trim et blancs multiples réduits à un espace. */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Coche des cases identifiées par index ET texte, sur une description qui a pu changer depuis l'analyse :
 * - la case d'index `index` est cochée si son texte normalisé correspond (déjà cochée : rien à faire) ;
 * - sinon, une case NON cochée de même texte (la première libre) est cochée à la place ;
 * - sinon, rien (le critère a disparu ou a été reformulé).
 * Les correspondances exactes par index sont réservées avant les replis par texte ; une case n'est cochée
 * que pour un seul item.
 */
export function checkBoxesByText(markdown: string, items: { index: number; text: string }[]): string {
  const boxes = scan(markdown);
  const taken = new Set<number>();
  const pending: string[] = [];
  for (const item of items) {
    const want = normalizeText(item.text);
    const box = boxes[item.index];
    if (box && !taken.has(box.index) && normalizeText(box.text) === want) taken.add(box.index);
    else pending.push(want);
  }
  for (const want of pending) {
    const box = boxes.find((b) => !b.checked && !taken.has(b.index) && normalizeText(b.text) === want);
    if (box) taken.add(box.index);
  }
  const offsets = boxes.filter((b) => taken.has(b.index) && !b.checked).map((b) => b.markOffset);
  return applyMarks(markdown, offsets);
}

/** Remplace le caractère entre crochets par `x` aux offsets donnés (croissants). */
function applyMarks(markdown: string, offsets: number[]): string {
  if (offsets.length === 0) return markdown;

  let out = "";
  let cursor = 0;
  for (const offset of offsets) {
    out += markdown.slice(cursor, offset) + "x";
    cursor = offset + 1;
  }
  return out + markdown.slice(cursor);
}
