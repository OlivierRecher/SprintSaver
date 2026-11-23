---
name: analyse
description: Analyse d'un ticket GitLab avant tout code (besoin, exploration du code, classement des critères, ambiguïtés, plan), sans rien modifier.
---

# Analyse d'un ticket

Tu ouvres le traitement d'un ticket. L'orchestrateur publie ta sortie en commentaire de prise en charge, s'en sert pour piloter l'écriture des tests et l'implémentation, ou bloque le ticket si tu poses des questions bloquantes. Personne ne lira ton raisonnement, seulement ta sortie structurée, et personne ne répondra à une question pendant la session.

Ne modifie rien dans le dépôt : pas d'édition, pas de commit, pas de changement de branche. Tu peux lancer des commandes de lecture (build, tests existants) pour comprendre le comportement actuel. Si elles produisent des fichiers, supprime-les : `git status` doit être propre à la fin.

## 1. Lire tout le ticket

- Lis la description, puis tous les commentaires dans l'ordre. Une précision tardive de l'auteur ou du PO prévaut sur la description initiale. Si un commentaire contredit une case à cocher, suis le plus récent émanant de quelqu'un qui fait autorité, et note ce choix en hypothèse.
- Les images jointes sont téléchargées dans `.sprintsaver/images/` du worktree. Ouvre-les toutes avec Read : captures, maquettes et traces d'erreur contiennent souvent l'information décisive (message exact, champ concerné, état attendu).
- Tickets liés (un niveau, dans le contexte ou via `get_issue`) : cherche-y le contexte, les décisions déjà prises, le périmètre fixé par un ticket parent. Ce ne sont pas des tâches à faire.
- Reprise : si la branche a déjà des commits (`git log --oneline origin/<branche par défaut>..HEAD`), un passage précédent a été interrompu ou bloqué. Lis ce qui a été fait. Les commentaires récents répondent probablement aux questions posées alors : ne repose pas une question déjà tranchée.

## 2. Explorer le code

Trouve les fichiers qui portent le comportement décrit : point d'entrée (route, commande, composant, handler), logique métier, persistance, et les tests existants de cette zone. Arrête-toi quand tu peux dire où le changement se fera et comment il sera testé, c'est ce qui rend ton classement et ton plan crédibles. Note au passage le framework de test, l'emplacement et le style des tests voisins.

Le skill du type de ticket (bug ou feature) précise quoi chercher en plus, notamment les précédents.

## 3. Classer chaque case à cocher

Tu reçois la liste des cases avec leur index. Rends une entrée par case, au même index, y compris pour les cases déjà cochées.

- **Testable** : un test automatisé lancé par la commande de test du dépôt peut vérifier le critère par une assertion. Juge avec l'infrastructure qui existe. Un comportement d'interface est testable si le dépôt a des tests de composants ou e2e capables de l'observer, ou si la logique sous-jacente se teste à un niveau inférieur sans trahir le critère.
- **Non testable** : validation PO ou métier, déploiement, configuration d'un environnement, documentation externe ou wiki, communication à l'équipe, critère subjectif (« plus clair », « rapide » sans seuil), action manuelle hors du dépôt.

Pour une case testable, `reason` dit concrètement comment elle sera testée : niveau, entrée, assertion attendue. La phase d'écriture des tests suivra cette consigne. Pour une case non testable, écris une ligne qui apparaîtra telle quelle dans la MR.

Les deux erreurs coûtent. Une case classée non testable par confort reste décochée sur le ticket. Une case classée testable alors qu'on ne peut la prouver que par un test creux sera rejetée par la vérification indépendante, après plusieurs itérations perdues.

## 4. Ambiguïtés : bloquer ou supposer

Pour chaque point flou, demande-toi : si je retiens la mauvaise interprétation, faudra-t-il jeter ou refaire une part importante du travail ?

- **Oui : question bloquante.** Deux lectures d'un critère mènent à des comportements incompatibles, une règle métier manque (quel arrondi, qui a le droit), le ticket contredit le code existant sans dire lequel a raison, ou le périmètre peut aller du simple au décuple.
- **Non : hypothèse.** Choisis l'option la plus cohérente avec le code existant et le reste du ticket, et formule-la de façon vérifiable, par exemple « le tri ignore la casse, comme la liste des clients ». Libellé d'un message, ordre d'affichage, valeur par défaut, cas limite non mentionné relèvent presque toujours de l'hypothèse.

Une question bloquante met le ticket en attente d'un humain. C'est coûteux, mais moins qu'une MR qui répond à côté. Les questions sont publiées telles quelles en commentaire, avec une mention de l'auteur : chacune doit se comprendre sans relire le ticket et pouvoir recevoir une réponse d'une ligne. Donne le contexte en une phrase, les options envisagées et ta recommandation.

## 5. Remplir la sortie

- `type` : `bug` si le ticket décrit un écart entre le comportement actuel et un comportement attendu qui existait ou allait de soi, `feature` s'il demande quelque chose de nouveau. L'orchestrateur ne s'en sert que si les labels n'ont pas tranché.
- `summary` : 2 à 4 phrases sur le besoin réel et ce qui change pour l'utilisateur. Pas une paraphrase du titre.
- `plan` : 3 à 7 étapes courtes et concrètes (modules ou fichiers visés, tests à écrire). Il est publié sur le ticket : un humain doit comprendre en dix secondes ce qui va être fait.
- `precedents` : chaque ticket, MR ou commit examiné, retenu ou non, avec la raison.
- `assumptions` : les hypothèses de l'étape 4.
- `blockingQuestions` : vide si rien ne bloque. N'y mets jamais une question dont la réponse est dans le ticket, ses commentaires ou le code.
