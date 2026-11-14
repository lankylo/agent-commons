import { CredentialService } from "./identity/credentials";
import type { AgentId, OperatorId } from "./identity/types";
import { ContributionSearch } from "./registry/search";
import { budgetDiscoveryResponse } from "./registry/discovery-budget";
import { ContributionRetriever } from "./registry/retrieval";
import type { ConditionalRetrievalResponse } from "./registry/retrieval-conditional";
import type { RetrievalResponse } from "./registry/retrieval-response";
import { RateLimitService, DEFAULT_RATE_LIMITS } from "./rate-limit";

interface WorkerEnv {
  readonly DB?: D1Database;
  readonly CONTENT_BUCKET?: R2Bucket;
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

type AuthenticatedActor = { readonly agentId: AgentId; readonly operatorId: OperatorId };
type AuthorizationResult =
  | { readonly ok: true; readonly actor: AuthenticatedActor }
  | { readonly ok: false; readonly response: Response };

async function authenticateAndRateLimit(
  request: Request,
  env: WorkerEnv,
  operation: "Search" | "Retrieval",
): Promise<AuthorizationResult> {
  if (!env.DB) {
    return {
      ok: false,
      response: httpError(500, "internal_error", `${operation} is unavailable.`),
    };
  }

  const token = toBearerToken(request);
  if (!token) {
    return { ok: false, response: httpError(401, "unauthorized", "Authentication required.") };
  }

  const now = env.NOW ?? (() => new Date());
  const verification = await new CredentialService(env.DB, { now }).verifyCredential(token);
  if (!verification.ok) {
    return { ok: false, response: httpError(401, "unauthorized", "Authentication required.") };
  }

  const limiter = new RateLimitService(env.DB, {
    agentLimit: coercePositiveInteger(env.RATE_LIMIT_AGENT_LIMIT, DEFAULT_RATE_LIMITS.agentLimit),
    operatorLimit: coercePositiveInteger(
      env.RATE_LIMIT_OPERATOR_LIMIT,
      DEFAULT_RATE_LIMITS.operatorLimit,
    ),
    windowSeconds: coercePositiveInteger(
      env.RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_RATE_LIMITS.windowSeconds,
    ),
    now,
  });
  const decision = await limiter.check(verification.agentId, verification.operatorId);
  if (decision.unavailable) {
    return {
      ok: false,
      response: httpError(
        503,
        "rate_limiter_unavailable",
        "The shared rate limiter is unavailable.",
      ),
    };
  }
  if (!decision.allowed) {
    const headers = new Headers();
    if (decision.retryAfterMs !== undefined) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    }
    return {
      ok: false,
      response: httpError(
        429,
        "rate_limited",
        "The request exceeds the configured rate limit.",
        {
          scope: decision.scope,
          retryAfterMs: decision.retryAfterMs,
        },
        headers,
      ),
    };
  }

  return {
    ok: true,
    actor: { agentId: verification.agentId, operatorId: verification.operatorId },
  };
}

async function handleSearch(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authorization = await authenticateAndRateLimit(request, env, "Search");
    if (!authorization.ok) return authorization.response;
    if (!env.DB) return httpError(500, "internal_error", "Search is unavailable.");

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

type PublicRetrievalResponse =
  | Omit<Extract<RetrievalResponse, { family: "knowledge" }>, "author" | "contributor">
  | Omit<Extract<RetrievalResponse, { family: "execution" }>, "author" | "contributor">
  | Extract<ConditionalRetrievalResponse, { schemaVersion: "retrieval-not-modified/v1" }>;

function toPublicRetrievalResponse(
  response: ConditionalRetrievalResponse,
): PublicRetrievalResponse {
  if (response.schemaVersion === "retrieval-not-modified/v1") {
    return {
      schemaVersion: response.schemaVersion,
      contributionId: response.contributionId,
      version: response.version,
      contentHash: response.contentHash,
    };
  }

  const base = {
    schemaVersion: response.schemaVersion,
    contributionId: response.contributionId,
    version: response.version,
    previousVersion: response.previousVersion,
    contentHash: response.contentHash,
    payloadBytes: response.payloadBytes,
    contributionCreatedAt: response.contributionCreatedAt,
    createdAt: response.createdAt,
    platformState: {
      lastVerifiedAt: response.platformState.lastVerifiedAt,
      reliabilityScore: response.platformState.reliabilityScore,
      consumerCount: response.platformState.consumerCount,
      updatedAt: response.platformState.updatedAt,
    },
    related: response.related.map((reference) => ({
      family: reference.family,
      id: reference.id,
      version: reference.version,
    })),
  };

  if (response.family === "knowledge") {
    return {
      ...base,
      family: "knowledge",
      content: response.content,
      untrustedExplanation: response.untrustedExplanation,
    };
  }
  return {
    ...base,
    family: "execution",
    content: response.content,
  };
}

function getRequestFieldsAreValid(record: Record<string, unknown>): boolean {
  const allowedFields = new Set(["contributionId", "version", "validator", "maxUtf8Bytes"]);
  return Object.keys(record).every((field) => allowedFields.has(field));
}

async function handleGet(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authorization = await authenticateAndRateLimit(request, env, "Retrieval");
    if (!authorization.ok) return authorization.response;
    if (!env.DB || !env.CONTENT_BUCKET) {
      return httpError(500, "content_unavailable", "Contribution content is unavailable.");
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return httpError(400, "invalid_request", "Get request body must be an object.");
    }
    const record = body as Record<string, unknown>;
    if (record.agentId !== undefined || record.operatorId !== undefined) {
      return httpError(400, "invalid_request", "Identity fields are resolved from the credential.");
    }
    if (!getRequestFieldsAreValid(record)) {
      return httpError(400, "invalid_request", "Get request contains unsupported fields.");
    }
    if (
      typeof record.contributionId !== "string" ||
      record.contributionId.length === 0 ||
      !requirePositiveSafeInteger(record.version)
    ) {
      return httpError(
        400,
        "invalid_request",
        "contributionId and a positive safe-integer version are required.",
      );
    }
    if (!requirePositiveSafeInteger(record.maxUtf8Bytes)) {
      return httpError(
        400,
        "invalid_budget",
        "maxUtf8Bytes is required and must be a positive safe integer.",
      );
    }

    let validator: { contributionId: string; version: number; contentHash: string } | undefined;
    if (record.validator !== undefined) {
      const candidate = record.validator;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return httpError(
          400,
          "invalid_request",
          "validator must contain an exact version identity.",
        );
      }
      const value = candidate as Record<string, unknown>;
      if (
        Object.keys(value).length !== 3 ||
        !Object.hasOwn(value, "contributionId") ||
        !Object.hasOwn(value, "version") ||
        !Object.hasOwn(value, "contentHash") ||
        typeof value.contributionId !== "string" ||
        value.contributionId.length === 0 ||
        !requirePositiveSafeInteger(value.version) ||
        typeof value.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.contentHash)
      ) {
        return httpError(
          400,
          "invalid_request",
          "validator must contain an exact version identity.",
        );
      }
      validator = {
        contributionId: value.contributionId,
        version: value.version,
        contentHash: value.contentHash,
      };
    }

    const result = await new ContributionRetriever({
      DB: env.DB,
      CONTENT_BUCKET: env.CONTENT_BUCKET,
    }).getConditionalContributionVersion(record.contributionId, record.version, validator);
    if (!result.ok) {
      switch (result.error.code) {
        case "invalid_request":
          return httpError(400, "invalid_request", "The retrieval request is invalid.");
        case "contribution_not_found":
        case "version_not_found":
          return httpError(404, "not_found", "The requested contribution version was not found.");
        case "content_missing":
        case "content_corrupted":
        case "metadata_inconsistent":
          return httpError(500, "content_unavailable", "Contribution content is unavailable.");
      }
    }

    const data = toPublicRetrievalResponse(result.response);
    const usedUtf8Bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (usedUtf8Bytes > record.maxUtf8Bytes) {
      return httpError(
        413,
        "response_too_large",
        "The complete retrieval response exceeds the UTF-8 byte budget.",
        {
          requiredUtf8Bytes: usedUtf8Bytes,
          maxUtf8Bytes: record.maxUtf8Bytes,
        },
      );
    }

    return Response.json({
      data,
      budget: {
        maxUtf8Bytes: record.maxUtf8Bytes,
        usedUtf8Bytes,
      },
    });
  } catch {
    return httpError(500, "internal_error", "Retrieval is unavailable.");
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
    if (pathname === "/v1/commons/get" && request.method === "POST") {
      return handleGet(request, workerEnv);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
