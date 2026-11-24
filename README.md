# SprintSaver

SprintSaver surveille des projets GitLab et prend en charge les tickets étiquetés `auto::ready`. Pour chacun, il écrit d'abord des tests qui prouvent les cases à cocher du ticket, puis le code. Il enchaîne ensuite des boucles autonomes de tests, de review et de CI, et livre une merge request **Ready**, assignée à l'utilisateur de l'outil.

Le travail d'ingénierie est confié à des sessions Claude (Claude Agent SDK), une par phase. Chaque session est guidée par les skills de `skills/`. L'orchestration (statuts, boucles, plafonds, git, GitLab) est du code déterministe.

Décisions d'architecture : [docs/adr/0001-architecture-sprintsaver-v1.md](docs/adr/0001-architecture-sprintsaver-v1.md).

## Prérequis

- Node.js ≥ 22 et git.
- Claude Code installé et connecté à ton compte (`claude` dans le PATH). **`ANTHROPIC_API_KEY` ne doit pas être défini** : le SDK passe par ton login Claude Code.
- La CLI GitLab **glab**, connectée à ton GitLab (voir ci-dessous).
- Pour chaque projet, de quoi lancer ses tests en local (SDK, runtime, services). Sinon, déclare le projet en `testMode: ci-only`.

### Connexion GitLab : glab

SprintSaver ne stocke aucun jeton. Il utilise la connexion de glab : c'est glab qui la crée, la range (par défaut dans le trousseau du système) et la renouvelle.

```bash
brew install glab
glab auth login --hostname gitlab.com   # jeton (scope api) ou connexion web
```

Si glab n'est pas encore connecté, `sprintsaver init` propose de lancer `glab auth login` pour toi. SprintSaver relit ensuite le jeton auprès de glab à chaque démarrage, et ne le garde qu'en mémoire. Il sert pour l'API GitLab comme pour les push git. En cas de 401, SprintSaver le relit une fois auprès de glab, ce qui couvre un jeton de connexion web arrivé à expiration.

glab peut être connecté de deux façons :

| | Personal Access Token ou connexion web (défaut) | Project Access Token |
|---|---|---|
| **Où le créer** | Préférences utilisateur → Access tokens, ou `glab auth login --web` | Projet → Settings → Access tokens |
| **Réglages** | scope `api` | scope `api`, rôle **Developer** au minimum |
| **Périmètre** | tous tes projets suivis | un seul projet |
| **Auteur des MR et des pushs** | toi | le bot du projet |
| **Assignee des MR** | toi | toi : `init` te demande ton username GitLab |

- **Project Access Token** : `init` le détecte tout seul, car `GET /user` ne répond pas pour un bot. Il te demande alors ton username pour que les MR te soient assignées. glab ne garde qu'une connexion par hôte : avec un jeton de projet, tu ne suis donc qu'un projet par hôte GitLab.
- **Commits** : dans les deux cas, ils portent ton identité git (nom et email demandés par `init`).
- **Approbation** : avec un jeton de projet, la MR est ouverte par le bot. Tu peux donc l'approuver toi-même, même si le projet interdit l'approbation par l'auteur.

`sprintsaver doctor` vérifie que glab est installé et connecté, avec quel compte, et que chaque projet est accessible avec le scope `api`. Ce scope n'est pas lisible pour une connexion web : `doctor` émet alors un avertissement, pas une erreur.

## Installation

```bash
npm install
npm run build
npm link          # rend la commande `sprintsaver` disponible
sprintsaver init  # connexion GitLab, choix des projets, config proposée et vérifiée par l'agent
sprintsaver doctor --smoke
```

Pour chaque projet, `init` lance un **agent de configuration** (ADR, amendement 5) qui propose toute la config du projet, en quelques minutes :
- **commandes de setup, build et test qui marchent sur ta machine** : un sous-agent relève les versions de toolchain exigées par le dépôt (CI, Dockerfile, `.nvmrc`, `.python-version`, `global.json`, manifestes, README…), les compare à ce que ta machine fournit, et écrit des commandes qui fixent la version au lieu de dépendre du runtime par défaut du PATH (de préférence avec un gestionnaire de versions déjà installé : mise, fnm, volta, nvm, pyenv, uv, sdkman…). Ce qui manque est listé en **prérequis**. SprintSaver **exécute réellement** ces commandes dans un worktree jetable de la branche par défaut (trois tentatives au plus) et distingue une commande cassée de tests déjà rouges sur la branche par défaut. Rien n'est installé globalement ;
- **checkout local** (d'où copier `.env` et dépendances), mode de test, pipeline surveillé, dossiers de dépendances, et **fichiers ignorés à copier** : ceux qu'il faut pour lancer les tests et l'application en local (config d'environnement, secrets de dev). L'agent n'en voit que les noms, jamais le contenu, et propose d'office le pendant d'un fichier d'exemple versionné (`.env` pour `.env.example`) ;
- **les trois statuts** (en cours, livré en review, bloqué), chacun sur un statut natif GitLab ou sur un label (`sprintsaver::en-cours`, `sprintsaver::en-review`, `sprintsaver::bloque` à créer si rien ne convient), et les labels `bug` et `feature`.

`init` affiche la proposition complète, avec le résultat de la vérification réelle et les prérequis. Tu valides, modifies un champ, relances la vérification ou annules. Les labels manquants (et `auto::ready`) ne sont créés, et la config écrite, qu'après validation. Les agents n'ont que la lecture du dépôt : ils n'exécutent rien eux-mêmes et n'écrivent jamais sur GitLab. Si l'agent échoue, la détection simple et les questions champ par champ prennent le relais (`--no-agent` pour le forcer).

Sans question : `sprintsaver init --yes --project groupe/projet` accepte les propositions. `--dry-run` n'écrit rien sur GitLab ni dans la config et affiche la config produite (ou l'écrit dans `--output <fichier>`). Voir `sprintsaver init --help`. Relance `init` sur un projet quand ton environnement change (mise à jour d'un runtime, nouveau gestionnaire de versions) : ses commandes sont revérifiées.

La config est écrite dans `~/.sprintsaver/config.yaml`, sans aucun jeton. Elle reste modifiable à la main.

**Fichiers non versionnés (`.env`, config locale…).** Chaque ticket est traité dans un worktree neuf qui ne contient pas ces fichiers. SprintSaver les y copie :
- **quels fichiers** : ceux listés dans le `.worktreeinclude` versionné du dépôt (convention Claude Code, syntaxe `.gitignore`), sinon ceux de `worktreeInclude` dans la config ;
- **depuis où** : ton checkout habituel du projet si tu renseignes `localCheckout` (demandé par `init`), sinon le clone interne `~/.sprintsaver/repos/<projet>`. Les dossiers `cowDirs` (ex. `node_modules`) sont clonés en copy-on-write depuis la même source.

Git ≥ 2.30 est requis (`--force-if-includes`).

## Utilisation

| Commande | Effet |
|---|---|
| `sprintsaver watch` | Boucle continue : interroge GitLab toutes les 2 min et traite un ticket à la fois. Un premier Ctrl+C arrête après la phase en cours, un second quitte immédiatement. |
| `sprintsaver run <projet>#<iid>` | Traite tout de suite ce ticket, qu'il ait le label ou non. Utile pour mettre au point les skills. |
| `sprintsaver status` | Affiche le ticket en cours, les tickets bloqués (avec la raison), les livraisons récentes et la file d'attente. |
| `sprintsaver doctor [--smoke]` | Vérifie la config, git, glab et sa connexion à chaque projet, et Claude Code. Avec `--smoke`, lance une mini-session Claude. |

### Cycle de vie d'un ticket

1. Tu poses `auto::ready` sur un ticket qui contient des cases à cocher (`- [ ] …`).
2. SprintSaver retire le label, passe le ticket « en cours » et l'analyse. Il commente son plan et son classement des critères (testables ou non).
3. Il écrit les tests (red), puis le code. Il boucle sur les tests jusqu'au vert, puis sur la review jusqu'à zéro finding bloquant.
4. Il pousse la branche `sprintsaver/<iid>-…` et ouvre une MR Draft, puis boucle sur la CI.
5. Il rebase sur la branche par défaut et rédige la MR. Si le changement touche l'interface, il lance l'application avant et après le ticket et met les captures côte à côte dans la MR ; s'il touche des données ou une API, il montre chaque contrat en diff avant/après.
6. Il passe la MR en Ready et te l'assigne, coche les critères prouvés sur le ticket et passe celui-ci « livré en review ».

Si un plafond est atteint, si une question bloque ou si la CI de la branche par défaut est cassée, le ticket passe « bloqué » avec un commentaire. Le worktree est conservé dans `~/.sprintsaver/worktrees/`. Pour relancer, réponds si besoin, puis **remets `auto::ready`** : SprintSaver reprend sur la branche existante.

## Données locales (`~/.sprintsaver/`)

| Chemin | Contenu |
|---|---|
| `config.yaml` | Configuration |
| `state/<projet>-<iid>.json` | État d'un ticket. Le supprimer, avec la branche, force un redémarrage complet. |
| `repos/<projet>` | Clones de référence |
| `worktrees/<projet>-<iid>` | Worktrees en cours ou bloqués (`<projet>-<iid>.avant` : version de base, le temps des captures d'écran) |
| `runs/<projet>-<iid>/` | Transcripts des sessions (purgés après 30 jours), `summaries.jsonl`, `retro.md`, `retro.patch` |
| `sprintsaver.log` | Journal |

## Améliorer les skills

- `skills/phases/<phase>/SKILL.md` : méthode de chaque phase.
- `skills/types/{bug,feature}/SKILL.md` : spécificités par type de ticket.
- `skills/projects/<projet>.md` : connaissances propres à un projet, dont la façon de lancer l'application pour les captures d'écran (section « Captures d'écran »).

Les captures avant/après se coupent avec `screenshots.enabled: false` dans la config. Elles demandent un navigateur headless sur le poste : Playwright dans les dépendances du dépôt, ou Google Chrome.

Après chaque ticket, la rétro (désactivable avec `retro.enabled: false`) propose un patch dans `~/.sprintsaver/runs/<projet>-<iid>/retro.patch`. Relis-le, puis applique-le depuis ce dépôt :

```bash
git apply ~/.sprintsaver/runs/<projet>-<iid>/retro.patch
```

Les skills sont au format SKILL.md de Claude Code : tu peux aussi les tester à la main dans une session interactive.

## Développement

```bash
npm run dev -- status   # exécuter depuis les sources
npm run typecheck
npm test
```

## Limites connues (v1)

- Aucune restriction sur qui peut poser `auto::ready`, et les sessions tournent en `bypassPermissions` sans sandbox (un garde-fou bloque seulement les push et les écritures hors du worktree).
- Les commentaires de review sur la MR ne sont pas repris automatiquement.
- Un seul ticket est traité à la fois, et seulement quand ton poste est allumé avec `watch` lancé.
