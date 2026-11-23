/**
 * Faux `fetch` pour tester le client GitLab sans réseau.
 * Les routes sont testées dans l'ordre ; `path` est comparé au chemin sans le préfixe `/api/v4`.
 */
import type { FetchFn } from "../../src/gitlab/rest.js";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** Corps multipart (téléversement), s'il y en a un. */
  form?: FormData;
  headers: Record<string, string>;
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export interface FakeRoute {
  method?: string;
  path: string | RegExp;
  respond: FakeResponse | ((req: FakeRequest) => FakeResponse);
}

export interface FakeFetch {
  fetch: FetchFn;
  calls: FakeRequest[];
  routes: FakeRoute[];
}

export function fakeFetch(routes: FakeRoute[] = []): FakeFetch {
  const calls: FakeRequest[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const rawBody = init?.body;
    const req: FakeRequest = {
      method,
      path,
      query: url.searchParams,
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
      form: rawBody instanceof FormData ? rawBody : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(req);
    const route = routes.find(
      (r) =>
        (r.method ?? "GET") === method &&
        (typeof r.path === "string" ? decodeURIComponent(r.path) === decodeURIComponent(path) : r.path.test(path)),
    );
    if (!route) return new Response(`no route for ${method} ${path}`, { status: 404 });
    const res = typeof route.respond === "function" ? route.respond(req) : route.respond;
    const status = res.status ?? 200;
    const headers = new Headers(res.headers);
    let body: ConstructorParameters<typeof Response>[0];
    if (res.bytes) body = res.bytes;
    else if (res.text !== undefined) body = res.text;
    else if (res.json !== undefined) {
      body = JSON.stringify(res.json);
      headers.set("content-type", "application/json");
    } else body = null;
    return new Response(status === 204 ? null : body, { status, headers });
  };
  return { fetch: fetchFn, calls, routes };
}
