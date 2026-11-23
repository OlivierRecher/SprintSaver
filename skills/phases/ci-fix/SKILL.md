---
name: ci-fix
description: Diagnostic et correction des jobs GitLab CI en échec sur la branche d'un ticket, en reproduisant en local quand c'est possible.
---

# Corriger la CI

La branche du ticket a été poussée et des jobs du pipeline échouent encore après une relance automatique. L'orchestrateur a vérifié que la branche par défaut est verte. Tu reçois les logs des jobs en échec, tronqués : tu n'as que leur fin. Ta correction sera commitée, poussée, puis relue en review sur le delta.

## Cadre

- L'orchestrateur commite tout l'état du worktree (`git add -A`) après ta session. Ne commite pas, ne change pas de branche, ne stashe pas. Mets tes fichiers temporaires dans `.sprintsaver/tmp/` (ignoré par git) ou supprime-les.
- Tu ne peux ni pousser ni relancer la CI. Ta seule boucle de vérification est locale, et chaque push raté coûte une itération : traite dans la même session tous les jobs en échec qui relèvent du ticket.

## 1. Classer chaque échec

Lis chaque log jusqu'à l'erreur réelle. Elle se trouve souvent bien avant `ERROR: Job failed`, la dernière ligne n'est qu'une conséquence. Puis classe-la :

- **Lint, format, typecheck** : la catégorie la plus fréquente, parce que la boucle locale ne lance souvent que les tests. Trouve la commande exacte du job dans `.gitlab-ci.yml` et les fichiers qu'il inclut.
- **Tests** : un test vert en local et rouge en CI tient à une différence d'environnement. Pense à la variable d'environnement, au fuseau horaire, à la locale, à l'ordre ou au parallélisme d'exécution, à une vraie base au lieu d'une base en mémoire, et aux fichiers ignorés par git présents dans le worktree mais absents en CI.
- **Build, packaging** : dépendance ajoutée sans lockfile à jour, code qui dépend d'un fichier ignoré par git, import dont la casse diffère du nom de fichier (macOS l'accepte, le runner Linux non).
- **Environnement CI** : runner indisponible, timeout réseau, registre ou service externe en panne, quota, secret ou variable CI manquante, cache corrompu. Rien à corriger dans le code.

## 2. Reproduire, puis corriger

Reproduis en local avec la commande du job (même outil, mêmes options), corrige dans le worktree, puis relance la même commande pour voir le vert. Si la reproduction est impossible (service propre à la CI), explique dans `summary` ce qui te fait penser que ta correction règle le problème.

Corrige la cause, pas le contrôle. N'ajoute pas d'exception de lint, de `allow_failure` ni de skip de test, et ne modifie `.gitlab-ci.yml` que si le ticket le demande ou que le diff du ticket l'a déjà modifié.

## 3. Échec sans rapport avec le ticket

Si l'échec relève de l'environnement CI, ou touche du code et des tests que la branche n'a pas modifiés et ne peut pas influencer, mets `unrelatedToTicket: true`, décris la cause et ne change rien. Une modification cosmétique pour « relancer » la CI ne règle rien et pollue le diff.

## Remplir la sortie

- `rootCause` : pour chaque job, sa catégorie et la cause identifiée.
- `summary` : correctifs appliqués, et la commande locale qui les vérifie avec son résultat.
- `testsAdjusted` : tests ajoutés ou modifiés, avec la raison ; liste vide sinon.
- `unrelatedToTicket` : voir l'étape 3.
