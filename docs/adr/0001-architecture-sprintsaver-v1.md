# ADR 0001 — Architecture de SprintSaver v1

- **Statut** : accepté
- **Date** : 2026-11-23

## Contexte

On veut un outil qui surveille des projets GitLab, prend en charge les tickets marqués d'un label, et les mène jusqu'à une merge request prête à relire : tests qui prouvent les critères du ticket, code, boucles de tests et de review autonomes, CI verte. L'utilisateur relit ensuite la MR comme celle d'un collègue.

Le travail d'ingénierie (comprendre, tester, coder, relire) est confié à Claude. Les skills qui guident ce travail doivent pouvoir être améliorés au fil des tickets, sans toucher à l'orchestration.

Environnement de départ : gitlab.com (tier Premium), un Mac de développeur avec Claude Code connecté à un compte Claude entreprise, des projets cibles de stacks variées.

## Décisions

### 1. Un orchestrateur déterministe qui pilote des sessions Claude

SprintSaver est un **CLI Node.js écrit en TypeScript**. Le code de l'orchestrateur gère tout ce qui doit être fiable : interrogation de GitLab, machine à états, compteurs d'itérations, plafonds, attente de la CI, écritures sur GitLab, git push.

Claude n'intervient que dans les phases d'ingénierie, via le **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). Chaque phase est une session distincte, avec ses propres skills, son modèle et sa sortie structurée.

**Pourquoi** : une boucle « jusqu'à zéro finding » ou « jusqu'à CI verte » pilotée par un prompt peut s'oublier, se contourner ou tourner sans fin. Dans le code, elle se teste. Cette séparation permet aussi de faire évoluer les skills sans toucher à l'orchestration.

### 2. Authentification Claude par le login Claude Code existant

Pas de clé API. Le SDK s'appuie sur le CLI `claude` installé et sur sa session (compte entreprise). `ANTHROPIC_API_KEY` ne doit pas être défini dans l'environnement de l'outil.

Conséquence : on ne plafonne pas un budget en dollars. Les plafonds portent sur les itérations et la durée (§ 8). Le coût estimé que renvoie le SDK est seulement journalisé.

### 3. Exécution locale, par polling, un ticket à la fois

- L'outil tourne sur le poste de l'utilisateur, lancé à la main (`sprintsaver watch`). Pas de webhook ni de service système en v1.
- Il interroge GitLab toutes les ~2 minutes.
- Il traite **un seul ticket à la fois**. Les autres attendent dans une file **FIFO**, triée par date d'ajout du label (tous projets confondus).

### 4. GitLab : déclencheur, statut, identité

- **Déclencheur** : le label `auto::ready`. C'est le seul label créé par l'outil, au moment de `init`.
- **Verrou** : l'outil retire `auto::ready` dès la prise en charge. Pour relancer un ticket bloqué, l'utilisateur remet le label.
- **Statut** : on utilise le champ Status natif des work items (GraphQL). `init` détecte les statuts disponibles et fait mapper trois rôles : *en cours*, *livré en review*, *bloqué*. Chaque rôle a sa propre cible, statut natif **ou** label : une instance qui n'a qu'un statut natif « In progress » mappe *en cours* dessus et les deux autres rôles sur des labels, que `init` propose de créer.
- **Identité** : on utilise par défaut le Personal Access Token de l'utilisateur (scope `api`). La branche, les commits et la MR sont à son nom. La MR lui est **assignée** (assignee). Pas de reviewer. Un Project Access Token est accepté en alternative (voir l'amendement 1). Le jeton n'est jamais stocké par SprintSaver : la connexion est celle de glab (voir l'amendement 2).
- **Écritures** : seul l'orchestrateur écrit sur GitLab et pousse sur le remote. Les sessions Claude ont un accès GitLab en **lecture seule**, via des outils MCP exposés par l'orchestrateur : recherche de tickets, lecture de tickets, de MR et de diffs.
- **Ticket gelé** : on considère que personne ne modifie le ticket pendant son traitement. L'outil ne le relit pas entre les phases.
- **Commentaires** : trois au maximum par passage sur le ticket :
  - **prise en charge** : plan, type retenu, classement des cases en testable ou non testable ;
  - **blocage ou besoin d'info** : cause et questions ;
  - **livraison** : lien vers la MR et résumé.

### 5. Critères d'acceptation = les cases à cocher du ticket

- Les critères sont **toutes les cases à cocher markdown** de la description (`- [ ]`, `* [ ]`), où qu'elles se trouvent. Le texte autour peut être libre et les cases dans les blocs de code sont ignorées.
- La phase d'analyse classe chaque case comme **testable** ou **non testable**.
- Une case n'est cochée que si un test la prouve et que la vérification indépendante (§ 7) l'a confirmé. C'est l'orchestrateur qui coche les cases à la livraison.
- Les cases non testables restent décochées. Elles sont listées dans la MR avec une raison d'une ligne et **ne bloquent pas** la livraison.
- S'il n'y a aucune case, ou en cas d'ambiguïté bloquante, l'outil passe le ticket en *bloqué*, pose ses questions en commentaire et mentionne l'auteur. Les ambiguïtés mineures sont tranchées par des hypothèses documentées dans la MR.

### 6. Worktrees isolés et préparés

- Un **clone de référence** par projet : `~/.sprintsaver/repos/<projet>`.
- Un **worktree par ticket** : `~/.sprintsaver/worktrees/<projet>-<iid>`, sur la branche `sprintsaver/<iid>-<slug>`, créée depuis la branche par défaut fraîchement fetchée.
- **Préparation**, avant toute session agent :
  - copie des fichiers ignorés par git listés dans le `.worktreeinclude` du dépôt (convention Claude Code), sinon dans la liste de la config ;
  - exécution de la commande de setup du projet ;
  - clonage copy-on-write (APFS, `cp -c`) des dossiers de dépendances lourds déclarés dans la config.
- **Nettoyage** : le worktree est supprimé une fois la MR passée en Ready. Il est **conservé** si le ticket est bloqué, pour inspection. La branche reste toujours sur le remote.
- **Reprise** : quand `auto::ready` est remis, l'outil reprend sur la branche existante. Il refait l'analyse en tenant compte des nouveaux commentaires et remet les compteurs à zéro. Pour repartir de zéro, il suffit de supprimer la branche et le fichier d'état.

### 7. Déroulé d'un ticket

1. **Prise en charge** : retrait du label, statut *en cours*, worktree préparé.
2. **Analyse** : lecture de la description, de tous les commentaires, des images jointes et des tickets liés (un seul niveau). Le type vient du type GitLab et des labels, via un mapping de config, avec une classification par Claude en repli. Recherche de précédents (§ 9). Classement des cases. Commentaire de prise en charge.
3. **Écriture des tests, red-first** : les tests sont écrits avant le code et doivent échouer. Pour un bug, on commence par un test qui reproduit le défaut.
4. **Implémentation**, puis **boucle test/fix** jusqu'à ce que toute la suite passe en local.
5. **Boucle de review** :
   - une session **neuve**, sans le contexte du codeur, relit le diff ;
   - une session de **vérification des critères** contrôle que chaque test associé à une case asserte réellement ce critère.
   - La boucle s'arrête quand il n'y a plus de finding **bloquant** : bug, critère non couvert, faille de sécurité, régression. Les nits restants vont dans la MR.
6. **Push et MR Draft**, puis **boucle CI** :
   - un job en échec est d'abord relancé une fois, pour écarter un test instable ;
   - s'il échoue encore, l'outil regarde le dernier pipeline de la branche par défaut. Si elle est rouge, il **coupe immédiatement** : statut *bloqué*, commentaire « CI de `<branche>` cassée, indépendante du ticket » ;
   - sinon, les logs des jobs en échec partent à la session `ci-fix`. Tout changement de code fait par la CI déclenche une passe de review sur le delta.
   - Il n'y a pas de vérification de la CI de la branche par défaut avant la prise en charge.
   - Un pipeline **en attente faute de runner** (statut `pending`, tous ses jobs en attente marqués `stuck` par GitLab : aucun runner en ligne ne peut les prendre) n'est pas attendu jusqu'au plafond de temps : la phase CI est sautée, le commit est accepté comme pour un projet sans CI, et la MR porte une section « CI non exécutée » avec le lien du pipeline. Une CI verte sur un commit suivant retire la mention. Le pipeline n'est pas annulé : il partira si un runner revient.
7. **Finalisation** :
   - rebase sur la branche par défaut ; en cas de conflit, résolution par l'agent puis nouvelle passe de tests, de review sur le delta et de CI ;
   - MR passée en **Ready** et assignée à l'utilisateur ;
   - cases prouvées cochées sur le ticket, statut *livré en review*, commentaire de livraison, suppression du worktree.

**Commits** : un commit par étape logique au format conventional commits (`test:`, `feat:`/`fix:`, `fix(review):`, `fix(ci):`), à l'identité git de l'utilisateur, **sans trailer de co-auteur**.

**Description de la MR** :

```
## Ticket #<iid>
## Captures avant / après, changements de données et d'API (amendement 3)
## Critères
- [x] <critère> → `<test>` : ce qu'il vérifie
- [ ] <critère> (non testable : <raison>)
## Tests ajoutés / modifiés
- `<test>` (ajouté|modifié) : une ligne d'explication
## Hypothèses, nits restants, jobs instables
```

### 8. Plafonds et échec

Valeurs par défaut, modifiables dans la config :

| Plafond | Défaut |
|---|---|
| Itérations test/fix | 5 |
| Itérations de review | 3 |
| Itérations CI | 3 |
| Durée totale par ticket | 3 h |

Quand un plafond est atteint, l'outil pousse la branche WIP, passe le ticket en *bloqué*, commente avec un résumé de ce qui bloque et passe au ticket suivant.

Un fichier d'état JSON par ticket (`~/.sprintsaver/state/<projet>-<iid>.json`) enregistre la phase atteinte, les compteurs, la branche et l'id de la MR. Il permet de reprendre après un crash ou un Ctrl+C. On n'utilise pas de base de données : un seul ticket à la fois ne le justifie pas, et un fichier JSON se lit et se corrige à la main.

### 9. Skills

- Format **SKILL.md standard de Claude Code**, versionnés dans le dépôt SprintSaver :

  ```
  skills/
    phases/    analyse, write-tests, implement, test-fix, review,
               verify-criteria, ci-fix, mr-writeup, ui-captures, retro
    types/     bug, feature
    projects/  <projet>.md
  ```

- **Sélection déterministe** : l'orchestrateur choisit les skills de chaque session (phase + type + projet) et les injecte dans le prompt système. Le SDK est lancé avec `settingSources: []` pour qu'aucun skill ou réglage personnel ne s'ajoute de façon implicite. Le `CLAUDE.md` du dépôt cible, s'il existe, est injecté explicitement.
- **Types en v1** : `bug` et `feature`. Tout le reste passe par le flux `feature`.
- **Précédents** (skill `bug` en priorité, disponible aussi pour `feature`) : recherche de tickets fermés du même projet par mots-clés (top ~5), puis des MR mergées qui les ont fermés et de leurs diffs, complétée par `git log -S/--grep` et `git blame` sur les zones suspectes. L'agent juge la pertinence de chaque précédent et réutilise ce qui s'applique. Pas d'index vectoriel en v1.
- **Modèles** : Opus pour l'analyse, les tests, l'implémentation, la review et la vérification des critères. Sonnet pour la rédaction de la MR, la rétro et le tri des précédents. Surchargeable par phase dans la config.

### 10. Amélioration continue des skills

- **Rétro** en fin de ticket, désactivable dans la config (`retro.enabled`). Elle lit uniquement les **résumés factuels de phase** produits par l'orchestrateur : itérations, tests en échec, findings, erreurs de CI, durées. Elle propose un patch sur les skills, surtout sur `projects/<projet>.md`, que l'utilisateur relit et applique lui-même.
- **Transcripts complets** de chaque session, dans `~/.sprintsaver/runs/<projet>-<iid>/`. Ils sont réservés au diagnostic humain, purgés après 30 jours et désactivables.
- **Règle** : aucune trace d'un ticket passé n'est jamais injectée dans une session qui traite un ticket. Les sessions ne voient que leurs skills et le ticket courant, ce qui évite que l'outil reproduise ses anciennes trajectoires.

### 11. Permissions des sessions agent

Mode `bypassPermissions`, avec le répertoire de travail fixé sur le worktree. Un hook `PreToolUse` refuse `git push`, toute commande git qui touche au remote et toute écriture hors du worktree. C'est le seul garde-fou en v1.

### 12. Configuration et CLI

- `~/.sprintsaver/config.yaml` (hors dépôt, contient le token) : token, username de l'utilisateur, projets suivis, et pour chaque projet la branche par défaut, les commandes de setup, de build et de test, les fichiers à copier, les dossiers à cloner, le mode de test (`local` ou `ci-only`), le mapping des statuts et le mapping type ↔ labels. S'y ajoutent les plafonds, les modèles par phase et les options de rétro et de transcripts.
- Commandes :
  - `sprintsaver init` : scan de GitLab et choix des projets. ~~Les commandes sont **proposées par une session Claude en lecture seule** (outils Read, Glob, Grep), puis validées une à une par l'utilisateur. Une détection simple prend le relais si l'analyse échoue. Viennent ensuite le mapping des statuts et la création des labels manquants, sur proposition.~~ Remplacé par l'amendement 5 : un agent de configuration propose la config complète de chaque projet, commandes vérifiées par une exécution réelle, et l'utilisateur la valide avant toute écriture. La config produite reste modifiable à la main ;
  - `sprintsaver watch` : boucle continue ;
  - `sprintsaver run <projet>#<iid>` : traite un ticket précis tout de suite, même sans label ;
  - `sprintsaver status` : ticket en cours, phase, file d'attente.
- Mode de test par projet : `local` par défaut. `ci-only` pour les projets qui ne peuvent pas tester en local : la boucle test/fix passe alors par des pushes et la CI.

## Conséquences

- **Positives**
  - Comportement reproductible et testable.
  - Quand une phase échoue, on sait quel skill corriger.
  - L'utilisateur reçoit des MR déjà vérifiées, avec la preuve critère ↔ test.
  - Aucun coût API à gérer.
- **Négatives**
  - L'outil ne tourne que quand le poste est allumé et `watch` lancé.
  - Un ticket à la fois limite le débit.
  - Le PAT personnel fait de l'utilisateur l'auteur des MR : l'approbation peut être bloquée si le projet interdit l'approbation par l'auteur.
  - `bypassPermissions` sans sandbox fait confiance au contenu des tickets.
- **À surveiller** : la convergence des boucles (les plafonds sont des estimations de départ) et la qualité de la recherche de précédents par mots-clés.

## Amendement 1 — Project Access Token en alternative (2026-11-23)

- **Statut** : accepté

### Contexte

Certaines organisations interdisent les Personal Access Tokens ou veulent limiter le périmètre du jeton à un projet. Or un Project Access Token crée un utilisateur bot : `GET /user` renvoie 404 avec ce jeton, donc `init` ne peut pas y lire l'identité de l'utilisateur.

### Décision

Deux types de jeton sont supportés, tous deux avec le scope `api` :

- **Personal Access Token** (défaut, inchangé) : un jeton valable pour tous les projets suivis, auxquels l'utilisateur a accès. L'identité est celle du propriétaire du jeton.
- **Project Access Token** : un jeton par projet, avec le rôle Developer au minimum. Les branches, les pushs et la MR sont faits par le bot du projet.

Conséquences sur le comportement :

- **Assignee** : la MR est assignée à l'**utilisateur humain**, jamais au bot. Avec un Project Access Token, `init` demande son username et en résout l'id par `GET /users?username=`. `gitlab.username` et `gitlab.userId` désignent donc toujours l'humain.
- **Détection du type** : `init` essaie `GET /user`. Un 404 ou un 403 sur cette route indique un jeton de projet. L'outil le dit explicitement et passe au parcours « jeton de projet » au lieu d'échouer. Un 401 reste une erreur de jeton invalide.
- **Config** : ~~le jeton global reste dans `gitlab.token`. Chaque projet peut porter un `token` qui prend le dessus sur le global.~~ Remplacé par l'amendement 2 : aucun jeton dans la config, la connexion est celle de glab.
- **Auteur** : avec un jeton de projet, l'auteur de la MR est le bot. L'identité git des commits reste celle de l'utilisateur, comme avant. Le rôle de l'orchestrateur ne change pas : lui seul écrit sur GitLab et pousse.
- **`doctor`** : il vérifie le jeton de chaque projet. Pour un jeton de projet, il ne compare pas l'utilisateur à la config : il vérifie que le projet est accessible et que le scope `api` est bien là.

### Pourquoi

Le PAT reste le défaut parce qu'il donne la meilleure expérience : MR à ton nom, un seul jeton, un seul `init`. Le jeton de projet répond à une contrainte d'organisation, au prix d'un jeton par projet et d'un auteur de MR qui n'est plus l'utilisateur.

### Conséquences

- **Positives** : un périmètre de jeton limité au projet, et aucun PAT à créer là où la politique de l'organisation l'interdit.
- **Négatives** :
  - un jeton à créer, à renouveler et à ranger par projet ;
  - le bot étant l'auteur de la MR, l'utilisateur peut approuver sa propre MR, ce qui contourne la règle « pas d'approbation par l'auteur » pour ses propres tickets ;
  - les commits portent l'identité git de l'utilisateur alors que la MR est ouverte par le bot.

## Amendement 2 — Connexion déléguée à glab (2026-11-23)

- **Statut** : accepté. Remplace la partie « Config » de l'amendement 1.

### Contexte

L'utilisateur ne veut aucun jeton d'accès en clair dans la config de SprintSaver. Il utilise déjà la CLI GitLab `glab`, qui sait créer, ranger et renouveler une connexion.

### Décision

- **glab seul** : la connexion GitLab est celle de `glab auth login` pour l'hôte de `gitlab.url`. SprintSaver ne stocke **aucun** jeton : ni dans `config.yaml`, ni dans un trousseau à lui. Où et comment glab range le jeton relève de glab (trousseau du système par défaut).
- **Lecture** : SprintSaver relit le jeton par `glab auth status --hostname <hôte> --show-token`, le garde en mémoire pour la durée du processus, et le relit une fois sur un 401. Cette relecture couvre un jeton OAuth (`glab auth login --web`) arrivé à expiration.
- **Usage** : l'API REST et GraphQL reçoit le jeton en `Authorization: Bearer`, ce qui marche pour un PAT, un Project Access Token et un jeton OAuth. Les opérations git (clone, fetch, push) reçoivent un en-tête `Authorization: Basic oauth2:<jeton>`, passé par variables d'environnement, comme avant.
- **`init`** : il vérifie que glab est installé et connecté, et propose de lancer `glab auth login` sinon. Il ne demande plus de jeton. La détection du jeton de projet (amendement 1 : 404, 403 ou compte `bot` sur `GET /user`) et la question du username restent.
- **Config** : `gitlab` ne contient plus que `url`, `username` et `userId`. Un ancien champ `token`, global ou par projet, est ignoré au chargement et disparaît à la sauvegarde suivante.
- **`doctor`** : il vérifie que glab est installé et connecté, avec quel compte (sans comparaison pour un bot), puis que chaque projet est accessible avec le scope `api`. Pour une connexion OAuth, le scope n'est pas lisible : c'est un avertissement, pas une erreur.

### Conséquences

- **Positives** :
  - aucun secret géré par SprintSaver ;
  - un seul `glab auth login`, réutilisé par l'outil de l'utilisateur ;
  - les connexions OAuth fonctionnent aussi.
- **Négatives** :
  - glab devient une dépendance, à installer et connecter sur chaque machine ;
  - glab ne garde qu'une connexion par hôte : avec un Project Access Token, on ne suit qu'**un projet par hôte** ;
  - le format de `glab auth status --show-token` n'est pas documenté par glab. Sa lecture est tolérante (stdout et stderr, « Token: » ou « Token found: »), et une sortie illisible donne une erreur explicite.

## Amendement 3 — Avant / après dans la description de MR (2026-11-23)

- **Statut** : accepté. Complète le format de description de MR du § 7.

### Contexte

Le relecteur voit le code et la preuve critère ↔ test, mais pas l'effet du changement. Pour un changement d'interface, il doit lancer l'application pour voir l'écran. Pour un changement de données ou d'API, il doit reconstituer le contrat à partir du diff.

### Décision

- **Classement** : la session `mr-writeup` classe le changement d'après le diff, dans sa sortie structurée : `ui`, `data`, `endpoint`, plusieurs ou aucune. Pour `ui`, elle désigne 1 à 4 écrans à capturer (libellé, route ou parcours). Pour `data` et `endpoint`, elle donne, pour chaque contrat touché, un même exemple avant et après, tiré du code et des tests.
- **Données et API** : l'orchestrateur rend chaque contrat dans une section « Changements de données et d'API », sous forme de bloc ```diff calculé par lui (diff ligne à ligne déterministe entre l'avant et l'après). Seules les lignes changées apparaissent en `-` / `+`.
- **Interface** : une nouvelle phase `ui-captures` (Sonnet par défaut, une session) capture chaque écran avant et après :
  - l'orchestrateur crée un worktree détaché sur le merge-base du ticket, `~/.sprintsaver/worktrees/<projet>-<iid>.avant`, et le prépare comme le worktree du ticket (§ 6) ;
  - la session lance l'application dans les deux worktrees et écrit des PNG dans `.sprintsaver/captures/` du worktree du ticket. Le garde-fou (§ 11) l'autorise à écrire aussi dans le worktree « avant » ;
  - l'orchestrateur ne retient que les images de ce dossier, les téléverse dans les uploads du projet (`POST /projects/:id/uploads`, écriture faite par lui seul, § 4) et les place dans un tableau « Avant | Après » par écran ;
  - le worktree « avant » est supprimé après la session, et toute modification laissée dans le worktree du ticket est annulée (le code a déjà été relu et validé par la CI).
- **Moment** : après la rédaction, juste avant de passer la MR en Ready, une fois le rebase et la CI terminés. Les captures montrent donc le code livré.
- **Jamais bloquant** : un échec (application impossible à lancer, authentification, session en erreur, téléversement refusé) ne bloque pas la livraison. La MR le dit en une ligne (« Captures non réalisées : … »), sans détail local (chemins, sorties de commande), qui reste au journal. Seul un arrêt demandé interrompt la phase, et le ticket reprend plus tard.
- **Config** : `screenshots.enabled` (défaut `true`) coupe la phase pour tous les projets. La façon de lancer une application et ses données de démo vont dans le skill du projet (section « Captures d'écran »).

Format de la description, en plus du § 7 :

````
## Résumé
## Captures avant / après
### <écran>
| Avant | Après |
|---|---|
| ![…](/uploads/…) | ![…](/uploads/…) |
## Changements de données et d'API
### `<contrat>` (API|données, ajouté|modifié|supprimé)
```diff
 {
-  "total": 12.3
+  "total": 12.30
 }
```
## Critères
…
````

### Conséquences

- **Positives** : le relecteur voit l'effet du ticket sans lancer l'application ni lire tout le diff ; le diff des contrats est calculé par l'orchestrateur, donc exact par rapport aux exemples.
- **Négatives** :
  - une session et une préparation de worktree de plus pour chaque ticket d'interface, et un temps de démarrage de l'application à payer deux fois ;
  - les exemples avant/après des contrats sont rédigés par le modèle à partir du code : ils illustrent le changement, ils ne sont pas extraits d'une exécution réelle ;
  - la capture dépend de la possibilité de lancer l'application en local et d'un navigateur headless sur le poste (Playwright du dépôt ou Chrome).

## Amendement 4 — Claude in Chrome pour la review et les captures (2026-11-24)

- **Statut** : accepté. Complète l'amendement 3 et le § 11.

### Contexte

La review ne voit le résultat qu'à travers le code et les tests : un rendu cassé, une erreur JavaScript ou un parcours sans issue lui échappent. Les captures de l'amendement 3 passent par un navigateur headless lancé en ligne de commande, qui se prête mal à un parcours (clic, saisie, connexion de démo) et à un cadrage sur la zone qui change. Le poste a Chrome et l'extension Claude in Chrome, que Claude Code sait piloter (`--chrome`).

### Décision

- **Phases** : `config.chrome.phases`, par défaut `review` et `ui-captures`. Leurs sessions sont lancées avec `--chrome` et reçoivent le skill d'outil `skills/tools/chrome/SKILL.md`. Toutes les autres sont lancées avec `--no-chrome`, pour qu'un réglage personnel de Claude Code ne l'active pas en douce. `chrome.enabled` (défaut `true`) coupe tout.
- **Review** : quand le diff change un écran, la session lance l'application et la parcourt selon les critères du ticket. Un défaut vu à l'écran n'est bloquant qu'avec ses étapes de reproduction ; un goût visuel reste un nit. La règle du § 5 ne change pas : une case n'est cochée que si un test la prouve.
- **Captures** : Claude in Chrome passe en tête des outils de capture. L'image est enregistrée par `save_to_disk` (JPEG pour une capture, PNG pour un zoom sur une région), puis copiée dans `.sprintsaver/captures/`. L'orchestrateur accepte déjà ces deux formats.
- **Garde-fou** (§ 11) : le navigateur est celui de l'utilisateur, avec ses sessions ouvertes. Le hook refuse toute navigation hors de l'hôte local (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`), y compris dans un `browser_batch`, ainsi que `file_upload`, `upload_image` et `gif_creator`.
- **Repli** : sans extension connectée ou si Chrome ne répond pas, la session ne s'y attarde pas et revient aux outils de l'amendement 3. `doctor` signale une extension absente par un avertissement.

### Conséquences

- **Positives** : la review voit l'effet du code ; les captures suivent un vrai parcours et se cadrent sur ce qui change.
- **Négatives** :
  - les sessions ouvrent des onglets dans le Chrome de l'utilisateur pendant `watch` (un groupe d'onglets à part, fermé en fin de session) ;
  - la review d'un ticket d'interface coûte un lancement d'application de plus ;
  - la restriction de navigation porte sur les appels d'outils : un lien cliqué ou du JavaScript exécuté dans la page peut encore changer d'origine. Comme le reste du garde-fou, elle vise les dérives du modèle, pas un adversaire.

## Amendement 5 — Agent de configuration et commandes vérifiées (2026-11-24)

- **Statut** : accepté. Remplace la session Claude en lecture seule de `init` (§ 12).

### Contexte

La session en lecture seule de `init` proposait setup, build et test d'après la doc du dépôt (README, Makefile), sans que personne ne les exécute avant le premier ticket. Une classe d'échecs passait inaperçue : la commande dépend du runtime par défaut de la machine (celui du PATH), alors que le projet exige une autre version, déclarée dans la CI, un Dockerfile, un fichier de version, une contrainte du manifeste ou seulement en prose. Le setup échouait au premier ticket, qui finissait bloqué sur GitLab. La config doit marcher sur la machine de l'utilisateur et le rester quand cet environnement évolue (mise à jour du runtime système).

### Décision

- **Agent de configuration** : pendant `init`, une session Agent SDK par projet produit une proposition complète (nom court, checkout local, stack, setup, build, test, mode de test, pipeline surveillé, fichiers à copier, dossiers de dépendances, mapping des statuts, labels de type), avec une explication, les versions de toolchain relevées et les prérequis manquants. Le reste reste déterministe : instance, connexion glab, identité, choix des projets, auteur des commits.
- **Données par outils MCP in-process**, limités au projet : infos du projet et config actuelle, labels, statuts natifs, config CI (fusionnée par `GET /projects/:id/ci/lint` quand le rôle le permet, sinon le fichier brut), recherche bornée d'un checkout local (dossiers usuels du dossier personnel, profondeur 4, 20 000 dossiers et 8 s au plus, remotes lus dans la config git), noms des fichiers ignorés de ce checkout. Aucun outil n'écrit sur GitLab.
- **Sous-agent `detect-commands`**, déclaré par l'option `agents` du SDK et appelé par l'agent principal, au premier plan (`background: false`) : l'agent principal attend son rapport avant de rendre sa sortie.
  - il relève les versions exigées dans toutes les sources (CI, Dockerfile, fichiers de version, manifestes, prose) ;
  - il les compare à la machine par des sondes de version en lecture seule : une liste fermée d'outils et de commandes fixes (`--version`, versions connues des gestionnaires de versions), lancées par l'orchestrateur, sans Bash ;
  - il propose des commandes qui **fixent explicitement la version** au lieu de dépendre du défaut du PATH, de préférence par un gestionnaire de versions déjà installé, sinon par une installation versionnée explicite. Si c'est impossible, il le déclare comme **prérequis**.
- **Rôle des commandes** : la commande de test est la seule que le moteur exécute pour valider une modification (§ 7). Elle porte donc toutes les vérifications bloquantes de la CI qui tournent en local (typecheck, lint, tests…). La commande de build n'est qu'une indication donnée aux agents.
- **Vérification réelle**, par l'orchestrateur : l'outil `verify_commands` crée un worktree jetable de la branche par défaut, le prépare comme pour un ticket (§ 6), lance setup → test → build → test relancé avec le timeout des commandes (le test juste après le setup, comme dans un ticket où le moteur ne lance jamais le build ; des tests rouges n'empêchent pas de vérifier le build ; la relance dans le même worktree vérifie que la boucle test/fix pourra relancer la commande, même après un build), et rend un extrait utile de la sortie (erreurs et résumé, sans le bruit). Trois tentatives au plus par projet. Le diagnostic distingue une commande cassée (exécutable introuvable, mauvaise version, module manquant) de tests rouges sur la branche par défaut (ligne de base), qui ne bloquent pas la config. Avant exécution, une commande est refusée si elle installe quelque chose globalement (sudo, gestionnaires de paquets du système, `npm -g`, pip du système, installation de versions par un gestionnaire…), écrit hors du worktree ou touche au remote (règles du garde-fou, § 11).
- **Commandes idiomatiques** : le sous-agent préfère la commande du gestionnaire de versions (`nvm exec 22`, `uv run --python 3.11`, `mise exec node@22 --`…) à un bricolage de chemins (liste d'un dossier de versions, chemin complet d'une version précise).
- **Fichiers ignorés à copier** : `worktreeInclude` désigne les fichiers ignorés par git nécessaires pour lancer les tests **et l'application** en local (config d'environnement locale, secrets de dev, certificats…). Les phases `review` et `ui-captures` lancent l'application (amendement 4) : un `.env` dont la CI se passe peut leur être indispensable. Ces fichiers n'existent pas dans le worktree que lisent les agents : l'outil `list_local_ignored_files` donne les **noms** des fichiers ignorés présents dans le checkout local (jamais leur contenu), sans les dossiers de dépendances, de build et de cache, avec une limite de 150 entrées. Il signale le pendant ignoré de chaque fichier d'exemple versionné (`*.example`, `*.sample`, `*.template`, `*.dist` : `.env` pour `.env.example`), proposé en priorité.
- **Environnement des commandes** : une seule fonction (`projectCommandEnv`) construit l'environnement de toutes les commandes du projet : setup, build et test des tickets, vérification de `init`, sondes de version et sessions agent. Elle retire les traces du gestionnaire de paquets qui a lancé SprintSaver : variables `npm_*` (dont `npm_config_prefix`, qui empêche nvm.sh de se charger), `INIT_CWD`, `NODE` et `COLOR` d'un script npm, variables de yarn, et entrées ajoutées au PATH (`node_modules/.bin` de SprintSaver et de ses parents, `node-gyp-bin`). Lancé par `npm run dev` ou par le binaire global, SprintSaver produit donc la même config, et `init` vérifie dans l'environnement où tourneront les tickets.
- **Permissions** : les agents n'ont que Read, Glob et Grep, limités par un hook au worktree de la branche par défaut (et aux dossiers temporaires), plus l'outil Agent pour l'agent principal ; ni Bash ni écriture. Ils ne lisent donc pas les fichiers ignorés du checkout local, qui peuvent contenir de vrais secrets. Ils n'exécutent rien eux-mêmes et n'écrivent jamais sur GitLab.
- **Validation humaine** : le code affiche la proposition complète, avec le résultat de la dernière vérification réelle (celui de l'orchestrateur fait foi, pas le récit de l'agent) et les prérequis. L'utilisateur valide, modifie un champ, relance la vérification, ignore le projet ou annule tout. Les labels manquants et la config ne sont écrits qu'après validation, par le code déterministe.
- **Repli** : si l'agent échoue (claude absent, session en erreur, sortie invalide après une relance), la détection simple et les questions champ par champ reprennent. `--no-agent` force ce repli.
- **Mode non interactif** : `--yes` accepte les propositions sans question (valeurs existantes ou par défaut pour les parties déterministes ; les projets suivis non cités restent inchangés) ; `--dry-run` n'écrit rien sur GitLab ni dans la config de SprintSaver et affiche la config, ou l'écrit dans `--output`.
- **Config** : `toolchain` (optionnel) garde, par projet, les versions exigées, leur source et la façon dont les commandes les fixent. Le moteur ne le lit pas. Les modèles se surchargent par `models.init` (agent principal, Sonnet par défaut) et `models.detect-commands` (Opus par défaut).

### Conséquences

- **Positives** :
  - les commandes de la config ont tourné au moins une fois sur la machine avant le premier ticket ;
  - une version de runtime exigée par le projet est fixée dans la commande, et une mise à jour du runtime système ne la change pas ;
  - un prérequis manquant est signalé à `init`, pas découvert par un ticket bloqué ;
  - `init` se teste et s'automatise (`--yes`, `--dry-run`).
- **Négatives** :
  - `init` prend plusieurs minutes par projet (session, setup et tests réels) et consomme du quota Claude ;
  - la vérification exécute les commandes du dépôt sur le poste, comme le setup d'un ticket : même confiance faite au dépôt ;
  - les sondes et la politique d'installation reposent sur des listes (outils, gestionnaires de versions, commandes d'installation) à compléter pour les toolchains moins courantes ;
  - un gestionnaire de versions qui installe à la volée une version absente (`mise exec`, par exemple) n'est pas bloqué par la politique : le prompt demande de n'utiliser que des versions déjà installées ;
  - les noms des fichiers ignorés du checkout local (pas leur contenu) sont envoyés au modèle ;
  - le diagnostic « ligne de base rouge » est une heuristique sur la sortie des lanceurs de tests ; l'agent la confirme ou la corrige, et l'utilisateur voit l'extrait.

## Hors périmètre v1 (reporté)

- **Sécurité** : allowlist des personnes autorisées à poser `auto::ready`, sandbox Docker, défense contre l'injection de prompt via les tickets.
- **Rework** : traitement automatique des commentaires de review sur la MR. En v1, l'utilisateur corrige à la main.
- Traitement de plusieurs tickets en parallèle.
- Index vectoriel pour la recherche de précédents.
- Webhook, service système ou déploiement serveur.
- Tests automatisés de l'outil lui-même.

## Notes d'implémentation (2026-11-23)

Précisions apportées pendant le développement de la v1. Elles ne changent aucune décision ci-dessus.

- **Binaire Claude** : le SDK lance le `claude` déjà installé chez l'utilisateur (`pathToClaudeCodeExecutable`, résolu via `SPRINTSAVER_CLAUDE_PATH`, puis le PATH, puis les emplacements usuels). Le binaire embarqué par le SDK n'est pas utilisé. Le processus est détaché du groupe du terminal : le premier Ctrl+C ne tue pas la session en cours. Les groupes de processus détachés (sessions `claude`, commandes de tests) sont tués à la sortie de SprintSaver. SIGHUP et SIGTERM valent un arrêt immédiat (sessions interrompues, état conservé) suivi de la sortie.
- **Schéma de sortie** : le JSON Schema généré par zod est nettoyé de sa clé `$schema`, que Claude Code refuse.
- **GitLab** : un client REST/GraphQL `fetch` typé remplace `@gitbeaker/rest`. Les POST ne sont rejoués que si la requête n'a certainement pas été envoyée.
- **Fichiers non versionnés** : ils sont copiés depuis `localCheckout` (le checkout habituel de l'utilisateur), sinon depuis le clone de référence. La liste vient du `.worktreeinclude` versionné.
- **Push forcé** : `--force-with-lease --force-if-includes`, ce qui exige git ≥ 2.30. Un commit humain poussé sur la branche n'est jamais écrasé.
- **Concurrence** : un verrou global `~/.sprintsaver/sprintsaver.lock` empêche `watch` et `run` de traiter le même ticket en parallèle.
- **Durée maximale** : elle est calculée sur le temps actif cumulé (`activeMs`), sans compter le temps où l'outil était arrêté.
- **Garde-fou** : en plus de § 11, il refuse `git commit` et `git rebase` dans le worktree, puisque c'est l'orchestrateur qui commite et rebase.
- **Preuves** : `verify-criteria` est relancé dès qu'une correction touche un test déclaré. Les cases sont cochées par index **et** par texte.
- **Banc d'essai** : `npm run e2e:local` lance le vrai moteur, le vrai git et de vraies sessions Claude sur un mini-projet, avec un GitLab simulé (`--ci-fail` pour exercer la boucle CI).
- **Reprise** : le ticket est lu avant le retrait du label, et le label est remis si l'état ne peut pas être enregistré. Un rebase resté arrêté par un crash est annulé avant la finalisation ou le blocage. Un HEAD non relu (correctif commité puis interruption) ou des preuves périmées déclenchent tests et review du delta avant tout push de la boucle CI et avant la rédaction de la MR. La livraison est découpée en sous-étapes persistées (`deliverySteps`), sautées à la reprise.
- **Rebase** : `rebaseContinue` refuse de continuer tant qu'un fichier contient des marqueurs de conflit ; c'est une tentative de résolution ratée.
- **watch** : un ticket en échec répété (hors blocage) est mis de côté 30 min, puis repris avec un compteur d'échecs à zéro.
