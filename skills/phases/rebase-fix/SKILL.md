---
name: rebase-fix
description: Résolution des conflits d'un rebase en cours de la branche d'un ticket sur la branche par défaut, en conservant l'intention des deux côtés.
---

# Résoudre les conflits de rebase

L'orchestrateur a lancé un rebase de la branche du ticket sur `origin/<branche par défaut>` et git s'est arrêté sur des conflits. Tu les résous. L'orchestrateur fera ensuite `git add -A` et `git rebase --continue`, et te rappellera si un commit suivant entre en conflit à son tour. Ne lance toi-même ni `git rebase --continue`, `--skip` ou `--abort`, ni `git commit` : l'orchestrateur suit l'état du rebase et se désynchroniserait.

## Se repérer

- `git status` liste les fichiers en conflit.
- `git show REBASE_HEAD` montre le commit du ticket en cours de réapplication. Son message indique son rôle (`test:`, `feat:`, `fix(review):`…).
- Pendant un rebase, les côtés sont inversés par rapport à un merge : **ours / HEAD** est la branche par défaut plus les commits du ticket déjà réappliqués, **theirs** est le commit du ticket. Ne te fie pas aux étiquettes, lis le contenu.
- Pour voir ce que la branche par défaut a changé dans un fichier : `git log -p $(git merge-base ORIG_HEAD origin/<branche par défaut>)..origin/<branche par défaut> -- <fichier>`.

## Résoudre chaque fichier

- Comprends l'intention de chaque côté avant d'éditer. La branche par défaut a peut-être renommé une fonction, déplacé du code, changé une signature ou corrigé un bug dans la même zone. Le résultat doit être le changement du ticket appliqué sur le code à jour, pas l'un des deux côtés.
- `git checkout --ours` ou `--theirs` sur un fichier entier ne convient que si un côté doit gagner en totalité, ce qui est rare.
- Regarde au-delà des marqueurs. Le code du ticket peut appeler une fonction que la branche par défaut a renommée ou supprimée dans un autre fichier, sans conflit textuel. Cherche ces usages.
- Ne fusionne pas à la main les lockfiles et fichiers générés (`package-lock.json`, `yarn.lock`, `poetry.lock`, snapshots). Pars de la version de la branche par défaut et regénère avec l'outil du projet pour y réintégrer les changements du ticket. Pour des migrations numérotées, renumérote celle du ticket après celles de la branche par défaut.
- Retire tous les marqueurs : `git diff --check` ne doit rien signaler, et aucune ligne `<<<<<<<`, `=======` ou `>>>>>>>` ne doit rester dans les fichiers touchés.

## Vérifier

Lance le build ou le typecheck, puis les tests des zones concernées. Tiens compte de l'état intermédiaire : si le commit réappliqué est le commit de tests et que l'implémentation n'est pas encore réappliquée, les nouveaux tests du ticket échouent, et c'est normal. Ce qui doit marcher, c'est la compilation et les tests qui passaient sur la branche par défaut.

## Remplir la sortie

- `rootCause` : ce qui est entré en conflit et pourquoi, par exemple « la branche par défaut a renommé `getUser` en `findUser` dans le service que le ticket modifie ».
- `summary` : fichier par fichier, comment tu as résolu, puis le résultat de la vérification.
- `testsAdjusted` : tests du ticket que la résolution a dû adapter (nouvelle signature, nouveau nom), avec la raison.
- `unrelatedToTicket` : false en règle générale, puisqu'un conflit implique le code du ticket.
