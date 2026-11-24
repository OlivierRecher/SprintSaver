---
name: ui-captures
description: Captures d'écran avant/après d'un changement d'interface, pour la description de la merge request.
---

# Captures avant / après

Le relecteur doit voir en un coup d'œil ce que le ticket change à l'écran. Tu lances l'application deux fois, sur la version AVANT (worktree de base, chemin donné dans le prompt) puis sur la version APRÈS (répertoire courant), et tu captures les mêmes écrans dans les mêmes conditions. L'orchestrateur téléverse les images et les place côte à côte dans la MR.

Tu ne modifies aucun fichier source, dans aucun des deux worktrees. Ce que tu modifies dans le répertoire courant est annulé à la fin de la session.

## Lancer l'application

1. Cherche d'abord la méthode dans le skill du projet (section « Captures d'écran ») et dans le `CLAUDE.md` du dépôt. À défaut : scripts `dev`/`start`/`preview` du `package.json`, `Makefile`, `docker-compose`, README.
2. Lance chaque version sur un port libre et distinct (par exemple 4801 pour l'avant, 4802 pour l'après), en arrière-plan, sortie redirigée vers un fichier de `/tmp`. Attends que l'URL réponde (`curl -sf` en boucle, une minute au plus) avant de capturer.
3. Pas de service externe à créer (base de données distante, compte tiers). Si l'application a besoin de données, utilise les seeds, fixtures ou mocks du dépôt, identiques pour l'avant et l'après.
4. Arrête les deux serveurs avant de terminer (`kill` du PID, vérifie que le port est libéré).

## Capturer

Utilise le premier outil disponible :

1. Claude in Chrome si la session a les outils `mcp__claude-in-chrome__*` (voir le skill d'outil du navigateur). C'est le plus fiable pour un parcours (clic, saisie, connexion de démo) et pour cadrer sur la zone qui change (`zoom` sur une région). Un seul onglet pour les deux versions : capture l'avant sur son port, puis l'après sur le sien, à la même taille de fenêtre. Copie chaque image enregistrée dans le dossier de captures en gardant son extension ;
2. Playwright s'il est dans les dépendances du dépôt (`npx playwright screenshot --viewport-size=1280,800 --wait-for-timeout=1500 <url> <fichier>`, ou un petit script dans `/tmp` pour un parcours : clic, saisie, connexion de démo). Si ses navigateurs ne sont pas installés, ajoute `--channel=chrome` pour utiliser le Chrome du poste ;
3. Chrome ou Chromium en mode headless : `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 --screenshot=<fichier> <url>` ;
4. Chromium, Edge ou Brave avec les mêmes options headless que Chrome.

Si Claude in Chrome ne répond pas, passe directement au suivant. N'installe pas de navigateur (le téléchargement écrirait hors du worktree). Sans aucun de ces outils, abandonne avec `skippedReason` : « aucun navigateur disponible ».

Règles :

- Même viewport (1280×800 par défaut, mobile si le ticket concerne le mobile), même parcours, mêmes données pour l'avant et l'après.
- Cadre l'écran sur la zone qui change. Une page entière n'est utile que si le changement porte sur la mise en page.
- Attends la fin des chargements et des animations : pas de spinner ni de squelette sur la capture.
- Écran nouveau (il n'existe pas avant) : capture seulement l'après et laisse `before` vide.
- Vérifie chaque fichier : une image PNG ou JPEG non vide, qui montre bien l'écran demandé (lis l'image). Une page d'erreur ou de connexion n'est pas une capture valable.

## Abandonner proprement

Les captures ne doivent pas coûter plus que le ticket. Si l'application ne démarre pas après quelques tentatives raisonnables (dépendance manquante, service externe, secret absent), ou si un écran exige une authentification que le dépôt ne permet pas de simuler, arrête-toi : renseigne `skippedReason` avec la cause en une ligne, factuelle, utile pour configurer le projet la prochaine fois. Rends les captures déjà réussies.

## Remplir la sortie

- `captures` : une entrée par écran réussi, dans l'ordre de la liste. `before` et `after` sont des chemins relatifs au répertoire courant, dans le dossier de captures indiqué.
- `note` : ce que le relecteur doit remarquer, en une phrase courte (« le total apparaît sous la liste »). Vide si l'image parle d'elle-même. Pas la description des données de démo.
- `skippedReason` : vide si tous les écrans demandés sont capturés.
- `launchRecipe` : voir ci-dessous.

## Recette de lancement

Ce que tu as appris pour lancer l'application servira aux prochaines reviews et captures du projet : l'orchestrateur le propose en patch sur la section « Captures d'écran » du skill projet. Si cette section décrit déjà ce que tu as fait, laisse `launchRecipe` vide. Sinon, écris le contenu complet de la section, mis à jour (Markdown, 20 lignes au plus) :

- commandes de build et de lancement, ports, variables d'environnement nécessaires (noms, jamais de vraie valeur secrète) ;
- données et compte de démo, ou comment contourner la connexion ;
- services à simuler et comment (par exemple « Supabase simulé : un serveur Node qui répond à `/auth/v1/token` et `/rest/v1/events` ») ; un fichier écrit dans `/tmp` disparaît, décris donc ce qu'il fait plutôt que son chemin ;
- écrans impossibles à capturer, et pourquoi.

Des faits durables, sans le récit de cette session ni les détails propres à ce ticket.
