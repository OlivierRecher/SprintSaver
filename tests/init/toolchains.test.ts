import { describe, expect, it } from "vitest";
import { defaultProbeDeps, listVersionManagers, probeToolchains, whichAll, type ProbeDeps, type ProbeExecResult } from "../../src/init/toolchains.js";

/** Machine simulée : exécutables présents, liens, dossiers et sorties des sondes. */
function machine(opts: {
  bins: Record<string, string>;
  links?: Record<string, string>;
  dirs?: Record<string, string[]>;
  pathDirs?: string[];
  platform?: NodeJS.Platform;
}) {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  const deps: ProbeDeps = {
    exec: async (file, args, cwd): Promise<ProbeExecResult> => {
      calls.push({ file, args, cwd });
      const out = opts.bins[file];
      if (out === undefined) return { code: 127, stdout: "", stderr: "not found" };
      return file.endsWith("java") ? { code: 0, stdout: "", stderr: out } : { code: 0, stdout: out, stderr: "" };
    },
    pathDirs: opts.pathDirs ?? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
    isExecutable: (p) => p in opts.bins,
    realpath: (p) => opts.links?.[p] ?? p,
    listDir: (p) => opts.dirs?.[p] ?? [],
    home: "/Users/me",
    platform: opts.platform ?? "darwin",
  };
  return { deps, calls };
}

describe("sondes de toolchain", () => {
  it("liste toutes les copies du PATH (la première est le défaut) et les installations Homebrew versionnées", async () => {
    const { deps, calls } = machine({
      bins: {
        "/opt/homebrew/bin/node": "v26.10.0",
        "/usr/local/bin/node": "v18.20.0",
        "/opt/homebrew/opt/node@20/bin/node": "v20.19.1",
        "/opt/homebrew/opt/node/bin/node": "v26.10.0",
      },
      links: { "/opt/homebrew/opt/node/bin/node": "/opt/homebrew/Cellar/node/26.10.0/bin/node", "/opt/homebrew/bin/node": "/opt/homebrew/Cellar/node/26.10.0/bin/node" },
      dirs: { "/opt/homebrew/opt": ["node", "node@20", "nodenv-other", "openssl@3"] },
    });
    const report = await probeToolchains(["node"], "/repo", deps);
    expect(report).toContain("/opt/homebrew/bin/node → /opt/homebrew/Cellar/node/26.10.0/bin/node : v26.10.0 (défaut du PATH)");
    expect(report).toContain("/usr/local/bin/node : v18.20.0");
    expect(report).toContain("/opt/homebrew/opt/node@20/bin/node : v20.19.1 (Homebrew, hors PATH)");
    // Même binaire réel que le défaut du PATH : pas listé deux fois.
    expect(report).not.toContain("/opt/homebrew/opt/node/bin/node");
    expect(calls.every((c) => c.cwd === "/repo")).toBe(true);
  });

  it("outil absent, outil inconnu, Java sur macOS avec java_home", async () => {
    const { deps } = machine({
      bins: { "/usr/bin/java": 'openjdk version "21.0.2"', "/usr/libexec/java_home": "" },
    });
    deps.exec = async (file) =>
      file === "/usr/libexec/java_home"
        ? { code: 0, stdout: "", stderr: "Matching Java Virtual Machines (2):\n    21.0.2 (arm64) \"Temurin\" - /Library/Java/21\n    17.0.10 (arm64) \"Temurin\" - /Library/Java/17\n" }
        : { code: 0, stdout: "", stderr: 'openjdk version "21.0.2"' };
    const report = await probeToolchains(["go", "java", "cobol"], "/repo", deps);
    expect(report).toMatch(/go\n {2}absent du PATH/);
    expect(report).toContain("cobol\n  outil inconnu des sondes");
    expect(report).toContain('/usr/bin/java : openjdk version "21.0.2" (défaut du PATH)');
    expect(report).toContain('17.0.10 (arm64) "Temurin" - /Library/Java/17');
    expect(report).toContain("JAVA_HOME=$(/usr/libexec/java_home -v <version>)");
  });

  it("whichAll dédoublonne par chemin réel", () => {
    const { deps } = machine({ bins: { "/opt/homebrew/bin/python3": "", "/usr/local/bin/python3": "" }, links: { "/usr/local/bin/python3": "/opt/homebrew/bin/python3" } });
    expect(whichAll("python3", deps)).toEqual(["/opt/homebrew/bin/python3"]);
  });

  it("inventaire des gestionnaires de versions : binaires du PATH, nvm et sdkman par leur dossier", async () => {
    const { deps, calls } = machine({
      bins: { "/opt/homebrew/bin/uv": "uv 0.9.0\ncpython-3.10.22 /Users/me/.local/share/uv/python/…", "/opt/homebrew/bin/fnm": "* v20.11.1\n* v22.3.0" },
      dirs: {
        "/Users/me/.nvm/versions/node": ["v18.19.0", "v20.11.1"],
        "/Users/me/.sdkman/candidates": ["java", "maven"],
        "/Users/me/.sdkman/candidates/java": ["17.0.10-tem", "current"],
        "/Users/me/.sdkman/candidates/maven": [],
      },
    });
    const report = await listVersionManagers("/repo", deps);
    expect(report).toContain("fnm (/opt/homebrew/bin/fnm) — usage : fnm exec --using=<version> -- <commande>");
    expect(report).toContain("* v20.11.1");
    expect(report).toContain("uv (/opt/homebrew/bin/uv)");
    expect(report).toContain("$ uv python list --only-installed");
    expect(report).toMatch(/nvm .*fonction shell/);
    expect(report).toContain("v20.11.1");
    expect(report).toContain("java : 17.0.10-tem");
    expect(report).not.toContain("current");
    expect(report).not.toContain("mise");
    expect(calls.some((c) => c.args.includes("install"))).toBe(false);
  });

  it("aucun gestionnaire : le dit explicitement", async () => {
    const { deps } = machine({ bins: {} });
    expect(await listVersionManagers("/repo", deps)).toMatch(/Aucun gestionnaire de versions/);
  });
});

describe("environnement des sondes", () => {
  it("le PATH sondé est celui des commandes du projet : sans les node_modules/.bin d'un script npm", () => {
    const deps = defaultProbeDeps({ PATH: "/pkg/node_modules/.bin:/node_modules/.bin:/opt/homebrew/bin:/usr/bin", npm_lifecycle_event: "dev", npm_config_local_prefix: "/pkg" });
    expect(deps.pathDirs).toEqual(["/opt/homebrew/bin", "/usr/bin"]);
  });
});
