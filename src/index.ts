import { CredentialService } from "./identity/credentials";
import { ContributionSearch } from "./registry/search";
import { budgetDiscoveryResponse } from "./registry/discovery-budget";
import { RateLimitService, DEFAULT_RATE_LIMITS } from "./rate-limit";

interface WorkerEnv {
  readonly DB?: D1Database;
  readonly NOW?: () => Date;
  readonly RATE_LIMIT_AGENT_LIMIT?: number | string;
  readonly RATE_LIMIT_OPERATOR_LIMIT?: number | string;
  readonly RATE_LIMIT_WINDOW_SECONDS?: number | string;
}

function httpError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers?: Headers,
) {
  const body: Record<string, unknown> = {
    error: {
      code,
      message,
    },
  };
  if (details !== undefined) (body.error as Record<string, unknown>).details = details;
  return Response.json(body, { status, headers });
}

function coercePositiveInteger(value: number | string | undefined, fallback: number): number {
  const candidate = typeof value === "string" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
    return fallback;
  }
  return candidate;
}

function requirePositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    const text = await request.text();
    if (!text.trim()) {
      return {
        ok: false,
        response: httpError(400, "invalid_request", "Request body is required."),
      };
    }
    const value = JSON.parse(text) as unknown;
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      response: httpError(400, "invalid_request", "Request body must be valid JSON."),
    };
  }
}

function toBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function handleSearch(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    if (!env.DB) {
      return httpError(500, "internal_error", "Search is unavailable.");
    }

    const token = toBearerToken(request);
    if (!token) {
      return httpError(401, "unauthorized", "Authentication required.");
    }

    const now = env.NOW ?? (() => new Date());
    const verification = await new CredentialService(env.DB, { now }).verifyCredential(token);
    if (!verification.ok) {
      return httpError(401, "unauthorized", "Authentication required.");
    }

    const config = {
      agentLimit: coercePositiveInteger(env.RATE_LIMIT_AGENT_LIMIT, DEFAULT_RATE_LIMITS.agentLimit),
      operatorLimit: coercePositiveInteger(
        env.RATE_LIMIT_OPERATOR_LIMIT,
        DEFAULT_RATE_LIMITS.operatorLimit,
      ),
      windowSeconds: coercePositiveInteger(
        env.RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_RATE_LIMITS.windowSeconds,
      ),
    };
    const limiter = new RateLimitService(env.DB, { ...config, now });
    const decision = await limiter.check(verification.agentId, verification.operatorId);
    if (decision.unavailable) {
      return httpError(503, "rate_limiter_unavailable", "The shared rate limiter is unavailable.");
    }
    if (!decision.allowed) {
      const headers = new Headers();
      if (decision.retryAfterMs !== undefined) {
        headers.set("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      }
      return httpError(
        429,
        "rate_limited",
        "The request exceeds the configured rate limit.",
        {
          scope: decision.scope,
          retryAfterMs: decision.retryAfterMs,
        },
        headers,
      );
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return httpError(400, "invalid_request", "Search request body must be an object.");
    }
    const record = body as Record<string, unknown>;
    if (record.agentId !== undefined || record.operatorId !== undefined) {
      return httpError(
        400,
        "invalid_request",
        "Agent and operator identities are resolved from the credential; they are not accepted in the request body.",
        {
          fields: ["agentId", "operatorId"],
        },
      );
    }

    const { maxUtf8Bytes, ...searchInput } = record;
    if (!requirePositiveSafeInteger(maxUtf8Bytes)) {
      return httpError(
        400,
        "invalid_budget",
        "maxUtf8Bytes is required and must be a positive safe integer.",
      );
    }

    const search = new ContributionSearch({ DB: env.DB });
    const result = await search.search(searchInput);
    if (!result.ok) {
      return httpError(400, "invalid_search_request", "The search request is invalid.", {
        issues: result.error.issues,
      });
    }

    const budgeted = budgetDiscoveryResponse(result.results, maxUtf8Bytes);
    if (!budgeted.ok) {
      const status = budgeted.error.code === "budget_too_small" ? 413 : 400;
      return httpError(status, budgeted.error.code, budgeted.error.message);
    }

    return Response.json(
      {
        data: budgeted.response,
        budget: {
          maxUtf8Bytes: budgeted.budget.maxUtf8Bytes,
          usedUtf8Bytes: budgeted.budget.usedUtf8Bytes,
          omittedResultCount: budgeted.budget.omittedResultCount,
        },
      },
      { status: 200 },
    );
  } catch {
    return httpError(500, "internal_error", "Search is unavailable.");
  }
}

export default {
  async fetch(request: Request, env?: unknown): Promise<Response> {
    const workerEnv = (env ?? {}) as WorkerEnv;
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ status: "ok", service: "agent-commons" });
    }
    if (pathname === "/v1/commons/search" && request.method === "POST") {
      return handleSearch(request, workerEnv);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
