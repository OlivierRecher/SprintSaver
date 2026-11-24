---
name: chrome
description: Piloter le Chrome du poste (Claude in Chrome) pour voir l'application lancée en local, vérifier un parcours et enregistrer des captures d'écran.
---

# Navigateur : Claude in Chrome

Cette session dispose des outils `mcp__claude-in-chrome__*`. Ils pilotent le vrai Chrome de l'utilisateur, qui contient ses sessions ouvertes (GitLab, messagerie…). Tu t'en sers uniquement pour regarder l'application de ce dépôt, lancée par toi en local.

## Charger les outils

Les outils sont différés : charge ceux dont tu as besoin en un appel `ToolSearch`, par exemple `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__find,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__resize_window,mcp__claude-in-chrome__read_console_messages`.

## Règles

- **Hôte local uniquement** : navigue vers `http://localhost:<port>` ou `http://127.0.0.1:<port>`. Le garde-fou refuse toute autre URL. Ne suis pas un lien qui sort de l'application.
- **Tes onglets seulement** : ouvre ton propre onglet (`tabs_create_mcp`), travaille dedans, et ferme tous les onglets que tu as ouverts avant de terminer (`tabs_close_mcp`). Ne touche pas aux autres onglets de l'utilisateur.
- **Aucun compte personnel** : n'utilise que les comptes, seeds ou contournements de connexion prévus par le dépôt ou le skill du projet. Ne saisis jamais un mot de passe ou un jeton qui ne vient pas du dépôt.
- **Personne ne regarde** : n'attends aucune action humaine. Une boîte de dialogue native (`alert`, `confirm`) bloque la page : évite de la déclencher, sinon ferme-la avec la touche Échap.
- Envoi de fichiers (`file_upload`, `upload_image`) et enregistrement GIF (`gif_creator`) sont désactivés.

## Si le navigateur ne répond pas

Extension non connectée, Chrome fermé, outil en erreur : réessaie une fois, puis passe à la méthode de repli décrite par le skill de phase (Playwright ou Chrome headless) sans insister. N'essaie pas d'installer ni de configurer l'extension. Note le repli dans ta sortie si elle a un champ prévu pour ça.

## Voir et vérifier

- Fixe la taille de fenêtre avant de comparer ou de capturer (`resize_window`, 1280×800 par défaut) : l'avant et l'après doivent avoir la même.
- `find` et `read_page` donnent les éléments et leurs références : clique ou remplis par référence plutôt que par coordonnées.
- Après chaque action, attends que la page soit stable (`computer` action `wait`, 1 à 2 s) et vérifie l'état par une capture ou par `find`.
- `read_console_messages` et `read_network_requests` montrent les erreurs JavaScript et les requêtes en échec : regarde-les sur chaque écran que tu vérifies.

## Enregistrer une capture dans un fichier

1. `computer` avec `action: "screenshot"` et `save_to_disk: true` : la réponse donne le chemin de l'image enregistrée, dans un dossier temporaire du système.
2. Pour cadrer sur une zone : `computer` avec `action: "zoom"`, `region: [x0, y0, x1, y1]` (coordonnées du viewport) et `save_to_disk: true`.
3. Copie le fichier vers sa destination avec `cp`, en gardant son extension (`.jpg` ou `.png` selon l'action), puis ouvre-le avec `Read` pour vérifier ce qu'il montre.
