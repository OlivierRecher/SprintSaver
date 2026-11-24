---
name: ticket
description: Rédige ou améliore un ticket GitLab de qualité à partir d'un besoin. Interroge l'utilisateur sur ce qu'il veut vraiment, explore le code du dépôt et les tickets/MR existants (glab), puis produit une description claire avec des critères d'acceptation exhaustifs en cases à cocher, chacun vérifiable. Crée le ticket après validation, ou modifie celui dont on fournit le lien. À utiliser dès que l'utilisateur veut écrire, rédiger, préciser, compléter, reformuler ou découper un ticket, une issue, une user story, un bug report ou des critères d'acceptation, même s'il décrit juste un besoin (« il faudrait que l'app… », « fais-moi un ticket pour… ») ou colle un lien de ticket GitLab à améliorer.
---

# Rédiger un ticket de qualité

Le but : qu'une personne (ou un agent de code) qui ne connaît QUE ce ticket livre exactement ce que l'utilisateur veut, sans aller-retour. Un ticket raté coûte cher plus tard : un critère flou produit du code « conforme » mais faux, un cas limite oublié devient un bug. Le travail se fait donc surtout en amont : comprendre, explorer, puis écrire.

Converse dans la langue de l'utilisateur, et rédige le ticket dans la langue des tickets existants du projet. Tu ne crées ni ne modifies rien sur GitLab sans l'accord explicite de l'utilisateur sur le texte final. N'ajoute que des labels qu'il a validés, et jamais de label qui déclenche un traitement automatique (par exemple un label qui met le ticket dans la file d'un agent) : c'est l'utilisateur qui décide quand lancer ce traitement.

## 1. Situer le travail

- **Lien de ticket fourni** → mode *modification*. Lis-le en entier : `glab issue view <url> --comments`. Garde tout ce qui a de la valeur (contexte, décisions prises dans les commentaires) : tu l'améliores, tu ne le remplaces pas.
- **Sinon** → mode *création*. Le projet cible est celui du dépôt courant (glab le déduit du remote git). Si tu n'es pas dans un dépôt du projet, demande le projet (`groupe/projet` ou son URL) et passe-le avec `-R`.
- Lis le `CLAUDE.md` / `AGENTS.md` / README du dépôt s'ils existent : ils donnent le vocabulaire et les conventions du projet.

## 2. Explorer l'existant

Explore avant de questionner : le code révèle souvent que le besoin est déjà partiellement couvert (une fonctionnalité qui existe et qu'il faut restreindre, un écran à étendre plutôt qu'à créer), ce qui change la reformulation et les questions elles-mêmes. C'est aussi ce qui rend le ticket juste et évite les doublons :
- **le code** concerné (Grep/Glob/Read) : comment la fonctionnalité se comporte aujourd'hui, ses règles, ses limites. Tu en tires une reformulation juste, de meilleures questions et des critères réalistes (« le comportement actuel X est conservé »). Cette exploration sert à toi, pas au ticket : ce que tu y apprends n'y entre que traduit en fonctionnement visible (voir « Le quoi, pas le comment » en 4) ;
- **les tickets** : `glab issue list --search "<mots-clés>" --all -O json` (plusieurs recherches courtes valent mieux qu'une longue). Un ticket ouvert qui couvre déjà le besoin → signale-le et propose de le compléter plutôt que d'en créer un doublon. Un ticket fermé similaire → lis-le (`glab issue view <iid> --comments`) : il dit souvent ce qui avait été décidé ou ce qui a déjà cassé ;
- **les MR** liées si utile (`glab mr list --search …`).

Ne modifie aucun fichier du dépôt : tu ne fais que lire.

Si GitLab est injoignable (glab en erreur réseau, VPN coupé), continue avec le code, dis à l'utilisateur que les doublons et les labels n'ont pas pu être vérifiés, et refais ces vérifications avant la création.

## 3. Comprendre le besoin

Reformule le besoin en une ou deux phrases, à la lumière de l'existant (« aujourd'hui X est déjà possible à tout moment ; tu veux le limiter à… »), et vérifie que c'est bien ça. Puis pose les questions dont la réponse change le ticket, par **tours** : numérote les questions d'un même tour, donne pour chacune ta réponse recommandée (l'utilisateur peut répondre « ok » pour l'accepter), et attends les réponses avant le tour suivant. Une question qui dépend d'une réponse pas encore donnée attend le tour d'après.

Ne pose pas une question dont la réponse est dans le code ou les tickets existants : va la chercher. Garde pour l'utilisateur les décisions : ce qu'on veut, pour qui, ce qui est hors périmètre, les arbitrages.

À couvrir selon le cas :
- **qui** est concerné (rôle, type d'utilisateur, permissions) et **pourquoi** (le problème résolu, pas seulement la solution imaginée) ;
- le **comportement attendu**, avec des exemples concrets : entrées et résultats précis, valeurs, messages, états ;
- ce qui est **hors périmètre** ;
- pour un **bug** : étapes de reproduction, résultat observé vs attendu, environnement, fréquence, depuis quand (une régression ?).

## 4. Rédiger

Format de la description (sections vides omises) :

```markdown
## Contexte
Pourquoi ce ticket existe : le problème, qui il touche, et comment l'application fonctionne aujourd'hui sur ce point (vu de l'utilisateur).

## Comportement attendu
Ce que l'utilisateur pourra faire / verra, décrit du point de vue de l'utilisateur, avec des exemples concrets.

## Hors périmètre
- Ce qui ne fait pas partie de ce ticket (et où ça sera traité si connu).

## Critères d'acceptation
- [ ] …
```

Pour un bug, remplace « Comportement attendu » par « Reproduction » (étapes numérotées, résultat observé, résultat attendu, environnement).

**Le quoi, pas le comment.** Le ticket dit ce que le produit doit faire et pourquoi, jamais comment le construire. Pas de section de pistes techniques, et aucun détail technique de l'existant : ni nom de fichier, de composant, de table, de fonction, de clé de traduction ou de bibliothèque, ni valeur interne (poids, constantes, codes). La découverte du code revient à la personne qui implémente. L'existant se décrit comme un fonctionnement observable : « aujourd'hui, un bénévole qui a candidaté passe devant un bénévole compétent », pas « le bonus de candidature (300) dépasse celui de compétence (120) ».

**Les cases à cocher sont réservées aux critères d'acceptation.** Les agents de code et outils d'automatisation considèrent souvent CHAQUE case de la description comme un critère à prouver : une case ailleurs (liste de tâches, checklist de doc) deviendrait un faux critère. Partout ailleurs, utilise des puces simples.

### Critères d'acceptation

C'est le cœur du ticket. Chaque critère :
- décrit **un seul** comportement **observable** (ce que fait le système, pas comment il est codé) ;
- est **vérifiable par un test automatisé** du dépôt, avec des valeurs concrètes : situation de départ, action, résultat attendu, en une phrase ;
- n'utilise pas de mots non mesurables (« rapide », « intuitif », « correct », « bien géré ») sans les chiffrer ou les expliciter ;
- se lit sans le reste du ticket.

« Vérifiable par un test » porte sur le **résultat observable**, pas sur la façon de le tester. Si l'écran n'a pas de tests d'interface, le critère reste formulé côté utilisateur (« le bouton n'est plus proposé »). C'est à l'implémentation de choisir le niveau de test (logique sous-jacente, composant…). N'écris pas de critère sur une fonction ou une structure interne.

**Bornes** (dates, durées, quantités) : teste les deux côtés de la limite avec des valeurs proches (« dans 24 h 01 min » est accepté, « dans 23 h 59 min » est refusé) et dis explicitement si la valeur exacte est incluse. Pour les durées, précise la référence (heure de début de quoi, fuseau, heure d'été) quand ça peut prêter à confusion.

**Textes affichés** : quand un texte compte, écris-le exactement. Si le dépôt est multilingue (fichiers de traduction), donne-le dans chaque langue présente ou exige explicitement sa traduction, en suivant les conventions du dépôt.

Un critère qui n'est pas testable automatiquement mais qui compte (validation par une personne, déploiement, doc externe) reste une case, suffixée de **« (vérification manuelle) »** : il sera listé à vérifier par un humain au lieu d'être compté comme prouvé.

Pour l'exhaustivité, passe le besoin à travers la grille de `references/criteres.md` (cas nominal, limites, erreurs, données vides, permissions, existant préservé…) et ne garde que les lignes pertinentes. Ce fichier donne aussi des exemples de critères bons et mauvais : lis-le avant d'écrire les critères.

**Taille.** Propose de découper en plusieurs tickets liés quand le besoin contient plusieurs fonctionnalités livrables séparément, ou au-delà d'environ 10 critères. Huit à dix critères autour d'une seule règle (cas nominal, bornes, erreurs, non-régression) restent un seul ticket. Un ticket se livre en une MR raisonnable.

## 5. Relire puis faire valider

Avant de montrer le brouillon, relis-le comme le ferait la personne qui va l'implémenter sans pouvoir te poser de question :
- chaque critère est-il testable et sans ambiguïté ? Deux développeurs différents écriraient-ils le même test ?
- un cas limite ou une erreur plausible n'est-il couvert par aucun critère ?
- un critère impose-t-il une implémentation sans raison ?
- reste-t-il un détail technique (fichier, composant, table, fonction, valeur interne) ? Remplace-le par le fonctionnement qu'il produit, ou retire-le.
- reste-t-il une question ouverte ? Si oui, pose-la maintenant plutôt que de l'écrire dans le ticket.

Montre ensuite à l'utilisateur le titre proposé (court, à l'impératif ou descriptif, sans numéro), les labels (`bug` ou `feature` s'ils existent dans le projet : `glab label list` ; s'il n'a pas pu être lu, propose-les « à vérifier ») et la description complète. Liste aussi les hypothèses que tu as prises sans confirmation explicite, pour qu'il les valide d'un coup d'œil. En mode modification, montre clairement ce qui change par rapport à l'existant. Intègre ses retours et remontre jusqu'à validation explicite (« ok », « crée-le », « vas-y »…).

## 6. Créer ou modifier

Écris la description dans un fichier temporaire (le scratchpad de la session s'il existe, sinon `$(mktemp)`), puis :

- **création** : `glab issue create -t "<titre>" --description-file <fichier> -l <label> --yes [-R <projet>]`
- **modification** : `glab issue update <iid> -R <url du projet> --description-file <fichier>` ; ajoute `-t` seulement si l'utilisateur a validé un nouveau titre, et `-l` / `-u` seulement pour des changements de labels qu'il a validés.

N'ajoute aucun label non validé. Termine en donnant le lien du ticket et, si des tickets liés ou à découper ont été identifiés, rappelle-les en une ligne.
