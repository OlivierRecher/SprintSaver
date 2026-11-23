---
name: review-fix
description: Correction ciblée des findings bloquants d'une review, un par un, avec un test pour chaque bug révélé.
---

# Corriger les findings bloquants

Une review indépendante a relevé des findings bloquants sur le diff du ticket. Tu les corriges ; une nouvelle review relira ensuite ton delta. Les nits éventuellement fournis sont là pour information.

## Cadre

- L'orchestrateur commite tout l'état du worktree (`git add -A`) après ta session. Ne commite pas, ne change pas de branche, ne stashe pas. Mets tes fichiers temporaires dans `.sprintsaver/tmp/` (ignoré par git) ou supprime-les.
- Reste dans le périmètre des findings. Chaque changement hors de ce périmètre sera relu à son tour et peut ouvrir de nouveaux findings.

## Traiter chaque finding bloquant, un par un

1. **Vérifie qu'il est réel.** Relis le code concerné et reproduis le scénario décrit, idéalement par un test. Le relecteur n'avait pas ton contexte et peut se tromper.
2. **S'il est réel**, corrige selon sa catégorie :
   - `bug` ou `regression` : écris d'abord un test qui reproduit le scénario et échoue, corrige, puis vérifie qu'il passe. Le test empêche le défaut de revenir et montre au relecteur suivant qu'il est corrigé.
   - `criterion` : complète l'implémentation, ajoute le test qui asserte la partie manquante du critère, ou les deux. Rattache le test aux indices des critères concernés.
   - `security` : corrige à la source (validation, échappement, contrôle d'accès) avec le mécanisme que le dépôt utilise déjà, et ajoute un test si le cas s'y prête.
3. **S'il est faux**, ne modifie pas le code pour le faire taire. Explique précisément dans `summary` pourquoi le scénario ne peut pas se produire (garde existante, typage, appelant unique). La review suivante en jugera.
4. **Corrige la cause, pas seulement l'endroit pointé.** Si le même défaut existe ailleurs dans le diff, corrige-le partout.

Ne touche aux nits que si la correction est triviale et sans risque (faute de frappe, nom trompeur dans le code du ticket), jamais au prix de modifier du code hors du diff.

Quand tout est traité, lance les tests ajoutés, puis la suite complète ou au moins les zones touchées.

## Remplir la sortie

- `summary` : finding par finding, ce que tu as fait (corrigé, ou contesté avec la raison).
- `rootCause` : la cause de chaque défaut corrigé, une phrase chacun.
- `testsAdjusted` : tests ajoutés ou modifiés, avec les critères qu'ils prouvent.
- `unrelatedToTicket` : false en règle générale, puisque les findings portent sur le diff du ticket.
