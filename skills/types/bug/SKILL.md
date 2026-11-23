---
name: bug
description: Spécificités d'un ticket de type bug (reproduire d'abord, chercher les précédents, corriger la cause racine), à appliquer selon la phase en cours.
---

# Ticket de type bug

Ce skill complète celui de ta phase : applique la partie qui la concerne.

Un bug est un écart entre le comportement observé et le comportement attendu. Le risque principal est de corriger le symptôme décrit sans comprendre la cause. Le bug revient alors, ou réapparaît par un autre chemin.

## Analyse : localiser et chercher des précédents

Remonte des symptômes (message d'erreur, stack trace, capture, étapes de reproduction) jusqu'au code qui produit le mauvais résultat. Formule une hypothèse de cause racine, même provisoire, et inscris-la dans le résumé ou le plan.

Cherche ensuite des précédents, car un bug ressemble souvent à un bug déjà corrigé :

1. Extrais 3 à 6 termes distinctifs : la partie stable du message d'erreur (sans identifiants ni dates), un nom de fonction ou de composant, un fichier suspect, un terme métier.
2. Lance `search_issues` sur les tickets fermés avec chacun. La recherche est textuelle : préfère des requêtes d'un ou deux mots à une phrase. Retiens au plus cinq candidats qui parlent du même symptôme ou de la même zone.
3. Pour chaque candidat, `get_issue` donne le contexte, puis `get_issue_closing_mrs` et `get_mr_diff` montrent ce qui a été corrigé et comment.
4. Dans git :
   - `git log -S'<symbole>' --oneline` trouve quand un symbole est apparu ou a disparu ;
   - `git log --grep='<mot>' -i --oneline` trouve les commits qui en parlent ;
   - `git blame` ou `git log -L` sur les lignes suspectes dit quel commit les a introduites et pourquoi.

Juge chaque précédent :

- **même cause, même zone** : le correctif passé indique la bonne approche. Ou bien le bug est une régression de ce correctif, défait par un changement ultérieur que `git blame` révèle ;
- **même symptôme, cause différente** : utile pour écarter une piste ;
- **même zone, autre problème** : utile pour les conventions et les tests de la zone.

Inscris chaque précédent examiné dans `precedents`, retenu ou non, avec la raison. Dis dans le plan ce que tu réutilises, ou pourquoi rien ne s'applique.

## Écriture des tests : reproduire d'abord

Le premier test reproduit le défaut tel que le ticket le décrit : mêmes données ou leur équivalent minimal, même chemin, assertion sur le comportement attendu. Il doit échouer avec le symptôme rapporté (mauvaise valeur, exception citée). S'il échoue autrement ou s'il passe, ta compréhension du bug est fausse : reprends le diagnostic avant d'écrire la suite. Nomme-le d'après le comportement attendu, pas d'après le numéro du ticket.

Si un précédent avait été corrigé avec un test, demande-toi pourquoi ce test n'a pas attrapé le défaut actuel. Il est peut-être à renforcer.

## Implémentation : la cause racine

- Corrige là où la donnée devient fausse, pas là où l'erreur se manifeste. Un `if (x == null) return` ajouté au point de crash masque souvent une valeur qui n'aurait jamais dû être nulle.
- Cherche les cas voisins du même défaut : même motif copié ailleurs, même fonction utilitaire, même hypothèse fausse. Corrige ceux que le ticket couvre naturellement, avec un test, et signale les autres dans le résumé au lieu d'étendre le périmètre.
- Si c'est une régression, comprends pourquoi le changement qui l'a introduite avait été fait, pour ne pas casser son intention en réparant le bug.

## Review et vérification

Vérifie que le test de reproduction exerce bien le chemin du défaut d'origine, et que la correction porte sur la cause : un relecteur doit pouvoir expliquer pourquoi le bug ne peut plus survenir. Une correction de symptôme est un finding bloquant (`bug`) dès qu'un scénario voisin reproduit encore le défaut.
