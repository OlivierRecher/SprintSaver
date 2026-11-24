import { describe, expect, it } from "vitest";
import { cleanPath, projectCommandEnv } from "../src/process-env.js";

/** Environnement réellement observé sous `npm run dev` (tsx), réduit. */
const npmScriptEnv = {
  HOME: "/Users/me",
  SHELL: "/bin/zsh",
  NVM_DIR: "/Users/me/.nvm",
  NPM_CONFIG_REGISTRY: "https://registry.example.com", // réglage de l'utilisateur : gardé
  EDITOR: "vim",
  INIT_CWD: "/Users/me/work/SprintSaver",
  NODE: "/opt/homebrew/bin/node",
  COLOR: "0",
  npm_command: "run-script",
  npm_config_prefix: "/opt/homebrew",
  npm_config_local_prefix: "/Users/me/work/SprintSaver",
  npm_config_user_agent: "npm/11.0.0 node/v26.10.0 darwin arm64",
  npm_execpath: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
  npm_node_execpath: "/opt/homebrew/bin/node",
  npm_lifecycle_event: "dev",
  npm_lifecycle_script: "tsx src/cli/index.ts",
  npm_package_name: "sprintsaver",
  npm_package_json: "/Users/me/work/SprintSaver/package.json",
  PATH: [
    "/Users/me/work/SprintSaver/node_modules/.bin",
    "/Users/me/work/SprintSaver/node_modules/.bin",
    "/Users/me/work/node_modules/.bin",
    "/Users/me/node_modules/.bin",
    "/Users/node_modules/.bin",
    "/node_modules/.bin",
    "/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
    "/Users/me/.local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ].join(":"),
};

describe("environnement des commandes du projet", () => {
  it("retire les traces d'un script npm : variables npm_*, INIT_CWD, NODE, COLOR et entrées du PATH ajoutées", () => {
    const env = projectCommandEnv(npmScriptEnv);
    expect(Object.keys(env).filter((k) => k.startsWith("npm_"))).toEqual([]);
    expect(env.INIT_CWD).toBeUndefined();
    expect(env.NODE).toBeUndefined();
    expect(env.COLOR).toBeUndefined();
    expect(env.PATH).toBe("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin");
    expect(env).toMatchObject({ HOME: "/Users/me", SHELL: "/bin/zsh", NVM_DIR: "/Users/me/.nvm", NPM_CONFIG_REGISTRY: "https://registry.example.com", EDITOR: "vim" });
  });

  it("lancé par le binaire global : environnement identique à celui obtenu sous npm run", () => {
    const direct = {
      HOME: "/Users/me",
      SHELL: "/bin/zsh",
      NVM_DIR: "/Users/me/.nvm",
      NPM_CONFIG_REGISTRY: "https://registry.example.com",
      EDITOR: "vim",
      PATH: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    };
    expect(projectCommandEnv(direct)).toEqual(projectCommandEnv(npmScriptEnv));
  });

  it("hors script npm : NODE et un node_modules/.bin posés par l'utilisateur restent", () => {
    const env = projectCommandEnv({ NODE: "/x/node", PATH: "/Users/me/tools/node_modules/.bin:/usr/bin", npm_config_cache: "/c" });
    expect(env).toEqual({ NODE: "/x/node", PATH: "/Users/me/tools/node_modules/.bin:/usr/bin" });
  });

  it("variables de yarn et pnpm retirées aussi", () => {
    expect(projectCommandEnv({ PROJECT_CWD: "/p", BERRY_BIN_FOLDER: "/b", HOME: "/h" })).toEqual({ HOME: "/h" });
  });

  it("cleanPath sans paquet connu ne retire que node-gyp-bin", () => {
    expect(cleanPath("/a/node_modules/.bin:/x/@npmcli/run-script/lib/node-gyp-bin:/usr/bin", { npm_lifecycle_event: "x" })).toBe("/a/node_modules/.bin:/usr/bin");
  });
});
