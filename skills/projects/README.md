# Sections projet

Chaque fichier `skills/projects/<nom>.md` contient ce qu'un agent doit savoir sur **un** projet suivi par SprintSaver. `<nom>` est la clé `name` du projet dans `~/.sprintsaver/config.yaml`.

## Comment le fichier est utilisé

- L'orchestrateur l'injecte dans le prompt système de toutes les sessions d'un ticket de ce projet, après le skill de phase et le skill de type, avant le `CLAUDE.md` du dépôt cible. Il n'est jamais chargé pour un autre projet.
- Il est alimenté à la main et par la rétro. En fin de ticket, la rétro propose un patch dans `~/.sprintsaver/runs/<projet>-<iid>/retro.patch`. Relis-le, puis applique-le depuis la racine du dépôt SprintSaver avec `git apply <chemin>`.
- Un projet sans fichier fonctionne quand même. La section se construit au fil des tickets.

## Ce qui y va

- Des faits durables que le dépôt ne dit pas de lui-même, ou que les agents ont manqués : une commande de test qui exige un service, un lint que seule la CI lance, une convention de nommage des tests, une zone fragile.
- Des faits généraux, jamais le récit d'un ticket. Les sessions ne doivent recevoir aucune trace des trajectoires passées : on écrit « les tests d'intégration exigent `docker compose up -d db` », pas « sur le ticket 42, les tests ont échoué parce que… ».

## Ce qui n'y va pas

- Ce que le `CLAUDE.md` du dépôt dit déjà : il est injecté lui aussi. Une convention utile aux humains comme aux agents a plutôt sa place dans ce `CLAUDE.md`, si l'équipe l'accepte.
- Les secrets, tokens et URLs internes sensibles.
- Le détail qui ne sert qu'une fois. Chaque ligne est relue par chaque session du projet : vise moins de 80 lignes et supprime ce qui devient faux.

## Créer la section d'un projet

```sh
cp skills/projects/_template.md skills/projects/<nom>.md
```

Remplis ensuite chaque section et supprime les commentaires du gabarit.

## Gabarit

Les sections, dans cet ordre :

- **Contexte** : ce que fait le produit et pour qui, la stack, l'organisation du dépôt. 3 à 6 lignes.
- **Commandes** : setup, build, test complet et ciblé, lint, format, typecheck, avec leurs pièges (services à démarrer, variables d'environnement, durée, contrôles que seule la CI lance).
- **Conventions de code et de test** : ce que la review exige et que le code ne montre pas d'emblée, comme l'emplacement et le nommage des tests, les helpers à réutiliser, la façon de mocker ou le style des commits.
- **Pièges connus** : tests instables, zones fragiles, différences entre local et CI, fichiers générés.
- **Leçons des tickets précédents** : un fait général par ligne, ajouté par la rétro ou à la main.

Le fichier [`_template.md`](_template.md) contient ce gabarit vide.
