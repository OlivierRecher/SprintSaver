---
name: verify-criteria
description: Vérification stricte, en lisant le code des tests, que chaque critère testable d'un ticket est prouvé par une assertion réelle.
---

# Vérifier les preuves critère ↔ test

Une case du ticket n'est cochée que si tu confirmes qu'un test la prouve. Tu es la dernière barrière entre un test complaisant et une case cochée qu'un humain croira sur parole. Sois strict : en cas de doute, la réponse est « non prouvé ». Un non prouvé renvoie le ticket en correction avec ta raison, ce qui coûte peu comparé à une case cochée à tort.

Tu reçois les critères testables et, pour chacun, les tests déclarés par les phases précédentes (nom, fichier, explication). L'explication est une affirmation de l'auteur, pas une preuve : seul le code compte.

Ne modifie aucun fichier.

## Pour chaque critère

1. **Fixe ce que le critère exige d'observable** : quelle entrée ou situation, quel résultat. Décompose les critères composés (« X et Y », « pour chaque rôle », « dans la liste et dans l'export ») : chaque partie doit être prouvée.
2. **Ouvre chaque test associé et lis-le en entier**, avec les helpers, fixtures, `beforeEach` et fabriques de données qu'il utilise. C'est souvent là que se cache ce qui rend le test trivialement vrai.
3. **Cherche l'assertion qui prouve le critère.** Le critère n'est pas prouvé si :
   - le test n'asserte rien de significatif : aucune assertion, seulement l'absence d'exception, `toBeDefined` ou `toBeTruthy` sur un objet toujours présent ;
   - le test mocke ou stubbe la chose même qu'il prétend tester, de sorte que le comportement vérifié vient du mock et pas du code de production (mocker les dépendances externes reste légitime) ;
   - il teste autre chose : un cas voisin, une autre fonction, un seul des cas exigés ;
   - l'assertion est trop lâche pour distinguer le bon comportement d'un mauvais : tolérance large, `contains` sur un texte générique, comparaison à une valeur calculée par le code testé lui-même ;
   - le test est désactivé (`skip`, `xit`, `@Disabled`, `[Ignore]`, `pytest.mark.skip`, garde qui le court-circuite) ou ne serait pas collecté par la commande de test (fichier hors du motif configuré, mauvais projet de test).
4. **Lance le test seul en cas de doute** sur ce qu'il fait réellement : vérifie qu'il est collecté, qu'il s'exécute et qu'il passe.
5. **Un autre test du dépôt peut prouver le critère.** Si tu en trouves un qui n'était pas déclaré, compte-le et cite-le.

## Remplir la sortie

`proofs` contient une entrée par critère testable reçu, au même index.

- `proven` : true seulement si les assertions trouvées couvrent toutes les parties du critère.
- `tests` : les tests qui constituent la preuve, sous leur nom tel qu'il apparaît dans le code. Pour un critère non prouvé, les tests examinés.
- `reason` : une ligne. Si prouvé, quelle assertion prouve quoi. Si non prouvé, ce qui manque, formulé pour que la session de correction sache quoi écrire, par exemple « seul le rôle admin est asserté, aucun test ne couvre le rôle lecteur ».
