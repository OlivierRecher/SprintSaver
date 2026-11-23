/** Point de composition : seul module qui importe les implémentations concrètes. */
import type { AgentRunner, GitLabApi, GitOps, RunRecorder, StateStore } from "./contracts.js";
import type { Config } from "./config/schema.js";
import { createGitLabApi } from "./gitlab/api.js";
import { glabToken, hostOf } from "./gitlab/glab-auth.js";
import { createGitOps } from "./git/gitops.js";
import { createStateStore } from "./state/store.js";
import { createRunRecorder, purgeOldRuns } from "./state/runs.js";
import { createAgentRunner } from "./agent/runner.js";
import { agentSmokeTest } from "./agent/smoke.js";
import { createTicketProcessor, type TicketProcessor } from "./engine/processor.js";

export interface App {
  config: Config;
  gitlab: GitLabApi;
  git: GitOps;
  agent: AgentRunner;
  store: StateStore;
  recorder: RunRecorder;
  processor: TicketProcessor;
  purgeOldRuns: (days: number) => Promise<unknown>;
}

export function buildApp(config: Config): App {
  // Une seule connexion, celle de glab : l'API et git relisent le même jeton (ADR, amendement 2).
  const token = glabToken(hostOf(config.gitlab.url));
  const gitlab = createGitLabApi(config, {}, token);
  const git = createGitOps({
    token,
    authorName: config.git.authorName,
    authorEmail: config.git.authorEmail,
  });
  const agent = createAgentRunner({ config, gitlab });
  const store = createStateStore();
  const recorder = createRunRecorder();
  const processor = createTicketProcessor({ config, gitlab, git, agent, store, recorder });
  return { config, gitlab, git, agent, store, recorder, processor, purgeOldRuns };
}

/** Session agent de test (doctor --smoke). */
export function runAgentSmokeTest(cwd: string): ReturnType<typeof agentSmokeTest> {
  return agentSmokeTest(cwd);
}
