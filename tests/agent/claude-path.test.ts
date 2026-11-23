import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClaudeExecutable } from "../../src/agent/claude-path.js";

const none = () => false;

describe("findClaudeExecutable", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ss-claude-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("privilégie SPRINTSAVER_CLAUDE_PATH", () => {
    const p = findClaudeExecutable({
      env: { SPRINTSAVER_CLAUDE_PATH: "/custom/claude", PATH: "/usr/bin" },
      home: "/h",
      isExecutable: (x) => x === "/custom/claude" || x === "/usr/bin/claude",
    });
    expect(p).toBe("/custom/claude");
  });

  it("lève si SPRINTSAVER_CLAUDE_PATH n'est pas exécutable", () => {
    expect(() => findClaudeExecutable({ env: { SPRINTSAVER_CLAUDE_PATH: "/nope" }, home: "/h", isExecutable: none })).toThrow(
      /SPRINTSAVER_CLAUDE_PATH/,
    );
  });

  it("prend le premier `claude` exécutable du PATH", () => {
    const p = findClaudeExecutable({
      env: { PATH: ["/a", "/b", "/c"].join(delimiter) },
      home: "/h",
      isExecutable: (x) => x === "/b/claude" || x === "/c/claude",
    });
    expect(p).toBe("/b/claude");
  });

  it("se rabat sur ~/.claude/local", () => {
    const p = findClaudeExecutable({ env: { PATH: "/a" }, home: "/h", isExecutable: (x) => x === "/h/.claude/local/claude" });
    expect(p).toBe("/h/.claude/local/claude");
  });

  it("lève une erreur claire si introuvable", () => {
    expect(() => findClaudeExecutable({ env: { PATH: "/a" }, home: "/h", isExecutable: none })).toThrow(/introuvable/);
  });

  it("vérifie réellement l'exécutabilité sur disque", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    const env = { PATH: bin };
    expect(() => findClaudeExecutable({ env, home: root })).toThrow(/introuvable/);
    await chmod(join(bin, "claude"), 0o755);
    expect(findClaudeExecutable({ env, home: root })).toBe(join(bin, "claude"));
  });
});
