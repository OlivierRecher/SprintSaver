---
name: retro
description: Rétrospective d'un ticket traité par SprintSaver, qui identifie ce qui a coûté des itérations et propose un patch minimal sur les skills.
---

# Rétro d'un ticket

Le ticket est terminé, livré ou bloqué. Tu reçois les résumés factuels de chaque phase produits par l'orchestrateur : itérations, durées, tests en échec, findings, erreurs de CI, raison de blocage. Ton but est que le prochain ticket de ce projet coûte moins, en inscrivant dans les skills ce qu'il aurait fallu savoir. Un humain relit ton patch et l'applique lui-même.

Ton répertoire de travail est le dépôt SprintSaver. Les skills sont sous `skills/`. Lis ceux qui sont en cause, et surtout `skills/projects/<projet>.md`, qui n'existe pas encore si le projet n'a pas de section (sa structure est dans `skills/projects/_template.md`). Ne modifie aucun fichier : ta seule production est le patch dans ta sortie.

## 1. Trouver ce qui a coûté

Parcours les résumés et repère :

- les boucles qui ont tourné plus d'une fois (test-fix, review, CI) et ce qui les a relancées ;
- les échecs dus à un fait stable du projet : commande de test qui exige un service, lint lancé en CI mais pas en local, convention de nommage des tests, dossier de fixtures, variable d'environnement, test instable connu ;
- les findings de review récurrents qui révèlent une convention de l'équipe ignorée ;
- le blocage éventuel : était-il évitable avec une information disponible dans le dépôt ?

Pour chaque coût, demande-toi ce qu'il aurait fallu savoir au départ, et si cette information servira aux tickets suivants. Une erreur de raisonnement ponctuelle, une ambiguïté propre à ce ticket ou une panne de CI passagère ne sont pas des leçons.

Un ticket passé du premier coup ne produit rien : leçons vides, patch vide. C'est la réponse attendue la plupart du temps.

## 2. Choisir où écrire

- **`skills/projects/<projet>.md` d'abord, et presque toujours** : commandes, pièges, conventions et leçons propres à ce dépôt. Range chaque ajout dans la section correspondante du gabarit.
- **Un skill générique** (`skills/phases/…`, `skills/types/…`) seulement si la leçon vaut pour n'importe quel dépôt et que le skill actuel induit en erreur ou omet quelque chose d'important. Un ticket isolé le justifie rarement : dans le doute, note la leçon côté projet.

Ne sur-apprends pas. Une règle tirée d'un seul cas et formulée trop largement dégradera d'autres tickets. Écris des faits précis et vérifiables (« `npm test` exige `docker compose up -d db` au préalable »), pas des injonctions vagues (« faire attention aux tests »). Ne raconte pas le ticket : le fichier est injecté dans toutes les sessions futures du projet, qui ne doivent recevoir que des faits généraux, jamais la trajectoire d'un ticket passé.

Vérifie que la leçon n'est pas déjà écrite. Si elle l'est et a quand même été ignorée, reformule-la au lieu de la dupliquer. Garde le patch court, quelques lignes : chaque ligne ajoutée est relue par chaque session. Retire au passage une ligne devenue fausse si les résumés le prouvent.

## 3. Écrire le patch

Un diff unifié que `git apply` accepte depuis la racine du dépôt SprintSaver :

- en-têtes `diff --git a/skills/… b/skills/…`, `--- a/…`, `+++ b/…` ;
- pour créer la section d'un projet, `new file mode 100644` et `--- /dev/null`, avec les titres du gabarit sans ses commentaires ;
- lignes de contexte copiées exactement du fichier actuel, et comptes justes dans chaque en-tête `@@ -a,b +c,d @@` ;
- un saut de ligne final.

Valide-le sans rien écrire dans le dépôt, en le passant sur l'entrée standard de `git apply --check` (par exemple avec un heredoc `<<'EOF'`). S'il est refusé, corrige-le : un patch inapplicable est perdu.

## Remplir la sortie

- `lessons` : une entrée par leçon, avec ce qui a coûté (chiffres des résumés à l'appui) et ce qu'il aurait fallu savoir. Une leçon trop fragile pour être écrite dans un skill peut figurer ici sans patch.
- `patch` : le diff validé, ou une chaîne vide.
