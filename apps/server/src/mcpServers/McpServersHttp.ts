import { MCP_SERVER_OAUTH_CALLBACK_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpServers from "./McpServers.ts";

// Streamable HTTP needs only these; anything else could carry the client's own credentials.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

// The client decodes the body, so its encoding and length no longer apply.
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
  "www-authenticate",
]);

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const page = (title: string, detail: string, status: number) =>
  HttpServerResponse.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light dark" /><title>${escapeHtml(title)}</title></head><body style="font-family: ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0;"><main style="max-width: 32rem; padding: 1.5rem;"><h1 style="font-size: 1.25rem;">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`,
  ).pipe(HttpServerResponse.setStatus(status));

const callback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return page("Sign-in failed", "The request could not be read.", 400);
  const params = url.value.searchParams;
  const mcpServers = yield* McpServers.McpServers;
  return yield* mcpServers
    .completeSignIn({
      state: params.get("state") ?? "",
      code: params.get("code"),
      error: params.get("error"),
      errorDescription: params.get("error_description"),
    })
    .pipe(
      Effect.match({
        onSuccess: ({ name }) =>
          page(`Signed in to ${name}`, "You can close this tab and return to the app.", 200),
        onFailure: (error) => page("Sign-in failed", error.message, 400),
      }),
    );
});

const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "invalid_token", message: "A valid T3 Code MCP credential is required." },
  { status: 401, headers: { "cache-control": "no-store" } },
);

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const name = decodeURIComponent(
    url.value.pathname.slice(McpServers.MCP_SERVER_PROXY_PATH.length + 1),
  );
  const authorization = request.headers.authorization ?? "";
  const scope = authorization.startsWith("Bearer ")
    ? yield* (yield* McpSessionRegistry.McpSessionRegistry).resolve(
        authorization.slice("Bearer ".length).trim(),
      )
    : undefined;
  if (scope === undefined) return unauthorized;
  const mcpServers = yield* McpServers.McpServers;
  const target = yield* mcpServers.proxyTarget(name, scope.thread.providerInstanceId);
  if (Option.isNone(target)) return HttpServerResponse.text("Not Found", { status: 404 });
  const server = target.value;

  const method = request.method;
  // Buffered so a request refused for an expired token can be sent again.
  const body =
    method === "GET" || method === "HEAD" || method === "DELETE"
      ? undefined
      : new Uint8Array(yield* request.arrayBuffer);
  const headers: Record<string, string> = {};
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[header];
    if (value !== undefined) headers[header] = value;
  }
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const send = (accessToken: string) =>
    httpClient.execute(
      HttpClientRequest.make(method)(server.url).pipe(
        HttpClientRequest.setHeaders({
          ...headers,
          ...server.headers,
          authorization: `Bearer ${accessToken}`,
        }),
        body === undefined
          ? (self) => self
          : HttpClientRequest.bodyUint8Array(body, request.headers["content-type"]),
      ),
    );

  const token = yield* mcpServers.accessToken(name);
  if (Option.isNone(token)) return unauthorized;
  let response = yield* send(token.value);
  if (response.status === 401) {
    const renewed = yield* mcpServers.accessToken(name, token.value);
    if (Option.isNone(renewed)) return unauthorized;
    response = yield* send(renewed.value);
  }
  const responseHeaders: Record<string, string> = {};
  for (const [header, value] of Object.entries(response.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(header) && value !== undefined) {
      responseHeaders[header] = value;
    }
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
    ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
  });
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning("MCP server proxy request failed", { error: error.message }).pipe(
      Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
    ),
  ),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("GET", MCP_SERVER_OAUTH_CALLBACK_PATH, callback),
  HttpRouter.add("*", `${McpServers.MCP_SERVER_PROXY_PATH}/:name`, proxy),
);
