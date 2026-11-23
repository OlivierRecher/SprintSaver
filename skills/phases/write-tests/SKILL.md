---
name: write-tests
description: Écriture red-first des tests qui prouvent les critères testables d'un ticket, avant toute implémentation.
---

# Écrire les tests, red-first

Tu écris les tests qui prouveront les critères du ticket avant que le code existe. Une autre session implémentera ensuite jusqu'à les faire passer, sans avoir le droit de les affaiblir, puis une vérification indépendante contrôlera que chaque test prouve vraiment son critère. Tes tests sont la spécification exécutable du ticket : tout le reste dépend de leur précision.

## Cadre

- L'orchestrateur commite tout l'état du worktree (`git add -A`) après ta session. Ne commite pas, ne change pas de branche, ne stashe pas. Mets tes fichiers temporaires dans `.sprintsaver/tmp/` (ignoré par git) ou supprime-les.
- N'écris pas le code de production, sauf les squelettes décrits à l'étape 3.

## 1. Trouver les conventions

Avant d'écrire, ouvre deux ou trois tests voisins du code concerné et reprends leurs choix : framework et assertions, emplacement et nommage des fichiers, structure (describe/it, classes, fixtures), helpers et fabriques de données, façon de mocker. Un test qui ne ressemble pas aux autres sera relevé en review, et un fichier mal nommé ou mal placé risque de ne pas être collecté par la commande de test. La section projet et le CLAUDE.md du dépôt priment sur tes habitudes.

## 2. Au moins un test par critère testable

Pour chaque critère classé testable dans l'analyse, écris un ou plusieurs tests qui l'assertent directement, en suivant la consigne de test de l'analyse quand elle tient. Un même test peut couvrir plusieurs critères si c'est naturel.

- Nomme le test pour qu'on reconnaisse le critère : décris le comportement attendu dans les termes du ticket (« refuse un email sans @ », pas « test validation 2 »).
- Asserte le résultat observable exigé : valeur retournée, état persisté, message affiché, code HTTP. Vérifier qu'aucune exception n'est levée ou qu'un mock a été appelé prouve rarement un critère.
- Teste au niveau le plus bas qui reste fidèle au critère. Un critère formulé du point de vue de l'utilisateur peut exiger un test d'intégration ou de composant si le dépôt en a.
- Un critère qui énumère plusieurs cas (« X et Y », « pour tous les rôles ») demande une assertion par cas.
- Ajoute les cas limites qui font partie du critère (vide, absent, borne), pas une batterie exhaustive.

Si un critère classé testable s'avère impossible à tester proprement, n'écris pas un test creux pour remplir la case : explique le problème dans `notes`.

## 3. Red pour la bonne raison

Un test red ne vaut que s'il échoue parce que le comportement attendu manque. Lance les tests ciblés (tes fichiers, ou un filtre par nom) et lis la sortie.

- **Échec d'assertion** avec des valeurs attendue et obtenue cohérentes avec le critère : c'est le résultat voulu.
- **Erreur d'import, de compilation, symbole manquant** : évite-la quand c'est possible. Si le test a besoin d'une fonction, d'une classe ou d'une route qui n'existe pas encore, crée un squelette minimal sans logique (bonne signature, valeur de retour neutre) pour que le test compile et échoue sur son assertion. Dans un langage compilé, un symbole manquant casse tout le projet de test, le squelette y est indispensable. Signale chaque squelette dans `notes`.
- **Test qui passe déjà** : soit le comportement existe déjà, ce qui est une information importante pour l'implémentation (mets-la dans `notes`), soit ton test ne vérifie pas ce que tu crois. Tranche avant de continuer.
- **Erreur d'environnement** (base absente, dépendance manquante) : corrige-la si elle est locale et simple, sinon décris-la.

Vérifie aussi que les tests existants qui passaient passent toujours, hormis ceux que tu as modifiés exprès.

Si le projet est en mode `ci-only` et que tu ne peux pas lancer les tests, dis-le dans `redEvidence` et explique pourquoi chaque nouveau test échouera.

## 4. Tests existants

Ne supprime ni n'affaiblis un test existant, sauf si le ticket change précisément le comportement qu'il vérifiait. Dans ce cas, adapte-le au nouveau comportement, déclare-le avec `change: "modified"` et dis dans `explanation` ce qui change et quelle exigence du ticket l'impose. Ne régénère pas de snapshots à l'aveugle.

## 5. Remplir la sortie

- `tests` : chaque test ajouté ou modifié, avec son nom exact tel qu'il apparaît dans le code (la vérification le cherchera sous ce nom), son fichier relatif à la racine, les indices des critères qu'il prouve et ce qu'il vérifie en une ligne. Un helper ou une fixture n'est pas un test.
- `redEvidence` : la commande exacte et un extrait court de sa sortie où l'on voit chaque nouveau test échouer avec son message d'assertion. Pas la sortie complète.
- `notes` : ce que l'implémenteur doit savoir, comme les squelettes créés, un comportement déjà présent, un piège de setup ou de données, un critère difficile à tester.
