# SprintSaver

SprintSaver est un CLI TypeScript qui prend en charge les tickets GitLab `auto::ready` et livre une MR Ready. Les décisions sont figées dans `docs/adr/0001-architecture-sprintsaver-v1.md` : lis-le avant de changer un comportement.

## Commandes

- `npm run typecheck`, `npm test` (vitest, aucun appel réseau ni modèle) et `npm run build` (tsc vers `dist/`).
- `npm run e2e:local [-- --ci-fail] [-- --opus] [-- --keep]` : banc d'essai avec le vrai moteur, le vrai git et de **vraies sessions Claude** (cela consomme du quota), sur un GitLab simulé. À lancer après toute modification des prompts, des skills ou du moteur.
- `npm run dev -- <commande>` : exécute le CLI depuis les sources.

## Carte du code

- `src/contracts.ts` : interfaces entre modules (GitLabApi, GitOps, AgentRunner, StateStore, TicketState). Le moteur ne dépend que de ces interfaces.
- `src/engine/processor.ts` : machine à états d'un ticket (phases, boucles, blocage, rétro).
- `src/phases/schemas.ts` : sorties structurées des sessions. `src/phases/prompts.ts` construit les prompts et le contexte.
- `src/agent/` : `runner.ts` (wrapper du Claude Agent SDK), `skills.ts` (sélection déterministe), `guard-hook.ts` (garde-fou PreToolUse), `gitlab-tools.ts` (MCP GitLab en lecture seule). Pour `init` (ADR amendement 5) : `config-agent.ts` (agent de configuration, sortie structurée), `detect-commands.ts` (sous-agent des commandes et des versions de toolchain), `config-tools.ts` (outils MCP de l'agent, dont `verify_commands`).
- `src/init/` : partie déterministe de `init` autour de l'agent. `verify.ts` (exécution réelle des commandes dans un worktree jetable, politique d'exécution, extrait de sortie), `toolchains.ts` (sondes de version en lecture seule), `local-checkout.ts` (recherche bornée d'un checkout local, noms de ses fichiers ignorés), `proposal.ts` (normalisation, labels à créer, rendu de la proposition). `src/cli/init.ts` : questions, validation, `--yes`, `--dry-run` et écritures.
- `src/gitlab/` : client REST/GraphQL fait maison ; `glab-auth.ts` lit le jeton de la connexion glab (aucun jeton stocké par SprintSaver, ADR amendement 2). `src/git/gitops.ts` : clones, worktrees, commits, rebase. `src/state/` : état JSON, runs, verrou.
- `src/output-excerpt.ts` : extrait utile d'une sortie de commande ou d'un log de job CI (erreurs et fin, sans le bruit), partagé par `init` et la boucle CI.
- `src/process-env.ts` : environnement de toutes les commandes du projet (tickets, vérification d'`init`, sondes, sessions agent), sans les traces du gestionnaire de paquets qui a lancé SprintSaver.
- `src/domain/` : cases à cocher, description de MR, commentaires (textes en français), patch de recette du skill projet.
- `skills/` : skills injectés dans les sessions (phases, types, projets, et `tools/chrome` pour les phases qui pilotent Chrome, ADR amendement 4).
- `tests/` : tests vitest, même arborescence que `src/` (`tests/engine/processor.test.ts` teste `src/engine/processor.ts`). Doubles en mémoire et faux `fetch` dans `tests/helpers/`. Aucun test ni double dans `src/`.

## Règles

- ESM NodeNext : les imports relatifs prennent l'extension `.js`. TypeScript strict.
- Seul l'orchestrateur écrit sur GitLab et pousse. Les sessions agent ne commitent pas et ne poussent pas.
- Chaque changement de comportement s'accompagne d'un test vitest dans `tests/`. Le moteur se teste avec les doubles de `tests/helpers/fakes.ts`.
- Textes visibles par l'utilisateur en français. Aucun trailer `Co-Authored-By` dans les commits produits par l'outil.
