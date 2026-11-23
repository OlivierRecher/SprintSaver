import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGuardCallback, evaluateToolCall, parseShell, stripHeredocs } from "../../src/agent/guard-hook.js";

const WT = "/Users/dev/.sprintsaver/worktrees/webapp-12";

function bash(command: string) {
  return evaluateToolCall("Bash", { command }, WT);
}
function allowed(command: string): boolean {
  return bash(command).allow;
}

describe("parseShell", () => {
  it("découpe les opérateurs et extrait les redirections", () => {
    const segs = parseShell(`npm test 2>&1 | tee out.log && echo "a b" > /tmp/x; ls`);
    expect(segs.map((s) => s.words)).toEqual([["npm", "test"], ["tee", "out.log"], ["echo", "a b"], ["ls"]]);
    expect(segs[2]?.redirects).toEqual(["/tmp/x"]);
  });
  it("retire le corps des heredocs", () => {
    expect(stripHeredocs("cat > f <<'EOF'\ngit push\nrm -rf /\nEOF\nls")).toBe("cat > f <<'EOF'\nls");
  });
});

describe("evaluateToolCall — git", () => {
  const denied = [
    "git push",
    "git push origin HEAD",
    "git push --force-with-lease",
    "git pull",
    "git fetch origin",
    "git fetch --all",
    "git clone https://gitlab.com/g/p.git",
    "git remote add evil https://x",
    "git remote -v",
    "git ls-remote origin",
    "git -C /Users/dev/other-repo status",
    "git -C .. log",
    "git --git-dir=/Users/dev/other/.git log",
    "git -c remote.origin.url=https://x push",
    "git config remote.origin.url https://x",
    "git config --global user.name x",
    "git branch --set-upstream-to=origin/main",
    "git reset --hard origin/main",
    "git merge origin/main",
    "git rebase main",
    "git rebase --continue",
    "git commit -m 'feat: x'",
    "git worktree add ../x",
    "git submodule update --init",
    "npm test && git push",
    "FOO=1 git push",
    "sudo git push",
    "bash -c 'git push origin'",
    "sh -c \"cd /tmp && git fetch\"",
    "echo $(git push)",
    "/usr/bin/git push",
    "cd /Users/dev/other && git status",
  ];
  for (const cmd of denied) {
    it(`refuse: ${cmd}`, () => {
      const d = bash(cmd);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/garde-fou SprintSaver/);
    });
  }

  const ok = [
    "git status",
    "git diff origin/main...HEAD",
    "git log --oneline -20 --grep push",
    "git log -S 'fetchUser' -- src/",
    "git blame src/a.ts",
    "git add -A",
    "git stash",
    "git checkout -- src/a.ts",
    "git reset --hard HEAD",
    "git config --get remote.origin.url",
    "git config user.name",
    "git -C packages/api status",
    "git show HEAD~1:src/a.ts",
    "git worktree list",
    "cd /tmp/fixture && git init && git commit -m x",
  ];
  for (const cmd of ok) {
    it(`autorise: ${cmd}`, () => {
      expect(allowed(cmd)).toBe(true);
    });
  }
});

describe("evaluateToolCall — GitLab et réseau", () => {
  it("refuse glab", () => {
    expect(allowed("glab mr list")).toBe(false);
    expect(allowed("npm ci && glab issue view 3")).toBe(false);
  });
  it("refuse curl/wget vers gitlab", () => {
    expect(allowed("curl -H 'PRIVATE-TOKEN: x' https://gitlab.com/api/v4/projects/1")).toBe(false);
    expect(allowed("wget https://gitlab.example.org/x")).toBe(false);
  });
  it("autorise curl ailleurs", () => {
    expect(allowed("curl -s http://localhost:3000/health")).toBe(true);
  });
  it("donne une raison qui oriente vers les outils MCP", () => {
    const d = bash("glab issue list");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("search_issues");
  });
});

describe("evaluateToolCall — écritures shell hors worktree", () => {
  const denied = [
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf ~/projects",
    "rm -rf $HOME/x",
    "rm -rf ../other",
    "cd .. && rm -rf webapp-13",
    "cd / && rm -rf usr",
    "mv src /Users/dev/elsewhere",
    "cp .env /Users/dev/leak.env",
    "echo x > ~/.zshrc",
    "echo x >> /etc/hosts",
    "find / -name '*.log' -delete",
    "sed -i 's/a/b/' ~/.bashrc",
    "tee /Users/dev/out.txt",
    "mkdir -p /Users/dev/newdir",
    "xargs rm -rf /var/x",
  ];
  for (const cmd of denied) {
    it(`refuse: ${cmd}`, () => {
      expect(allowed(cmd)).toBe(false);
    });
  }

  const ok = [
    "rm -rf node_modules dist",
    `rm -rf ${WT}/build`,
    "rm -rf /tmp/sprintsaver-test",
    `rm -rf ${join(tmpdir(), "x")}`,
    "npm test > /dev/null 2>&1",
    "npm test > test-output.log",
    "cp ~/.npmrc .",
    "cat ~/.gitconfig",
    "ls -la /",
    "cd src && rm -rf __snapshots__",
    "sed -i 's/a/b/' src/a.ts",
    "cat > src/new.ts <<'EOF'\nrm -rf /\ngit push\nEOF",
    "echo $(date) > /tmp/now",
    "for f in $FILES; do rm $f; done",
  ];
  for (const cmd of ok) {
    it(`autorise: ${cmd.split("\n")[0]}`, () => {
      expect(allowed(cmd)).toBe(true);
    });
  }
});

describe("evaluateToolCall — outils d'écriture de fichiers", () => {
  it("autorise un chemin relatif ou absolu dans le worktree", () => {
    expect(evaluateToolCall("Write", { file_path: "src/a.ts", content: "" }, WT).allow).toBe(true);
    expect(evaluateToolCall("Edit", { file_path: `${WT}/src/a.ts` }, WT).allow).toBe(true);
  });
  it("autorise /tmp et os.tmpdir()", () => {
    expect(evaluateToolCall("Write", { file_path: "/tmp/scratch.txt" }, WT).allow).toBe(true);
    expect(evaluateToolCall("Write", { file_path: join(tmpdir(), "a.txt") }, WT).allow).toBe(true);
  });
  it("racines supplémentaires (worktree « avant » des captures) : écriture autorisée là, pas ailleurs", () => {
    const base = `${WT}.avant`;
    expect(evaluateToolCall("Write", { file_path: `${base}/dist/a.js` }, WT, [base]).allow).toBe(true);
    expect(evaluateToolCall("Bash", { command: `rm -rf ${base}/dist` }, WT, [base]).allow).toBe(true);
    expect(evaluateToolCall("Write", { file_path: `${base}/dist/a.js` }, WT).allow).toBe(false);
    expect(evaluateToolCall("Write", { file_path: `${WT}-13/a.ts` }, WT, [base]).allow).toBe(false);
  });
  it("refuse hors du worktree, y compris par ..", () => {
    for (const p of ["/etc/hosts", join(homedir(), ".zshrc"), `${WT}/../webapp-13/a.ts`, `${WT}-evil/a.ts`, "../x.ts"]) {
      const d = evaluateToolCall("Write", { file_path: p }, WT);
      expect(d.allow).toBe(false);
    }
    expect(evaluateToolCall("MultiEdit", { file_path: "/etc/x" }, WT).allow).toBe(false);
    expect(evaluateToolCall("NotebookEdit", { notebook_path: "/Users/dev/n.ipynb" }, WT).allow).toBe(false);
  });
  it("laisse passer les autres outils (lecture, MCP)", () => {
    expect(evaluateToolCall("Read", { file_path: "/etc/hosts" }, WT).allow).toBe(true);
    expect(evaluateToolCall("mcp__gitlab__get_issue", { iid: 3 }, WT).allow).toBe(true);
  });
});

describe("createGuardCallback", () => {
  const signal = new AbortController().signal;
  const base = { session_id: "s", transcript_path: "/tmp/t", cwd: WT, tool_use_id: "t1" };

  it("renvoie un refus PreToolUse avec raison", async () => {
    const cb = createGuardCallback(WT);
    const out = await cb({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } } as never, "t1", { signal });
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
  });

  it("renvoie un objet vide pour un appel autorisé", async () => {
    const cb = createGuardCallback(WT);
    const out = await cb({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } } as never, "t1", { signal });
    expect(out).toEqual({});
  });
});

describe("evaluateToolCall — liens symboliques et -t", () => {
  // Dossiers réels : un worktree et un dossier « extérieur » hors des racines autorisées (sous le HOME,
  // car /tmp est autorisé).
  const base = mkdtempSync(join(homedir(), ".ss-guard-test-"));
  const wt = join(base, "wt");
  const outside = join(base, "outside");
  mkdirSync(wt, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(outside, join(wt, "lien-dossier"));
  symlinkSync(join(outside, "secret.txt"), join(wt, "lien-fichier"));
  symlinkSync(join(outside, "pas-encore-cree.txt"), join(wt, "lien-casse"));
  mkdirSync(join(wt, "src"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const b = (command: string) => evaluateToolCall("Bash", { command }, wt).allow;
  const write = (file_path: string) => evaluateToolCall("Write", { file_path }, wt).allow;

  it("Write/Edit à travers un lien vers l'extérieur : refusé", () => {
    expect(write("lien-dossier/nouveau.txt")).toBe(false);
    expect(write(join(wt, "lien-fichier"))).toBe(false);
    expect(write("lien-casse")).toBe(false);
    expect(evaluateToolCall("Edit", { file_path: "lien-dossier/secret.txt" }, wt).allow).toBe(false);
    expect(write("src/nouveau/fichier.ts")).toBe(true);
  });

  it("commandes destructrices : le lien lui-même peut être supprimé, pas sa cible", () => {
    expect(b("rm lien-fichier")).toBe(true);
    expect(b("rm -rf lien-dossier")).toBe(true);
    expect(b("rm -rf lien-dossier/")).toBe(false);
    expect(b("rm lien-dossier/secret.txt")).toBe(false);
    expect(b("echo x > lien-fichier")).toBe(false);
    expect(b("touch lien-dossier/a")).toBe(false);
    expect(b("chmod 777 lien-fichier")).toBe(false);
  });

  it("cp -t / mv -t / install -t : le dossier cible est vérifié", () => {
    expect(b("cp -t lien-dossier src/a.ts")).toBe(false);
    expect(b(`cp -t ${outside} src/a.ts`)).toBe(false);
    expect(b(`cp --target-directory=${outside} src/a.ts`)).toBe(false);
    expect(b(`mv -t ${outside} src/a.ts`)).toBe(false);
    expect(b(`install -t ${outside} -m 644 src/a.ts`)).toBe(false);
    expect(b(`install -d ${outside}/x`)).toBe(false);
    expect(b("cp -t src lien-fichier")).toBe(true); // lire via un lien est permis
    expect(b("mv -t src src/a.ts")).toBe(true);
  });
});
