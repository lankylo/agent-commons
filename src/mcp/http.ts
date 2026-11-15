import {
  createMcpHandler,
  originValidationResponse,
  validateHostHeader,
} from "@modelcontextprotocol/server";
import { createCommonsMcpServer, type WorkerDispatch } from "./server";

/** The single remote Streamable HTTP MCP endpoint. */
export const MCP_PATH = "/mcp";

/**
 * Transport-level bound on one MCP POST body. It limits protocol traffic only; contribution and
 * feedback content rules are still enforced by the shared Worker handlers.
 */
export const MCP_MAX_REQUEST_BYTES = 1024 * 1024;

const MAX_ALLOWED_HOSTNAMES = 8;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface McpHttpEnv {
  readonly MCP_HTTP?: string;
  readonly MCP_ALLOWED_HOSTNAMES?: string;
}

export type McpHttpConfig =
  | { readonly state: "off" }
  | { readonly state: "invalid" }
  | { readonly state: "on"; readonly allowedHostnames: readonly string[] };

/** Off unless MCP_HTTP is exactly "on" with a valid explicit hostname allow-list. */
export function resolveMcpHttpConfig(env: McpHttpEnv): McpHttpConfig {
  const mode = env.MCP_HTTP;
  if (mode === undefined || mode === "" || mode === "off") return { state: "off" };
  if (mode !== "on") return { state: "invalid" };
  const raw = env.MCP_ALLOWED_HOSTNAMES;
  if (typeof raw !== "string") return { state: "invalid" };
  const hostnames = raw.split(",").map((item) => item.trim());
  if (
    hostnames.length === 0 ||
    hostnames.length > MAX_ALLOWED_HOSTNAMES ||
    hostnames.some((item) => !HOSTNAME.test(item))
  ) {
    return { state: "invalid" };
  }
  return { state: "on", allowedHostnames: hostnames };
}

/** The authenticated agent gate shared with REST: verifies the credential and charges the limiter once. */
export type McpAuthenticate = (
  request: Request,
) => Promise<
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly response: Response }
>;

export interface McpHttpDependencies {
  readonly authenticate: McpAuthenticate;
  readonly dispatch: WorkerDispatch;
  /** Builds the per-request Worker bindings for tool calls by the authenticated agent. */
  readonly toolEnv: (agentId: string) => unknown;
}

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit) {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers });
}

function restError(status: number, code: string, message: string, headers?: HeadersInit) {
  return Response.json({ error: { code, message } }, { status, headers });
}

function bearerCredential(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Reads at most `limit` bytes; returns null when the body is larger. */
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > limit) return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function hostIsAllowed(request: Request, allowed: string[]): boolean {
  // Workers always set Host; the URL hostname must agree with the same allow-list.
  const header = request.headers.get("Host");
  if (header !== null && !validateHostHeader(header, allowed).ok) return false;
  return validateHostHeader(new URL(request.url).host, allowed).ok;
}

/**
 * Serves `/mcp`. Order: configuration, Host/Origin, credential and shared rate limit, method,
 * bounded body, message shape, then a fresh SDK handler and server bound to this request only.
 */
export async function handleMcpHttp(
  request: Request,
  env: McpHttpEnv,
  deps: McpHttpDependencies,
): Promise<Response> {
  const config = resolveMcpHttpConfig(env);
  if (config.state === "off") return new Response("Not Found", { status: 404 });
  if (config.state === "invalid") {
    return restError(503, "misconfigured", "Service configuration is invalid.");
  }

  const allowed = [...config.allowedHostnames];
  if (!hostIsAllowed(request, allowed)) {
    return jsonRpcError(403, -32000, "Host is not allowed.");
  }
  // Non-browser agent clients send no Origin; any browser Origin is refused (no CORS).
  const originRejected = originValidationResponse(request, []);
  if (originRejected) return originRejected;

  const credential = bearerCredential(request);
  if (!credential) {
    return restError(401, "unauthorized", "Authentication required.", {
      "WWW-Authenticate": 'Bearer realm="agent-commons"',
    });
  }
  const auth = await deps.authenticate(request);
  if (!auth.ok) {
    if (auth.response.status === 401) {
      const headers = new Headers(auth.response.headers);
      headers.set("WWW-Authenticate", 'Bearer realm="agent-commons"');
      return new Response(auth.response.body, { status: 401, headers });
    }
    return auth.response;
  }

  if (request.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
  }

  const text = await readBoundedText(request, MCP_MAX_REQUEST_BYTES);
  if (text === null) return jsonRpcError(413, -32600, "Request body is too large.");
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return jsonRpcError(400, -32700, "Parse error.");
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return jsonRpcError(400, -32600, "Send exactly one JSON-RPC message per request.");
  }
  if ((message as { method?: unknown }).method === "subscriptions/listen") {
    return jsonRpcError(400, -32601, "Subscriptions are not supported.");
  }

  // Strip the credential before the SDK sees the request; tools receive it only through the
  // per-request server closure, and Worker bindings are a fresh object for this agent.
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  const forwarded = new Request(request.url, { method: "POST", headers, body: text });
  const toolEnv = deps.toolEnv(auth.agentId);
  const handler = createMcpHandler(
    () => createCommonsMcpServer(toolEnv, credential, deps.dispatch),
    {
      legacy: "stateless",
      maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
      keepAliveMs: 0,
    },
  );
  try {
    return await handler.fetch(forwarded);
  } catch {
    return jsonRpcError(500, -32603, "Internal error.");
  } finally {
    await handler.close().catch(() => undefined);
  }
}
