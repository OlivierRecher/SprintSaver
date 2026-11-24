/**
 * Requêtes GraphQL GitLab (statut natif des work items).
 *
 * Noms vérifiés le 2026-11-23 dans https://docs.gitlab.com/api/graphql/reference/ (champs encore "experiment") :
 * - `Project.workItems(iids: [String!])` → `WorkItemConnection { nodes { id } }`
 * - `Project.workItemTypes` → `WorkItemType.widgetDefinitions: [WorkItemWidgetDefinition!]`
 * - `WorkItemWidgetDefinitionStatus.allowedStatuses: [WorkItemStatus!]` (`WorkItemStatus { id: GlobalID, name }`)
 * - `workItemUpdate(input: WorkItemUpdateInput)` avec `statusWidget: WorkItemWidgetStatusInput { status: WorkItemsStatusesStatusID }`
 *   → payload `{ errors: [String!]! workItem }`
 */
import { log } from "../log.js";
import type { GitLabRest } from "./rest.js";

export const WORK_ITEM_ID_QUERY = `
query SprintSaverWorkItemId($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    workItems(iids: [$iid]) {
      nodes { id }
    }
  }
}`;

export const SET_STATUS_MUTATION = `
mutation SprintSaverSetStatus($id: WorkItemID!, $status: WorkItemsStatusesStatusID!) {
  workItemUpdate(input: { id: $id, statusWidget: { status: $status } }) {
    errors
    workItem { id }
  }
}`;

export const ALLOWED_STATUSES_QUERY = `
query SprintSaverAllowedStatuses($fullPath: ID!) {
  project(fullPath: $fullPath) {
    workItemTypes {
      nodes {
        name
        widgetDefinitions {
          ... on WorkItemWidgetDefinitionStatus {
            allowedStatuses { id name }
          }
        }
      }
    }
  }
}`;

/**
 * Jobs en attente d'un pipeline et leur drapeau `stuck` : GitLab le lève quand aucun runner en ligne ne peut
 * prendre le job (aucun runner, runners en pause ou tags sans correspondance). Vérifié le 2026-11-24 sur
 * GitLab 19.6 : `Pipeline.jobs(statuses: [CiJobStatus!])`, `CiJob.stuck: Boolean`.
 */
export const PIPELINE_PENDING_JOBS_QUERY = `
query SprintSaverPendingJobs($fullPath: ID!, $id: CiPipelineID!) {
  project(fullPath: $fullPath) {
    pipeline(id: $id) {
      jobs(statuses: [PENDING]) {
        nodes { stuck }
      }
    }
  }
}`;

interface PendingJobsData {
  project: { pipeline: { jobs: { nodes: { stuck: boolean | null }[] } | null } | null } | null;
}

/**
 * Le pipeline attend faute de runner : il a des jobs en attente et tous sont `stuck`. En cas d'erreur, false
 * (on continue d'attendre, comme avant).
 */
export async function pipelineWaitsForRunner(rest: GitLabRest, projectFullPath: string, pipelineId: number): Promise<boolean> {
  try {
    const data = await rest.graphql<PendingJobsData>(PIPELINE_PENDING_JOBS_QUERY, {
      fullPath: projectFullPath,
      id: `gid://gitlab/Ci::Pipeline/${pipelineId}`,
    });
    const pending = data.project?.pipeline?.jobs?.nodes ?? [];
    return pending.length > 0 && pending.every((j) => j.stuck === true);
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err), project: projectFullPath, pipelineId },
      "Jobs en attente du pipeline illisibles",
    );
    return false;
  }
}

export interface NativeStatus {
  id: string;
  name: string;
}

interface WorkItemIdData {
  project: { workItems: { nodes: { id: string }[] } | null } | null;
}

interface SetStatusData {
  workItemUpdate: { errors: string[]; workItem: { id: string } | null } | null;
}

interface AllowedStatusesData {
  project: {
    workItemTypes: {
      nodes: {
        name: string;
        widgetDefinitions: ({ allowedStatuses?: NativeStatus[] | null } | null)[] | null;
      }[];
    } | null;
  } | null;
}

export async function getWorkItemGid(rest: GitLabRest, projectFullPath: string, iid: number): Promise<string> {
  const data = await rest.graphql<WorkItemIdData>(WORK_ITEM_ID_QUERY, { fullPath: projectFullPath, iid: String(iid) });
  const id = data.project?.workItems?.nodes[0]?.id;
  if (!id) throw new Error(`Work item introuvable en GraphQL : ${projectFullPath}#${iid}`);
  return id;
}

export async function setWorkItemStatus(
  rest: GitLabRest,
  projectFullPath: string,
  iid: number,
  statusId: string,
): Promise<void> {
  const id = await getWorkItemGid(rest, projectFullPath, iid);
  const data = await rest.graphql<SetStatusData>(SET_STATUS_MUTATION, { id, status: statusId });
  const errors = data.workItemUpdate?.errors ?? ["réponse workItemUpdate vide"];
  if (errors.length > 0) {
    throw new Error(`Échec du changement de statut de ${projectFullPath}#${iid} (${statusId}) : ${errors.join(" ; ")}`);
  }
}

/**
 * Statuts natifs disponibles pour le projet. Privilégie ceux du type "Issue",
 * sinon l'union de tous les types. Retourne [] si indisponible (pas Premium, champ absent, erreur…).
 */
export async function listAllowedStatuses(rest: GitLabRest, projectFullPath: string): Promise<NativeStatus[]> {
  try {
    const data = await rest.graphql<AllowedStatusesData>(ALLOWED_STATUSES_QUERY, { fullPath: projectFullPath });
    const types = data.project?.workItemTypes?.nodes ?? [];
    const statusesOf = (t: (typeof types)[number]) =>
      (t.widgetDefinitions ?? []).flatMap((w) => w?.allowedStatuses ?? []);
    const issueType = types.find((t) => t.name.toLowerCase() === "issue");
    const list = issueType && statusesOf(issueType).length > 0 ? statusesOf(issueType) : types.flatMap(statusesOf);
    const seen = new Set<string>();
    return list.filter((s) => s.id && !seen.has(s.id) && seen.add(s.id));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), project: projectFullPath }, "Statuts natifs indisponibles");
    return [];
  }
}
