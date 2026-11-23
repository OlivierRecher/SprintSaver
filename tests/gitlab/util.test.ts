import { describe, expect, it } from "vitest";
import { buildQuery } from "../../src/gitlab/rest.js";
import { extractImageUploads, formatUnifiedDiff, safeLocalName, stripAnsi, stripDraftPrefix } from "../../src/gitlab/util.js";

describe("util", () => {
  it("extractImageUploads repère les formes d'URL et filtre les images", () => {
    const s = "0123456789abcdef0123456789abcdef";
    const refs = extractImageUploads([
      `![a](/uploads/${s}/a%20b.png) ![b](/grp/p/uploads/${s}/c.JPG?w=1) [f](/uploads/${s}/f.log)`,
    ]);
    expect(refs).toEqual([
      { secret: s, filename: "a%20b.png" },
      { secret: s, filename: "c.JPG" },
    ]);
    expect(safeLocalName(refs[0]!)).toBe("01234567-a_b.png");
    expect(safeLocalName({ secret: s, filename: "..%2F..%2Fetc.png" })).toBe("01234567-etc.png");
  });

  it("stripDraftPrefix", () => {
    expect(stripDraftPrefix("Draft: fix")).toBe("fix");
    expect(stripDraftPrefix("(Draft) [draft] fix")).toBe("fix");
    expect(stripDraftPrefix("Drafting rules")).toBe("Drafting rules");
  });

  it("stripAnsi", () => {
    expect(stripAnsi("\x1b[31;1mred\x1b[0m\r\nok")).toBe("red\nok");
  });

  it("formatUnifiedDiff gère renommage et suppression", () => {
    const d = formatUnifiedDiff([
      { old_path: "a", new_path: "b", new_file: false, renamed_file: true, deleted_file: false, diff: "" },
      { old_path: "c", new_path: "c", a_mode: "100644", new_file: false, renamed_file: false, deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" },
    ]);
    expect(d).toBe(
      "diff --git a/a b/b\nrename from a\nrename to b\ndiff --git a/c b/c\ndeleted file mode 100644\n--- a/c\n+++ /dev/null\n@@ -1 +0,0 @@\n-x",
    );
  });

  it("buildQuery gère les tableaux et ignore undefined", () => {
    expect(buildQuery({ a: 1, b: undefined, "scope[]": ["failed", "canceled"] })).toBe("?a=1&scope%5B%5D=failed&scope%5B%5D=canceled");
  });
});
