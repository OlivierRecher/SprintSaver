---
name: feature
description: Spécificités d'un ticket de type fonctionnalité (s'aligner sur l'existant, cerner les cas limites, ne pas sur-construire), à appliquer selon la phase en cours.
---

# Ticket de type fonctionnalité

Ce skill complète celui de ta phase : applique la partie qui la concerne. Tout ticket qui n'est pas un bug passe par ce flux (évolution, amélioration, tâche technique).

Le risque principal d'une fonctionnalité est de construire autre chose, ou davantage, que ce que demande le ticket, ou de la construire à côté des patterns de l'équipe.

## Analyse

- **Trouve une fonctionnalité analogue** déjà présente : un endpoint de même forme, un autre écran de liste, un autre export, une autre règle de validation. Elle donne la structure à suivre, les couches à toucher et le style des tests. Cite-la dans le plan.
- **Consulte l'historique** : `git log --grep` sur le terme métier, `search_issues` sur les tickets fermés similaires, puis `get_issue_closing_mrs` et `get_mr_diff` pour voir comment une fonctionnalité comparable a été livrée (fichiers touchés, migrations, tests). Note ce que tu as examiné dans `precedents`. Si rien ne s'y prête, une liste vide suffit.
- **Découpe** : quelles couches changent (données, logique, API, interface) et dans quel ordre. Le plan suit ce découpage.
- **Cerne les cas limites** : pour chaque entrée nouvelle, que se passe-t-il si elle est vide, absente, trop longue, mal formée, en double, ou si l'utilisateur n'a pas le droit ? Ce que le ticket tranche est couvert par un critère. Ce qu'il ne tranche pas devient une hypothèse alignée sur l'existant, ou une question bloquante si l'enjeu est réel.

## Écriture des tests

Teste le comportement exigé par les critères au niveau où l'équipe teste déjà des fonctionnalités analogues. Pour chaque entrée nouvelle, ajoute les tests de validation qui découlent des critères ou des hypothèses de l'analyse.

## Implémentation

- Reproduis la structure de la fonctionnalité analogue (couches, nommage, gestion d'erreur, validation) au lieu d'inventer une architecture.
- Valide les entrées à la frontière, comme le fait le code existant (schéma, DTO, validateur), avec des messages d'erreur dans le même style.
- Ne sur-construis pas : pas d'option de configuration, d'abstraction générique, de paramètre « pour plus tard » ni de cas d'usage que les critères ne demandent pas. Ce qui n'est pas demandé n'est ni testé ni vérifié, et alourdit la review.
- Si le changement est visible par d'autres (API publique, schéma de données, format d'export), reste rétrocompatible sauf si le ticket dit le contraire, et signale-le dans le résumé.

## Review et vérification

Un comportement ajouté par le diff sans être demandé ni testé mérite au moins un nit. S'il modifie un comportement existant, examine-le comme une régression potentielle.
