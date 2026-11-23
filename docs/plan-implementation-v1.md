# Plan d'implémentation — SprintSaver v1

Référence : [ADR 0001](adr/0001-architecture-sprintsaver-v1.md). Ce plan découpe la v1 en jalons livrables l'un après l'autre. Chaque jalon se termine par un critère « c'est fini quand… » vérifiable à la main sur un projet GitLab réel.

## Stack technique

| Besoin | Choix |
|---|---|
| Runtime | Node.js ≥ 22, TypeScript strict, ESM |
| Exécution en dev | `tsx` ; build `tsc -p tsconfig.build.json` ; `npm link` pour la commande `sprintsaver` |
| CLI | `commander` |
| Prompts interactifs (`init`) | `@inquirer/prompts` |
| Config | `yaml` + validation `zod` |
| GitLab REST et GraphQL | client `fetch` typé maison (`src/gitlab/rest.ts`) |
| Git | `execa` sur le binaire `git` (worktree, rebase, push) |
| Claude | `@anthropic-ai/claude-agent-sdk` (`query`, `tool`, `createSdkMcpServer`) |
| Logs | `pino` (fichier + console) |
| Tests unitaires de l'outil | `vitest` |

## Arborescence cible

```
src/
  cli/            init.ts, watch.ts, run.ts, status.ts, index.ts
  config/         schema.ts (zod), load.ts, paths.ts
  gitlab/         client.ts, issues.ts, statuses.ts (GraphQL), mrs.ts, pipelines.ts, search.ts
  git/            repo.ts (clone/fetch), worktree.ts, commits.ts, rebase.ts
  state/          store.ts (JSON par ticket), types.ts
  engine/         machine.ts (états + transitions), queue.ts, limits.ts, ticket.ts
  phases/         analyse.ts, write-tests.ts, implement.ts, test-fix.ts, review.ts,
                  verify-criteria.ts, ci.ts, finalize.ts, retro.ts
  agent/          runner.ts (wrapper query()), skills.ts (sélection + injection),
                  gitlab-tools.ts (MCP lecture seule), guard-hook.ts, transcripts.ts, summary.ts
  domain/         checkboxes.ts (parse/coche), mr-description.ts, comments.ts
skills/
  phases/<nom>/SKILL.md
  types/<nom>/SKILL.md
  projects/<projet>.md
docs/
```

## Principes transverses

- **Chaque phase agent** est un appel `query()` qui reçoit :
  - `cwd` = le worktree ;
  - `model` et `effort` lus dans la config ;
  - `settingSources: []` ;
  - `systemPrompt: { type: 'preset', preset: 'claude_code', append: <skills + CLAUDE.md cible + contexte du ticket> }` ;
  - `permissionMode: 'bypassPermissions'` avec `allowDangerouslySkipPermissions: true` ;
  - `hooks.PreToolUse` = le garde-fou ;
  - `mcpServers: { gitlab: <serveur lecture seule> }` ;
  - `outputFormat` : un JSON Schema propre à la phase ;
  - `maxTurns`.
- **Sortie de phase** : un JSON validé par zod (par ex. `{ status: 'done' | 'blocked', tests: [...], findings: [...] }`). L'orchestrateur ne décide jamais à partir de texte libre.
- **Vérifications faites par l'orchestrateur lui-même**, sans croire l'agent sur parole :
  - suite de tests verte : il exécute `testCommand` et lit le code de sortie ;
  - cases cochées : il ne coche que celles confirmées par `verify-criteria` ;
  - CI verte : il lit le statut du pipeline.
- **Idempotence** : chaque transition écrit le fichier d'état avant de passer à la suite. `watch` et `run` reprennent à la phase enregistrée.

> Les noms d'options du SDK viennent de la doc TypeScript de l'Agent SDK (`code.claude.com/docs/en/agent-sdk/typescript`). La forme exacte du retour de hook `PreToolUse` et du message `result` (`structured_output`, `num_turns`, `total_cost_usd`, `subtype`) est à confirmer contre la doc au jalon 4.

---

## Jalon 0 — Socle du projet

- `package.json`, `tsconfig`, scripts `dev` / `build` / `test` / `lint`, bin `sprintsaver`.
- Chargement de la config : chemins `~/.sprintsaver/{config.yaml,state,repos,worktrees,runs}`, schéma zod complet (ADR § 12) et valeurs par défaut (plafonds, modèles).
- Logger pino : console lisible et fichier `~/.sprintsaver/sprintsaver.log`.

**Fini quand** : `sprintsaver --help` liste les quatre commandes et une config invalide produit une erreur lisible.

## Jalon 1 — Client GitLab et `init`

- Client gitbeaker authentifié par PAT, avec vérification du token et du username au démarrage.
- `init` :
  1. demande le token et lit l'utilisateur courant ;
  2. liste les projets accessibles et propose une sélection multiple ;
  3. pour chaque projet :
     - branche par défaut ;
     - détection du stack à partir des fichiers racine (`package.json`, `*.csproj`/`*.sln`, `pom.xml`, `pyproject.toml`…) et proposition des commandes de setup, de build et de test ;
     - lecture de `.gitlab-ci.yml` pour savoir si la CI tourne sur `merge_request_event` ou sur les branches ;
     - détection de `.worktreeinclude` ;
  4. **statuts** : requête GraphQL sur les statuts de work item disponibles, puis mapping interactif des rôles *en cours*, *livré en review* et *bloqué*. Sans statut natif, mapping sur des labels existants ;
  5. mapping type ↔ labels (proposition à partir des labels existants contenant `bug`, `feature`…) ;
  6. création du label `auto::ready` s'il manque ;
  7. écriture de `config.yaml`, puis affichage du résumé.
- Module `statuses.ts` : `getStatus` / `setStatus(issue, rôle)` par GraphQL, avec repli sur les labels.

**Fini quand** : `init` sur un vrai projet produit une config correcte, le label existe et `setStatus` change le statut d'un ticket de test.

## Jalon 2 — Moteur, état et file

- `state/store.ts` : lecture et écriture atomiques (fichier temporaire puis `rename`) de `state/<projet>-<iid>.json`. Schéma : phase, compteurs, branche, `mrIid`, horodatages, raison de blocage.
- `engine/queue.ts` : liste les tickets ouverts portant `auto::ready` dans les projets configurés, puis les trie FIFO selon la date d'ajout du label (`resource_label_events`).
- `engine/machine.ts`, avec les états :
  `picked → prepared → analysed → tests_written → implemented → tests_green → reviewed → pushed → ci_green → finalized`, plus `blocked`. Chaque état appelle une fonction de phase ; en v0, les phases agent sont des **stubs** qui renvoient `done`.
- `engine/limits.ts` : compteurs par boucle et durée totale. Un dépassement déclenche le chemin `blocked`.
- Commandes :
  - `watch` : boucle de polling, un ticket à la fois, arrêt propre sur Ctrl+C ;
  - `run <projet>#<iid>` : force un ticket ;
  - `status` : affiche le ticket en cours et la file.
- Chemin `blocked` commun : push WIP, statut *bloqué*, commentaire, worktree conservé.

**Fini quand** : avec les stubs, un ticket étiqueté traverse toute la machine. Le label est retiré, les statuts changent, et un Ctrl+C au milieu suivi d'une relance reprend à la bonne phase.

## Jalon 3 — Git et worktrees

- `repo.ts` : clone de référence au premier usage, puis `fetch` avant chaque ticket.
- `worktree.ts` :
  - création de `worktrees/<projet>-<iid>` sur `sprintsaver/<iid>-<slug>` depuis `origin/<défaut>`, ou réutilisation de la branche existante en cas de reprise ;
  - **préparation** : copie des fichiers du `.worktreeinclude` (ou de la liste de config), clonage copy-on-write (`cp -c`) des dossiers de dépendances déclarés, exécution de `setupCommand` ;
  - suppression via `git worktree remove`.
- `commits.ts` : commit conventionnel à l'identité git de l'utilisateur, sans trailer.
- `rebase.ts` : rebase sur `origin/<défaut>`, détection des conflits, `push --force-with-lease`.

**Fini quand** : un worktree préparé fait passer `testCommand` sur un projet réel, et la suppression ne laisse rien derrière.

## Jalon 4 — Runner agent

- `agent/runner.ts` : wrapper de `query()` qui reçoit phase, type, projet, prompt et schéma de sortie, et renvoie la sortie validée par zod, le nombre de tours, la durée et le coût estimé.
- `agent/skills.ts` : table de sélection phase × type → fichiers `SKILL.md` (sans frontmatter), plus `projects/<projet>.md` et le `CLAUDE.md` du worktree s'il existe. Le tout est concaténé dans `systemPrompt.append`, avec la liste des skills chargés journalisée.
- `agent/gitlab-tools.ts` : serveur MCP in-process (`createSdkMcpServer`) avec des outils annotés `readOnlyHint` :
  - `search_issues(query, state)` ;
  - `get_issue(iid)` ;
  - `get_issue_closing_mrs(iid)` ;
  - `get_mr_diff(iid)` ;
  - `get_job_log(jobId)`.
- `agent/guard-hook.ts` : hook `PreToolUse` sur `Bash`, `Write` et `Edit`. Il refuse `git push` ainsi que `git remote`/`fetch`/`pull` vers l'extérieur, et tout chemin hors du worktree.
- `agent/transcripts.ts` : chaque message du flux est écrit dans `runs/<projet>-<iid>/<phase>-<n>.jsonl` (désactivable), avec purge des runs de plus de 30 jours au démarrage de `watch`.
- `agent/summary.ts` : résumé factuel de phase produit par l'orchestrateur, au format JSON, dans `runs/.../summary.json`.

**Fini quand** : une phase de test (« liste les fichiers de test du projet ») tourne dans un worktree avec les bons skills injectés et une sortie structurée valide, le garde-fou bloque un `git push` volontaire, et le transcript est écrit.

## Jalon 5 — Phases d'ingénierie

| Phase | Entrée | Sortie structurée | Contrôle par l'orchestrateur |
|---|---|---|---|
| `analyse` | ticket, commentaires, images téléchargées dans le worktree (`.sprintsaver/`, ignoré par git), tickets liés | type, cases `[{index, texte, testable, raison}]`, précédents retenus/écartés, plan, ambiguïtés bloquantes, hypothèses | ambiguïté bloquante ou zéro case → `blocked`, sinon commentaire de prise en charge |
| `write-tests` | analyse | tests `[{nom, fichier, caseIndex, ajouté\|modifié, explication}]`, preuve red | commit `test:` |
| `implement` | analyse + tests | résumé | commit `feat:`/`fix:` |
| `test-fix` (boucle) | sortie de `testCommand` | correctifs | `testCommand` vert, sinon itération (max 5) |
| `review` (session neuve) | diff vs base, analyse, cases | findings `[{sévérité: bloquant\|nit, fichier, ligne, description}]` | bloquants → session de correction puis `testCommand`, re-review (max 3) |
| `verify-criteria` (session neuve) | cases testables + tests associés | `[{caseIndex, prouvé: bool, raison}]` | case non prouvée → finding bloquant, retour en boucle de review |

- `domain/checkboxes.ts` : extraction des cases de la description (hors blocs de code), avec un index stable, et réécriture de la description avec les cases prouvées cochées.
- Pour un ticket de type `bug`, `write-tests` doit inclure un test qui reproduit le défaut.

**Fini quand** : sur un ticket simple d'un vrai projet, l'outil produit en local des tests red puis green, une review sans finding bloquant et une vérification critères ↔ tests positive.

## Jalon 6 — Push, MR, CI, finalisation

- Premier push, puis création de la MR `Draft: <titre> (#iid)` avec `Closes #iid`.
- `pipelines.ts` : attente du pipeline de la MR, ou de la branche selon la config. Ensuite :
  - en cas d'échec, relance unique des jobs en échec ;
  - si l'échec persiste, lecture du dernier pipeline de la branche par défaut : s'il est rouge, `blocked` avec le commentaire « CI de `<branche>` cassée » ;
  - sinon, session `ci-fix` avec les logs, commit `fix(ci):`, re-review sur le delta, push (max 3).
- Projets en mode `ci-only` : `test-fix` passe par la même boucle de pushes.
- `finalize` : rebase (avec conflits → session agent → tests → review sur le delta → CI), puis :
  - description finale de la MR (`domain/mr-description.ts`, alimentée par la session `mr-writeup`) ;
  - retrait du préfixe Draft et assignation de la MR à l'utilisateur ;
  - cases cochées sur le ticket, statut *livré en review*, commentaire de livraison ;
  - suppression du worktree.

**Fini quand** : un ticket réel aboutit à une MR Ready, assignée, avec une CI verte, une description conforme à l'ADR et les cases cochées sur le ticket.

## Jalon 7 — Skills v0

Écrire une première version courte et testable de chaque skill :

- **phases** : analyse, write-tests, implement, test-fix, review (grille de sévérité de l'ADR § 7), verify-criteria, ci-fix, mr-writeup, retro ;
- **types** : `bug` (repro-first, méthode de recherche de précédents via les outils MCP et `git log -S/--grep`/`blame`, jugement de pertinence), `feature` ;
- **projects** : un fichier squelette par projet configuré, avec les sections « conventions », « commandes », « pièges connus ».

Chaque skill doit aussi pouvoir s'utiliser à la main dans Claude Code, pour les mettre au point hors de l'orchestrateur.

**Fini quand** : chaque phase charge un skill réel et un ticket bug comme un ticket feature passent de bout en bout.

## Jalon 8 — Rétro

- Phase `retro` (Sonnet), si `retro.enabled` : elle lit uniquement les `summary.json` des phases du ticket et écrit dans `runs/<projet>-<iid>/` :
  - `retro.md` : ce qui a coûté des itérations, et ce qu'il aurait fallu savoir ;
  - `retro.patch` : diff proposé sur `skills/`, en priorité `projects/<projet>.md`.
- L'outil affiche le chemin du patch ; l'utilisateur relit et applique avec `git apply` dans le dépôt SprintSaver.
- La rétro tourne aussi après un `blocked`, car c'est là qu'elle apporte le plus.

**Fini quand** : après un ticket, un patch lisible et applicable est proposé, et `retro.enabled: false` désactive bien la phase.

---

## Ordre et dépendances

```
J0 → J1 → J2 → J3 → J4 → J5 → J6 → J8
                       ↘ J7 (en parallèle de J5–J6, une fois J4 posé)
```

J2 avec des stubs donne tôt un squelette qui tourne de bout en bout. Ensuite, chaque jalon remplace des stubs par du réel.

## Points à confirmer pendant l'implémentation

- Forme exacte de la mutation GraphQL du statut des work items sur gitlab.com (J1).
- Forme du retour `PreToolUse` pour refuser un appel, et champs du message `result` du SDK (J4).
- Comportement de `outputFormat` quand l'agent n'arrive pas à produire un JSON valide : prévoir une nouvelle tentative puis `blocked` (J4).
