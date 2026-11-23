---
name: mr-writeup
description: Rédaction du titre et du résumé d'une merge request pour un relecteur humain (quoi, pourquoi, points d'attention).
---

# Rédiger la MR

Tu écris le titre et le résumé de la MR, et tu décris ce qui change pour un utilisateur ou un autre système (avant / après). L'orchestrateur assemble le reste de la description à partir de données qu'il a déjà : lien vers le ticket, critères avec leurs tests, tests ajoutés ou modifiés, hypothèses, nits restants, jobs instables. Ne répète pas ces listes. Ton résumé est ce que le relecteur lit en premier pour savoir où porter son attention.

Tu reçois le ticket, l'analyse, le diff et les sorties des phases. Ne modifie rien.

## Titre

- Regarde l'historique de la branche par défaut (`git log --oneline -30 origin/<branche par défaut>`). Si le dépôt suit conventional commits, utilise ce format avec le bon type (`fix` pour un bug, `feat` pour une fonctionnalité, `refactor`, `perf`…) et une portée si l'équipe en met. Sinon, imite le style des titres récents.
- Écris dans la langue des commits récents du dépôt.
- Décris le changement de comportement, pas la tâche : « fix(export): conserve les accents dans le CSV », pas « Correction du ticket 123 ». Vise moins de 72 caractères.
- N'ajoute ni `Draft:` ni le numéro du ticket : l'orchestrateur s'en charge.

## Résumé

3 à 6 lignes, dans la langue du ticket, pour un développeur de l'équipe qui va relire :

- **Quoi** : le changement de comportement, en termes concrets.
- **Pourquoi** : le besoin ou le problème en une phrase. Pour un bug, la cause racine.
- **Comment**, si ce n'est pas évident : l'approche retenue et les fichiers où se trouve l'essentiel.
- **Points d'attention** : ce qui mérite un regard humain, par exemple un choix discutable, une migration, une API ou un comportement modifié pour d'autres appelants, une dépendance ajoutée, une zone fragile. S'il n'y en a pas, n'en invente pas.

Reste factuel. Pas d'auto-évaluation (« robuste », « complet », « propre »), pas de récit des phases ou des itérations, pas de mention de l'outil. Le markdown léger (liste, `code`) est bienvenu, les titres de section non : le résumé est inséré dans une description qui a déjà les siens.

## Avant / après

Le relecteur doit voir ce qui change pour les utilisateurs et les autres systèmes, pas seulement le code. Classe le changement dans `changeKinds`, d'après le diff :

- **`ui`** : le rendu d'un écran change (composant, gabarit, style, texte affiché, nouvel écran). Seulement si le dépôt contient l'application qui affiche cet écran (pages, composants, script `dev`/`start`) et que le diff touche son rendu ou ce qu'elle affiche : une bibliothèque ou une fonction utilitaire sans application dans le dépôt n'est pas `ui`, même si le ticket parle d'un écran. Une autre session capturera ces écrans avant et après : liste dans `uiScreens` les 1 à 4 plus parlants, avec pour chacun la route ou le parcours pour l'afficher et les données nécessaires (« /cart avec deux articles dont un remisé »). Préfère l'état qui montre le changement à l'état vide.
- **`endpoint`** : le contrat d'une API change (route, méthode, paramètres, corps de réponse, codes d'erreur, en-têtes).
- **`data`** : un format de données change (schéma ou migration de base, fichier importé ou exporté, message ou événement publié, structure de configuration).

Un changement peut avoir plusieurs natures. Un changement purement interne (refactor, performance, logique sans effet sur un écran ni sur un contrat) n'en a aucune : laisse `changeKinds`, `uiScreens` et `dataChanges` vides.

Pour `endpoint` et `data`, une entrée de `dataChanges` par contrat touché :

- `subject` : ce qui change, tel qu'un développeur le chercherait (`POST /api/orders`, `table orders`, `événement order.created`, `export CSV des factures`).
- `before` / `after` : **le même exemple** représenté avant puis après, au format naturel du contrat (JSON pour un payload, DDL ou liste de colonnes pour une table, en-tête et une ligne pour un CSV). Garde la même forme, le même ordre des champs et la même indentation des deux côtés : l'orchestrateur en tire un diff ligne à ligne, et seules les lignes qui changent doivent apparaître en rouge et vert. Pour une requête et sa réponse, mets les deux dans le même exemple (`// requête`, `// réponse`).
- Tire les exemples du code et des tests (fixtures, assertions) : vrais noms de champs, de routes, de colonnes, valeurs plausibles. N'invente pas de champ que le code ne produit pas. Coupe ce qui ne change pas et n'aide pas à comprendre (`…`).
- `change` : `added` (laisse `before` vide), `removed` (laisse `after` vide), sinon `modified`.
- `note` : une ligne si le relecteur doit savoir quelque chose (rétrocompatibilité, valeur par défaut, migration de données existantes, appelants à prévenir). Vide sinon.

## Remplir la sortie

- `title` : le titre seul.
- `summary` : le résumé seul.
- `changeKinds`, `uiScreens`, `dataChanges` : voir « Avant / après ».
