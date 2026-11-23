---
name: implement
description: Implémentation minimale et idiomatique qui fait passer les tests red d'un ticket, dans le style du dépôt.
---

# Implémenter

Des tests red ont été écrits et commités pour les critères du ticket. Écris le code de production qui les fait passer, comme le ferait un bon développeur de l'équipe. Une review indépendante relira ensuite le diff complet, puis un humain.

## Cadre

- L'orchestrateur commite tout l'état du worktree (`git add -A`) après ta session. Ne commite pas, ne change pas de branche, ne stashe pas. Mets tes fichiers temporaires dans `.sprintsaver/tmp/` (ignoré par git) ou supprime-les.
- Les tests sont la spécification. Ne les modifie pas pour qu'ils passent. Si un test est faux (il contredit le critère ou le reste du ticket, dépend d'un détail d'implémentation arbitraire, a un setup erroné), corrige-le et déclare-le dans `testsAdjusted` avec une explication qui convaincra un relecteur. Retirer ou assouplir une assertion pour avancer n'est jamais une correction : la vérification des critères le détectera et le ticket reviendra.

## Démarche

1. Lis l'analyse, les tests et les notes de la phase précédente (squelettes créés, comportement déjà présent). Lance les tests du ticket pour voir les échecs actuels.
2. Avant d'écrire, lis le code de la zone : comment les modules voisins gèrent erreurs, validation, logs, accès aux données, injection de dépendances. Réutilise les utilitaires existants au lieu d'en créer.
3. Remplace les squelettes par une vraie implémentation.
4. Écris le minimum qui satisfait les critères, de façon idiomatique pour ce dépôt. Minimal ne veut pas dire bâclé : gère les cas limites que le ticket implique ou que le code voisin gère déjà, même sans test dédié.
5. Lance les tests du ticket, puis la suite complète si elle tient en quelques minutes, sinon les tests des modules touchés. Lance aussi le build ou le typecheck et le lint si le projet en a : la CI les lancera, et un échec y coûte une itération entière.

## Ce qu'on évite

- **Changements hors sujet** : refactoring, renommage, reformatage ou correction opportuniste hors du périmètre du ticket. Chaque ligne du diff doit se justifier par le ticket ; le bruit cache les vrais changements au relecteur et multiplie les conflits au rebase. Si tu repères un problème voisin, signale-le dans `summary`.
- **Nouvelle dépendance** quand le dépôt a déjà de quoi faire. Si elle est vraiment nécessaire, ajoute-la avec le gestionnaire du projet pour que le lockfile soit à jour, et justifie-la dans `summary`.
- **Code qui contourne les tests** : branche spéciale pour l'environnement de test, valeur codée en dur qui colle aux données du test, comportement qui ne marche que pour les cas testés. Le code doit être correct pour toute entrée que le critère couvre.
- **Commentaires qui racontent le ticket.** Un commentaire explique un pourquoi non évident, rien de plus.
- **Mécanisme parallèle** : si le changement exige une migration, une clé de configuration ou une traduction, passe par le mécanisme que le dépôt utilise déjà.

## Remplir la sortie

- `summary` : quoi et pourquoi en quelques lignes, pour un relecteur : fichiers clés, choix non évidents, ce que tu as délibérément laissé de côté.
- `testsAdjusted` : tous les tests ajoutés ou modifiés pendant cette phase, liste vide sinon. Un test ajouté pour un cas limite y figure aussi, avec une liste de critères vide s'il ne prouve aucune case.
- `testsPassingLocally` : true seulement si tu as vu la suite, ou à défaut tous les tests des zones touchées, passer après ta dernière modification. Si tu n'as pas pu les lancer, mets false et dis pourquoi dans `summary`. L'orchestrateur relance de toute façon la commande de test : une affirmation fausse ne fait que retarder le diagnostic.
