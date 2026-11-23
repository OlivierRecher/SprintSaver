import { describe, expect, it } from "vitest";
import {
  GlabAuthError,
  glabToken,
  glabVersion,
  hostOf,
  parseGlabToken,
  readGlabToken,
  type ExecFn,
} from "../../src/gitlab/glab-auth.js";

describe("parseGlabToken", () => {
  it("lit la ligne « Token: » de glab auth status --show-token", () => {
    const out = ["gitlab.com", "  ✓ Logged in to gitlab.com as olivier (keyring)", "  ✓ Git operations for gitlab.com configured to use https protocol.", "  ✓ API calls for gitlab.com are made over https protocol", "  ✓ REST API Endpoint: https://gitlab.com/api/v4/", "  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/", "  ✓ Token: glpat-AbC_123-xyz"].join("\n");
    expect(parseGlabToken(out)).toBe("glpat-AbC_123-xyz");
  });

  it("lit la sortie réelle de glab 1.131 (jeton trouvé dans l'environnement, appel API en échec)", () => {
    const out = [
      "gitlab.com",
      "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}",
      "    ! Token is from environment variable GITLAB_TOKEN. A wrapper may be injecting a different or expired token.",
      "    ! To see the token value in use, run: env | grep -E 'GITLAB_TOKEN|GITLAB_ACCESS_TOKEN|OAUTH_TOKEN'",
      "  ✓ Git operations for gitlab.com configured to use ssh protocol.",
      "  ✓ REST API Endpoint: https://gitlab.com/api/v4/",
      "  ✓ Token found in environment variable GITLAB_TOKEN: glpat-FAKEtoken0123456789",
      "",
      "! Token is from environment variable GITLAB_TOKEN. This takes precedence over tokens stored in config or keyring.",
      "  x could not authenticate to one or more of the configured GitLab instances.",
    ].join("\n");
    expect(parseGlabToken(out)).toBe("glpat-FAKEtoken0123456789");
  });

  it("sortie réelle de glab 1.131 sans connexion : aucun jeton", () => {
    const out = [
      "gitlab.com",
      "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}",
      "  ✓ REST API Endpoint: https://gitlab.com/api/v4/",
      "  ! No token found (checked config file, keyring, and environment variables).",
      "  x could not authenticate to one or more of the configured GitLab instances.",
    ].join("\n");
    expect(parseGlabToken(out)).toBeNull();
  });

  it("accepte « Token found: » et un jeton OAuth (sans préfixe glpat)", () => {
    expect(parseGlabToken("✓ Token found: 4f1c9e0a7b2d4c6e8f00112233445566")).toBe("4f1c9e0a7b2d4c6e8f00112233445566");
  });

  it("ignore un jeton masqué ou absent", () => {
    expect(parseGlabToken("✓ Token found: **************************")).toBeNull();
    expect(parseGlabToken("x gitlab.com: No token provided")).toBeNull();
  });
});

describe("lecture du jeton glab", () => {
  const exec = (res: { code: number; stdout?: string; stderr?: string }, calls: string[][] = []): ExecFn =>
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "", ...res };
    };

  it("appelle glab auth status pour l'hôte configuré et lit stdout comme stderr", async () => {
    const calls: string[][] = [];
    expect(await readGlabToken("gitlab.example.com", exec({ code: 0, stderr: "  ✓ Token: glpat-stderr-token" }, calls))).toBe(
      "glpat-stderr-token",
    );
    expect(calls[0]).toEqual(["glab", "auth", "status", "--hostname", "gitlab.example.com", "--show-token"]);
    expect(await readGlabToken("gitlab.com", exec({ code: 0, stdout: "  ✓ Token: glpat-stdout-token" }))).toBe("glpat-stdout-token");
  });

  it("glab absent → message d'installation ; glab non connecté → commande de connexion", async () => {
    await expect(readGlabToken("gitlab.com", exec({ code: 127 }))).rejects.toThrow(/brew install glab/);
    const err = await readGlabToken("gitlab.com", exec({ code: 1, stderr: "x No token provided" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlabAuthError);
    expect((err as Error).message).toMatch(/glab auth login --hostname gitlab\.com/);
  });

  it("glabToken : un seul appel à glab tant que le jeton est valide, relecture sur refresh, échec non mis en cache", async () => {
    let n = 0;
    const answers = [{ code: 1 }, { code: 0, stdout: "✓ Token: glpat-first-token" }, { code: 0, stdout: "✓ Token: glpat-second-token" }];
    const provider = glabToken("gitlab.com", async () => ({ stdout: "", stderr: "", ...answers[n++]! }));
    await expect(provider.get()).rejects.toBeInstanceOf(GlabAuthError);
    expect(await provider.get()).toBe("glpat-first-token");
    expect(await provider.get()).toBe("glpat-first-token");
    expect(n).toBe(2);
    expect(await provider.refresh()).toBe("glpat-second-token");
    expect(await provider.get()).toBe("glpat-second-token");
    expect(provider.label).toBe("connexion glab (gitlab.com)");
  });

  it("glabVersion et hostOf", async () => {
    expect(await glabVersion(exec({ code: 0, stdout: "glab 1.60.0 (2026-10-01)\nextra" }))).toBe("glab 1.60.0 (2026-10-01)");
    expect(await glabVersion(exec({ code: 127 }))).toBeNull();
    expect(hostOf("https://gitlab.example.com:8443/")).toBe("gitlab.example.com:8443");
  });
});
