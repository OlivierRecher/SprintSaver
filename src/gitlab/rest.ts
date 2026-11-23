/**
 * Petit client HTTP GitLab typé (REST v4 + GraphQL), basé sur `fetch`.
 * - Auth : jeton de la connexion glab en `Authorization: Bearer` (relu une fois sur un 401), ou `PRIVATE-TOKEN` pour un jeton fixe (tests). Le jeton n'apparaît jamais dans les messages d'erreur ni les logs.
 * - Retry simple sur 429 / 5xx / erreur réseau (2 nouvelles tentatives, backoff linéaire).
 *   Les requêtes non idempotentes (POST/PUT/DELETE) ne sont rejouées que sur 429 ou sur une erreur réseau
 *   garantissant que la requête n'est jamais partie (ECONNREFUSED, ENOTFOUND, EAI_AGAIN), pour ne pas
 *   doubler un commentaire ou une MR. Toute autre erreur réseau (reset, timeout…) est propagée.
 * - `fetch` et `sleep` injectables pour les tests.
 */
import { staticToken, type TokenProvider } from "./glab-auth.js";
import { log } from "../log.js";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export interface HttpDeps {
  fetch?: FetchFn;
  sleep?: SleepFn;
  /** Horloge (ms), injectable pour les tests d'attente de pipeline. */
  now?: () => number;
  /** Délai de base entre deux tentatives (ms). Défaut 1000. */
  retryDelayMs?: number;
}

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];
export type Query = Record<string, QueryValue>;

export class GitLabHttpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitLabHttpError";
  }
}

export class GitLabGraphQLError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(message);
    this.name = "GitLabGraphQLError";
  }
}

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRIES = 2;

/** Erreurs réseau survenant avant l'envoi de la requête (connexion refusée, DNS) : rejouer est sans risque. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Code système d'une erreur réseau (`fetch` de Node l'expose dans `cause`, parfois imbriqué). */
export function networkErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && typeof cur === "object" && cur !== null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const sub = networkErrorCode(errors[0]);
      if (sub) return sub;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const k = key.endsWith("[]") ? key : `${key}[]`;
      for (const v of value) params.append(k, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Corps multipart (téléversement). Exclusif de `body` ; le Content-Type (boundary) est posé par fetch. */
  form?: FormData;
}

export class GitLabRest {
  readonly baseUrl: string;
  readonly apiUrl: string;
  readonly fetchFn: FetchFn;
  readonly sleep: SleepFn;
  readonly now: () => number;
  private readonly retryDelayMs: number;

  /** Source du jeton. Un fournisseur (glab) envoie `Authorization: Bearer` ; une chaîne (tests) `PRIVATE-TOKEN`. */
  private readonly auth: TokenProvider;
  private readonly bearer: boolean;

  constructor(url: string, token: string | TokenProvider, deps: HttpDeps = {}) {
    this.auth = typeof token === "string" ? staticToken(token) : token;
    this.bearer = typeof token !== "string";
    this.baseUrl = url.replace(/\/+$/, "");
    this.apiUrl = `${this.baseUrl}/api/v4`;
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
    this.retryDelayMs = deps.retryDelayMs ?? 1000;
  }

  /** Requête brute avec retry ; lève GitLabHttpError si statut non 2xx. */
  async raw(method: string, path: string, opts: RequestOptions = {}, absoluteUrl?: string): Promise<Response> {
    const url = absoluteUrl ?? `${this.apiUrl}${path}${buildQuery(opts.query)}`;
    const displayPath = absoluteUrl ? new URL(absoluteUrl).pathname : path;
    let token = await this.auth.get();
    let refreshed = false;
    let body: string | FormData | undefined;
    if (opts.form !== undefined) body = opts.form;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    const idempotent = method === "GET" || method === "HEAD";

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = this.bearer
        ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
        : { "PRIVATE-TOKEN": token, Accept: "application/json" };
      if (typeof body === "string") headers["Content-Type"] = "application/json";
      let res: Response;
      try {
        res = await this.fetchFn(url, { method, headers, body });
      } catch (err) {
        const code = networkErrorCode(err);
        const safeToReplay = idempotent || (code !== undefined && NOT_SENT_CODES.has(code));
        if (safeToReplay && attempt < MAX_RETRIES) {
          log.warn({ method, path: displayPath, attempt }, "GitLab : erreur réseau, nouvelle tentative");
          await this.sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        const reason = `${err instanceof Error ? err.message : String(err)}${code ? ` [${code}]` : ""}`;
        throw new GitLabHttpError(`GitLab ${method} ${displayPath} : erreur réseau (${reason})`, method, displayPath, 0);
      }
      if (res.ok) return res;

      // Jeton expiré (OAuth glab) ou reconnexion glab entre-temps : on relit la source une fois.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        const fresh = await this.auth.refresh().catch(() => token);
        if (fresh !== token) {
          token = fresh;
          await res.body?.cancel().catch(() => undefined);
          attempt--; // ne compte pas comme une tentative de retry réseau
          continue;
        }
      }

      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.retryDelayMs * (attempt + 1);
        log.warn({ method, path: displayPath, status: res.status, attempt }, "GitLab : réponse transitoire, nouvelle tentative");
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(delay);
        continue;
      }
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300).replaceAll(token, "***");
      } catch {
        // ignore
      }
      throw new GitLabHttpError(
        `GitLab ${method} ${displayPath} → HTTP ${res.status}${detail ? ` : ${detail}` : ""}`,
        method,
        displayPath,
        res.status,
      );
    }
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitLabHttpError(`GitLab ${method} ${path} : réponse JSON invalide`, method, path, res.status);
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  async text(path: string, query?: Query): Promise<string> {
    const res = await this.raw("GET", path, { query });
    return res.text();
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await this.raw("GET", path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Pagination offset (per_page=100) en suivant `x-next-page`. */
  async paginate<T>(path: string, query: Query = {}, maxPages = 50): Promise<T[]> {
    const all: T[] = [];
    let page: number | undefined = 1;
    for (let i = 0; page !== undefined && i < maxPages; i++) {
      const res = await this.raw("GET", path, { query: { per_page: 100, ...query, page } });
      const items = (await res.json()) as T[];
      all.push(...items);
      const next = res.headers.get("x-next-page");
      page = next ? Number(next) : undefined;
      if (page !== undefined && !Number.isFinite(page)) page = undefined;
    }
    return all;
  }

  /** Requête GraphQL ; lève GitLabGraphQLError si `errors` au niveau racine. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.raw("POST", "/api/graphql", { body: { query, variables } }, `${this.baseUrl}/api/graphql`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      const msgs = json.errors.map((e) => e.message);
      throw new GitLabGraphQLError(`GitLab GraphQL : ${msgs.join(" ; ")}`, msgs);
    }
    if (json.data === undefined || json.data === null) {
      throw new GitLabGraphQLError("GitLab GraphQL : réponse sans data", []);
    }
    return json.data;
  }
}

export function createGitLabRest(url: string, token: string | TokenProvider, deps?: HttpDeps): GitLabRest {
  return new GitLabRest(url, token, deps);
}

/** Encode un id de projet (numérique ou path) pour une URL REST. */
export function pid(projectId: number | string): string {
  return encodeURIComponent(String(projectId));
}
