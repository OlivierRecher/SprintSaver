/** Fonctions pures utilisées par le client GitLab (testées sans réseau). */

export interface UploadRef {
  secret: string;
  /** Nom de fichier tel qu'il apparaît dans l'URL (peut être encodé). */
  filename: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic)$/i;

/**
 * Repère les uploads GitLab `/uploads/<secret>/<filename>` dans des textes markdown
 * (formes `/uploads/…`, `/group/proj/uploads/…`, `https://host/-/project/1/uploads/…`).
 * Ne garde que les images, dédoublonne.
 */
export function extractImageUploads(texts: string[]): UploadRef[] {
  const re = /\/uploads\/([0-9a-f]{16,64})\/([^\s)"'<>\]]+)/gi;
  const seen = new Set<string>();
  const out: UploadRef[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const secret = m[1]!;
      const filename = m[2]!.replace(/[?#].*$/, "");
      if (!IMAGE_EXT.test(filename)) continue;
      const key = `${secret}/${filename}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ secret, filename });
    }
  }
  return out;
}

/** Nom de fichier local sûr (pas de séparateur, pas de `..`). */
export function safeLocalName(ref: UploadRef): string {
  let name: string;
  try {
    name = decodeURIComponent(ref.filename);
  } catch {
    name = ref.filename;
  }
  name = name.split(/[\\/]/).pop() ?? "image";
  name = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "image";
  return `${ref.secret.slice(0, 8)}-${name}`;
}

const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-)\s*/i;

/** Retire les préfixes Draft reconnus par GitLab (`Draft:`, `[Draft]`, `(Draft)`), éventuellement répétés. */
export function stripDraftPrefix(title: string): string {
  let t = title;
  while (DRAFT_PREFIX.test(t)) t = t.replace(DRAFT_PREFIX, "");
  return t.trim();
}

export function isDraftTitle(title: string): boolean {
  return DRAFT_PREFIX.test(title);
}

/** Retire les séquences ANSI et les marqueurs de sections GitLab CI. */
export function stripAnsi(s: string): string {
  return s
    .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.\-[\]=,]+\r?/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** Garde les `maxChars` derniers caractères. */
export function tail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(s.length - maxChars);
  return `[… ${s.length - maxChars} caractères tronqués au début …]\n${cut}`;
}

/** Garde les `maxChars` premiers caractères. */
export function head(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n[… diff tronqué : ${s.length - maxChars} caractères omis …]`;
}

export interface RawDiff {
  old_path: string;
  new_path: string;
  a_mode?: string | null;
  b_mode?: string | null;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}

/** Reconstitue un diff unifié de type `git diff` à partir des diffs REST GitLab. */
export function formatUnifiedDiff(diffs: RawDiff[]): string {
  const parts: string[] = [];
  for (const d of diffs) {
    const lines = [`diff --git a/${d.old_path} b/${d.new_path}`];
    if (d.new_file) lines.push(`new file mode ${d.b_mode ?? "100644"}`);
    else if (d.deleted_file) lines.push(`deleted file mode ${d.a_mode ?? "100644"}`);
    else if (d.a_mode && d.b_mode && d.a_mode !== d.b_mode) lines.push(`old mode ${d.a_mode}`, `new mode ${d.b_mode}`);
    if (d.renamed_file) lines.push(`rename from ${d.old_path}`, `rename to ${d.new_path}`);
    if (d.diff) {
      lines.push(d.new_file ? "--- /dev/null" : `--- a/${d.old_path}`);
      lines.push(d.deleted_file ? "+++ /dev/null" : `+++ b/${d.new_path}`);
      lines.push(d.diff.replace(/\n$/, ""));
    } else if (d.too_large || d.collapsed) {
      lines.push("(diff trop volumineux, non fourni par GitLab)");
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n");
}
