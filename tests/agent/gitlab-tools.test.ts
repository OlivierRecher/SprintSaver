import { describe, expect, it } from "vitest";
import type { GitLabApi } from "../../src/contracts.js";
import type { ProjectConfig } from "../../src/config/schema.js";
import { createGitLabReadServer, gitlabReadTools } from "../../src/agent/gitlab-tools.js";

const project = { name: "webapp", id: 42, path: "g/webapp" } as ProjectConfig;

interface Call {
  method: string;
  args: unknown[];
}

function fakeGitLab(overrides: Partial<GitLabApi> = {}): { api: GitLabApi; calls: Call[] } {
  const calls: Call[] = [];
  const impl: Partial<GitLabApi> = {
    async searchIssues(...args) {
      calls.push({ method: "searchIssues", args });
      return [{ projectId: 42, iid: 7, title: "Crash au login", state: "closed", webUrl: "https://g/7", labels: ["bug"] }];
    },
    async getIssue(...args) {
      calls.push({ method: "getIssue", args });
      return {
        projectId: 42,
        iid: 7,
        title: "Crash au login",
        state: "closed",
        webUrl: "https://g/7",
        labels: [],
        description: "- [ ] ne plante plus",
        issueType: "issue",
        authorUsername: "alice",
        createdAt: "2026-01-01",
      };
    },
    async getIssueNotes(...args) {
      calls.push({ method: "getIssueNotes", args });
      return [{ id: 1, authorUsername: "bob", body: "Reproduit sur Safari", createdAt: "2026-01-02" }];
    },
    async closingMrs(...args) {
      calls.push({ method: "closingMrs", args });
      return [{ iid: 3, webUrl: "https://g/!3", title: "fix: login", state: "merged", mergedAt: "2026-01-03" }];
    },
    async mrDiff(...args) {
      calls.push({ method: "mrDiff", args });
      return "diff --git a/x b/x";
    },
    ...overrides,
  };
  return { api: impl as GitLabApi, calls };
}

function toolByName(api: GitLabApi, name: string) {
  const t = gitlabReadTools(api, project).find((x) => x.name === name);
  if (!t) throw new Error(`outil ${name} absent`);
  return t;
}

function textOf(res: { content: unknown[] }): string {
  return (res.content[0] as { text: string }).text;
}

describe("gitlabReadTools", () => {
  it("expose quatre outils en lecture seule", () => {
    const { api } = fakeGitLab();
    const tools = gitlabReadTools(api, project);
    expect(tools.map((t) => t.name)).toEqual(["search_issues", "get_issue", "get_issue_closing_mrs", "get_mr_diff"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("search_issues est limité au projet et a des défauts", async () => {
    const { api, calls } = fakeGitLab();
    const res = await toolByName(api, "search_issues").handler({ query: "login" } as never, {});
    expect(calls[0]).toEqual({ method: "searchIssues", args: [42, "login", "all", 10] });
    expect(textOf(res)).toContain("#7 [closed] Crash au login");
    expect(res.isError).toBeUndefined();
  });

  it("search_issues transmet l'état demandé", async () => {
    const { api, calls } = fakeGitLab();
    await toolByName(api, "search_issues").handler({ query: "x", state: "closed", limit: 5 } as never, {});
    expect(calls[0]?.args).toEqual([42, "x", "closed", 5]);
  });

  it("get_issue renvoie description et commentaires", async () => {
    const { api, calls } = fakeGitLab();
    const res = await toolByName(api, "get_issue").handler({ iid: 7 } as never, {});
    const text = textOf(res);
    expect(text).toContain("- [ ] ne plante plus");
    expect(text).toContain("@bob");
    expect(text).toContain("Reproduit sur Safari");
    expect(calls.map((c) => c.args[0])).toEqual([42, 42]);
  });

  it("get_issue_closing_mrs et get_mr_diff", async () => {
    const { api, calls } = fakeGitLab();
    const mrs = await toolByName(api, "get_issue_closing_mrs").handler({ iid: 7 } as never, {});
    expect(textOf(mrs)).toContain("!3 [merged");
    const diff = await toolByName(api, "get_mr_diff").handler({ mr_iid: 3 } as never, {});
    expect(textOf(diff)).toBe("diff --git a/x b/x");
    expect(calls[1]?.args[0]).toBe(42);
    expect(calls[1]?.args[1]).toBe(3);
  });

  it("renvoie un résultat isError au lieu de lever", async () => {
    const { api } = fakeGitLab({
      async getIssue() {
        throw new Error("404 Not Found");
      },
    });
    const res = await toolByName(api, "get_issue").handler({ iid: 999 } as never, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("404 Not Found");
  });

  it("crée un serveur MCP SDK nommé gitlab", () => {
    const { api } = fakeGitLab();
    const server = createGitLabReadServer(api, project);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("gitlab");
  });
});
