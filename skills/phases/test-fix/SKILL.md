---
name: test-fix
description: Diagnostic par la cause racine et correction d'une suite de tests en échec sur la branche d'un ticket.
---

# Corriger des tests en échec

L'orchestrateur a lancé la commande de test du projet et elle échoue. Tu reçois sa sortie, tronquée depuis le début si elle est longue : l'essentiel est vers la fin. Le nombre d'itérations est limité, et une correction tentée au hasard en consomme une sans rien apprendre.

## Cadre

- L'orchestrateur commite tout l'état du worktree (`git add -A`) après ta session. Ne commite pas, ne change pas de branche, ne stashe pas. Mets tes fichiers temporaires dans `.sprintsaver/tmp/` (ignoré par git) ou supprime-les.

## 1. Diagnostiquer avant de toucher

- Repère le premier échec réel. Un setup cassé, une erreur de compilation ou une base non migrée produisent des dizaines d'échecs en cascade : corrige la cause, pas chaque symptôme.
- Relance les tests en échec isolément pour avoir leur sortie complète et confirmer que l'échec se reproduit.
- Regarde ce que la branche a changé : `git diff $(git merge-base HEAD origin/<branche par défaut>)`.
- Avant d'éditer, formule la cause en une phrase, par exemple « `computeTotal` renvoie null quand le panier est vide, le test attend 0 ». Si tu n'y arrives pas, continue à lire le code, la stack trace et les données de test plutôt que de tenter une modification.

## 2. Lié au ticket ou non

Un échec est lié au ticket quand le test exerce du code que la branche a modifié, ou que la branche a modifié le test. Sinon, envisage :

- un **test instable** : relance-le plusieurs fois. Un échec intermittent sur du code non touché (timing, ordre d'exécution, horloge, aléatoire, réseau) en est le signe ;
- l'**environnement** : service absent, port occupé, variable manquante, dépendance non installée, version d'outil ;
- une **base déjà cassée** sur la branche par défaut.

Dans ces cas, ne modifie pas le code pour masquer le problème. Corrige seulement ce qui est local et sûr (installer une dépendance manquante, par exemple), décris la cause dans `rootCause` et mets `unrelatedToTicket: true`. N'utilise pas ce drapeau pour te débarrasser d'un échec que tu n'as pas compris : un humain vérifiera l'affirmation.

## 3. Corriger

- Corrige de préférence le code de production. Les tests ont été écrits pour les critères du ticket, ils sont la référence.
- Corrige un test seulement s'il est faux : attente contraire au critère, setup incorrect, dépendance à l'ordre ou à l'horloge. Déclare-le dans `testsAdjusted` avec la raison.
- Ne désactive, ne skippe et ne supprime jamais un test pour faire passer la suite. N'élargis pas non plus une assertion jusqu'à ce qu'elle ne prouve plus rien (tolérance démesurée, `toBeDefined` à la place d'une valeur). Un test rouge honnête arrête la boucle et fait intervenir un humain ; un vert trompeur livre un bug avec une case cochée.
- Après correction, relance les tests qui échouaient, puis la suite complète ou au moins les zones touchées, pour vérifier que tu n'as rien cassé ailleurs.

## Remplir la sortie

- `rootCause` : la cause identifiée, précise et vérifiable. S'il y a plusieurs échecs distincts, une cause par échec.
- `summary` : ce que tu as changé et le résultat de ta dernière exécution.
- `testsAdjusted` : tests modifiés ou ajoutés, avec la justification ; liste vide sinon.
- `unrelatedToTicket` : voir l'étape 2.
