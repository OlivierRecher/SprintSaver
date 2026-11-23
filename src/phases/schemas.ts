/**
 * Sorties structurées attendues de chaque phase agent.
 * Elles sont passées au SDK (outputFormat json_schema) et revalidées par zod.
 * Garder les schémas plats et explicites : ce sont des contrats avec le modèle.
 */
import { z } from "zod";

export const AnalyseOutput = z.object({
  type: z.enum(["bug", "feature"]).describe("Type retenu si les labels n'ont pas permis de trancher"),
  summary: z.string().describe("Résumé du besoin en 2-4 phrases"),
  plan: z.array(z.string()).describe("Étapes prévues, courtes"),
  criteria: z
    .array(
      z.object({
        index: z.number().int().describe("Index de la case fourni dans la liste des critères"),
        testable: z.boolean(),
        reason: z.string().describe("Si non testable : pourquoi, en une ligne. Sinon : comment il sera testé."),
      }),
    )
    .describe("Une entrée par case à cocher du ticket, même index"),
  precedents: z
    .array(
      z.object({
        ref: z.string().describe("Référence : #iid, !mr, ou sha"),
        relevant: z.boolean(),
        why: z.string(),
      }),
    )
    .describe("Tickets/MR/commits similaires examinés"),
  assumptions: z.array(z.string()).describe("Hypothèses prises sur des ambiguïtés mineures"),
  blockingQuestions: z
    .array(z.string())
    .describe("Questions sans lesquelles on ne peut pas implémenter correctement. Vide si aucune."),
});
export type AnalyseOutput = z.infer<typeof AnalyseOutput>;

const TestEntrySchema = z.object({
  name: z.string().describe("Nom du test tel qu'il apparaît dans le code"),
  file: z.string().describe("Chemin relatif à la racine du dépôt"),
  change: z.enum(["added", "modified"]),
  criteria: z.array(z.number().int()).describe("Indices des cases prouvées par ce test"),
  explanation: z.string().describe("Ce que vérifie le test, en une ligne"),
});

export const WriteTestsOutput = z.object({
  tests: z.array(TestEntrySchema),
  redEvidence: z
    .string()
    .describe("Commande lancée et extrait de sortie montrant que les nouveaux tests échouent avant implémentation"),
  notes: z.string().describe("Remarques utiles pour la phase d'implémentation"),
});
export type WriteTestsOutput = z.infer<typeof WriteTestsOutput>;

export const ImplementOutput = z.object({
  summary: z.string().describe("Ce qui a été modifié et pourquoi, en quelques lignes"),
  testsAdjusted: z
    .array(TestEntrySchema)
    .describe("Tests ajoutés/modifiés pendant cette phase (vide si aucun)"),
  testsPassingLocally: z.boolean().describe("La suite de tests passe-t-elle d'après tes propres exécutions"),
});
export type ImplementOutput = z.infer<typeof ImplementOutput>;

/** Utilisé par test-fix, review-fix, ci-fix, rebase-fix. */
export const FixOutput = z.object({
  summary: z.string().describe("Correctifs appliqués, en quelques lignes"),
  rootCause: z.string().describe("Cause identifiée"),
  testsAdjusted: z.array(TestEntrySchema),
  unrelatedToTicket: z
    .boolean()
    .describe("true si l'échec est sans rapport avec le code du ticket (environnement, test instable, base cassée)"),
});
export type FixOutput = z.infer<typeof FixOutput>;

export const ReviewOutput = z.object({
  findings: z.array(
    z.object({
      severity: z
        .enum(["blocking", "nit"])
        .describe("blocking = bug, critère non couvert, faille de sécurité, régression. Tout le reste = nit"),
      category: z.string().describe("bug | criterion | security | regression | style | perf | other"),
      file: z.string().optional(),
      line: z.number().int().optional(),
      description: z.string().describe("Défaut constaté et scénario concret qui le déclenche"),
    }),
  ),
  summary: z.string(),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const VerifyCriteriaOutput = z.object({
  proofs: z.array(
    z.object({
      index: z.number().int(),
      proven: z.boolean().describe("true seulement si au moins un test asserte réellement ce critère"),
      tests: z.array(z.string()),
      reason: z.string().describe("Pourquoi c'est prouvé ou non, en une ligne"),
    }),
  ),
});
export type VerifyCriteriaOutput = z.infer<typeof VerifyCriteriaOutput>;

export const MrWriteupOutput = z.object({
  title: z.string().describe("Titre de MR concis, sans préfixe Draft"),
  summary: z.string().describe("Résumé du changement pour le relecteur, 3-6 lignes"),
  changeKinds: z
    .array(z.enum(["ui", "data", "endpoint"]))
    .describe(
      "Natures du changement visibles d'un relecteur : ui = rendu d'un écran modifié ; data = format ou contenu de données stockées ou échangées (schéma, migration, fichier, événement) ; endpoint = contrat d'une API (route, paramètres, réponse, codes). Vide si aucune.",
    ),
  uiScreens: z
    .array(
      z.object({
        label: z.string().describe("Nom court de l'écran ou de l'état, ex. « Panier avec remise »"),
        howToReach: z.string().describe("Route, URL relative ou parcours pour l'afficher, données nécessaires comprises"),
      }),
    )
    .describe("Si changeKinds contient ui : écrans à capturer avant/après, 1 à 4, les plus parlants. Sinon vide."),
  dataChanges: z
    .array(
      z.object({
        subject: z.string().describe("Ce qui change, ex. « GET /api/cart », « table orders », « événement order.created »"),
        kind: z.enum(["endpoint", "data"]),
        change: z.enum(["added", "modified", "removed"]),
        before: z.string().describe("Exemple représentatif AVANT (payload, schéma, ligne), vide si added"),
        after: z.string().describe("Le même exemple APRÈS, vide si removed. Même forme et même ordre que before, pour un diff lisible"),
        note: z.string().describe("Une ligne : compatibilité, valeur par défaut, migration… Vide si rien à dire"),
      }),
    )
    .describe("Si changeKinds contient data ou endpoint : une entrée par contrat modifié. Sinon vide."),
});
export type MrWriteupOutput = z.infer<typeof MrWriteupOutput>;

export const UiCapturesOutput = z.object({
  captures: z.array(
    z.object({
      label: z.string().describe("Nom de l'écran, repris de la liste demandée"),
      before: z
        .string()
        .describe("Capture AVANT : chemin relatif au worktree, dans le dossier de captures. Vide si l'écran n'existait pas"),
      after: z.string().describe("Capture APRÈS : chemin relatif au worktree, dans le dossier de captures"),
      note: z.string().describe("Une ligne pour le relecteur (ce qui a changé à l'écran, donnée de démo utilisée). Peut être vide"),
    }),
  ),
  skippedReason: z
    .string()
    .describe("Si des écrans n'ont pas pu être capturés : pourquoi, en une ligne (app impossible à lancer, authentification…). Vide sinon"),
});
export type UiCapturesOutput = z.infer<typeof UiCapturesOutput>;

export const RetroOutput = z.object({
  lessons: z.array(z.string()).describe("Ce qui a coûté des itérations et ce qu'il aurait fallu savoir"),
  patch: z
    .string()
    .describe("Diff unifié (git apply) sur le dossier skills/, chemins relatifs à la racine du dépôt SprintSaver. Vide si rien à proposer."),
});
export type RetroOutput = z.infer<typeof RetroOutput>;
