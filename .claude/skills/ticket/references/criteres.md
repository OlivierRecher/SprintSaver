# Critères d'acceptation : grille d'exhaustivité et exemples

## Grille

Passe le besoin à travers chaque ligne. Pour chacune, demande-toi « qu'est-ce qui doit se passer ? ». Si la réponse compte pour l'utilisateur et n'est pas évidente, c'est un critère. Ignore les lignes sans objet : un ticket n'a pas besoin de toutes les cocher.

| Axe | Questions à se poser |
|---|---|
| Cas nominal | Le scénario principal, avec des valeurs concrètes. Souvent 1 à 3 critères. |
| Variantes | Les autres chemins légitimes : autre rôle, autre type de donnée, option activée ou non. |
| Limites | Valeurs minimales et maximales, zéro, un seul élément, beaucoup d'éléments, longueur max, dates aux bornes (fin de mois, fuseau). |
| Données vides ou absentes | Liste vide, champ non renseigné, première utilisation : que voit l'utilisateur ? |
| Erreurs | Entrée invalide, service indisponible, réseau coupé, conflit. Quel message, et quel état reste en place (rien d'enregistré à moitié) ? |
| Permissions | Qui peut et qui ne peut pas. Que se passe-t-il pour quelqu'un qui n'a pas le droit ? |
| Existant préservé | Ce qui marche aujourd'hui et ne doit pas changer, surtout ce qui partage le code modifié. C'est un critère de non-régression. |
| Persistance et cohérence | Ce qui est enregistré, ce qui survit à un rechargement ou une reconnexion, la synchronisation entre écrans ou utilisateurs. |
| Concurrence | Deux actions simultanées, double clic, deux utilisateurs sur la même donnée. |
| Interface | Textes exacts quand ils comptent, états de chargement, désactivation des actions, accessibilité (lecteur d'écran, contraste) si pertinent. |
| Performance | Seulement si c'est un enjeu, et chiffrée (« la liste de 1 000 bénévoles s'affiche en moins de 2 s »). |
| Données existantes | Migration, rétrocompatibilité, valeurs déjà enregistrées dans l'ancien format. |
| Observabilité | Ce qui doit être journalisé ou tracé, si un humain doit pouvoir diagnostiquer. |

## Exemples

**Trop vague → précis et testable**

- ✗ `- [ ] Le prix s'affiche correctement`
  ✓ `- [ ] Une mission à 10,5 € affiche « 10,50 € » sur sa fiche (virgule décimale, toujours deux décimales)`
- ✗ `- [ ] Gérer les erreurs de connexion`
  ✓ `- [ ] Si l'API renvoie une erreur réseau à l'envoi du formulaire, le message « Connexion impossible, réessaie » s'affiche et les champs saisis sont conservés`
- ✗ `- [ ] La recherche est rapide`
  ✓ `- [ ] Une recherche sur 10 000 missions renvoie ses résultats en moins de 500 ms (test de performance sur le jeu de données de test)`

**Implémentation imposée → comportement**

- ✗ `- [ ] Ajouter un useEffect qui recharge la liste`
  ✓ `- [ ] Après la création d'une mission, elle apparaît dans la liste sans recharger l'écran`

**Plusieurs comportements dans une case → une case par comportement**

- ✗ `- [ ] L'utilisateur peut modifier et supprimer ses missions mais pas celles des autres`
  ✓ `- [ ] Le créateur d'une mission peut modifier son titre et sa date`
  ✓ `- [ ] Le créateur d'une mission peut la supprimer, après confirmation`
  ✓ `- [ ] Un bénévole qui n'est pas le créateur ne voit ni « Modifier » ni « Supprimer », et l'API refuse ces actions (403)`

**Non-régression explicite**

- ✓ `- [ ] Les missions déjà enregistrées sans date de fin restent affichées et modifiables`

**Critère non automatisable, mais utile**

- ✓ `- [ ] Le texte de l'écran d'accueil est validé par la responsable communication (vérification manuelle)`

**Bug : le critère de reproduction**

- ✓ `- [ ] Un bénévole inscrit à une mission puis désinscrit peut s'y réinscrire (aujourd'hui : erreur « déjà inscrit »)`
