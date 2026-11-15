import { CredentialService } from "./identity/credentials";
import type { AgentId, OperatorId } from "./identity/types";
import { ContributionSearch } from "./registry/search";
import { budgetDiscoveryResponse } from "./registry/discovery-budget";
import { ContributionRetriever } from "./registry/retrieval";
import { CONSUMER_QUALITY_LABEL, QualityStateStore } from "./registry/quality-state";
import type { ConditionalRetrievalResponse } from "./registry/retrieval-conditional";
import type { RetrievalResponse } from "./registry/retrieval-response";
import { ContributionRegistry, type CreationError, type VersionError } from "./registry/creation";
import { FeedbackRegistry } from "./registry/feedback";
import { RateLimitService, DEFAULT_RATE_LIMITS } from "./rate-limit";
import {
  DEFAULT_NEEDS_OPERATOR_DAILY_LIMIT,
  NEEDS_LIMITS,
  NeedsIntake,
  validateNeedsReport,
} from "./registry/needs";
import { handleReview, REVIEW_PATH_PREFIX, type ReviewEnv } from "./review/routes";
import { ENROLL_PATH_PREFIX, handleEnrollment, type EnrollmentEnv } from "./enrollment/routes";
import { handleEnrollmentPage } from "./enrollment/page";

interface WorkerEnv extends ReviewEnv, EnrollmentEnv {
  readonly DB?: D1Database;
  readonly CONTENT_BUCKET?: R2Bucket;
  readonly EXECUTION_DOMAIN_POLICY_JSON?: string;
  readonly KNOWLEDGE_PERMISSION_POLICY_JSON?: string;
  readonly NEEDS_INTAKE?: string;
  readonly NEEDS_INTAKE_OPERATOR_DAILY_LIMIT?: number | string;
  readonly NOW?: () => Date;
  readonly PILOT_MODE?: string;
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
  operation: "Search" | "Retrieval" | "Contribution" | "Feedback" | "Needs intake" | "Preview",
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

    const search = new ContributionSearch({ DB: env.DB }, { visibility: "listed_unverified" });
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
        quality: CONSUMER_QUALITY_LABEL,
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

/**
 * Removes metadata about related versions that are not listed: references (top-level and the
 * contributed `content.related`) to non-listed versions are dropped, and `previousVersion` becomes
 * null unless that exact earlier version is listed.
 */
async function withListedReferencesOnly(
  data: PublicRetrievalResponse,
  states: QualityStateStore,
  contributionId: string,
): Promise<PublicRetrievalResponse> {
  if (data.schemaVersion === "retrieval-not-modified/v1") return data;
  const candidates = [
    ...data.related,
    ...(data.content.related ?? []),
    ...(data.previousVersion === null
      ? []
      : [{ id: contributionId, version: data.previousVersion }]),
  ];
  const listed = await states.listedKeys(candidates);
  const keep = <T extends { id: string; version: number }>(refs: readonly T[]): T[] =>
    refs.filter((r) => listed.has(`${r.id}\u0000${r.version}`));
  const previousVersion =
    data.previousVersion !== null && listed.has(`${contributionId}\u0000${data.previousVersion}`)
      ? data.previousVersion
      : null;
  const content =
    data.content.related === undefined
      ? data.content
      : { ...data.content, related: keep(data.content.related) };
  return {
    ...data,
    previousVersion,
    related: keep(data.related),
    content,
  } as PublicRetrievalResponse;
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

    // Consumer visibility gate: only an exact listed_unverified version is retrievable. Pending,
    // rejected, withdrawn, unknown and missing-state versions share one 404 before any content,
    // R2 read, validator comparison or receipt, so conditional requests cannot probe them either.
    const states = new QualityStateStore(env.DB);
    if (!(await states.isListed(record.contributionId, record.version))) {
      return httpError(404, "not_found", "The requested contribution version was not found.");
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

    const data = await withListedReferencesOnly(
      toPublicRetrievalResponse(result.response),
      states,
      record.contributionId,
    );
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

    if (data.schemaVersion === "retrieval-response/v1") {
      await env.DB.prepare(
        `INSERT INTO retrieval_receipts (agent_id, contribution_id, version)
         VALUES (?, ?, ?)
         ON CONFLICT (agent_id, contribution_id, version) DO NOTHING`,
      )
        .bind(authorization.actor.agentId, record.contributionId, record.version)
        .run();
    }

    return Response.json({
      data,
      budget: {
        maxUtf8Bytes: record.maxUtf8Bytes,
        usedUtf8Bytes,
      },
      quality: CONSUMER_QUALITY_LABEL,
    });
  } catch {
    return httpError(500, "internal_error", "Retrieval is unavailable.");
  }
}

const PREVIEW_QUALITY_LABEL = Object.freeze({
  state: "pending",
  preview: true,
  independentlyVerified: false,
  note: "Contributor preview of your own pending version; it is not listed, searchable or reviewed.",
} as const);

/**
 * Contributor preview: the authenticated agent retrieves an exact `pending` version it authored.
 * Identity comes only from the credential. Ownership and state are checked in one query before any
 * content read; every other case shares one 404. Never writes a receipt and never changes state.
 */
async function handlePreview(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authorization = await authenticateAndRateLimit(request, env, "Preview");
    if (!authorization.ok) return authorization.response;
    if (!env.DB || !env.CONTENT_BUCKET) {
      return httpError(500, "content_unavailable", "Contribution content is unavailable.");
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return httpError(400, "invalid_request", "Preview request body must be an object.");
    }
    const record = body as Record<string, unknown>;
    if (record.agentId !== undefined || record.operatorId !== undefined) {
      return httpError(400, "invalid_request", "Identity fields are resolved from the credential.");
    }
    if (
      !Object.keys(record).every((f) => ["contributionId", "version", "maxUtf8Bytes"].includes(f))
    ) {
      return httpError(400, "invalid_request", "Preview request contains unsupported fields.");
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

    const notFound = () =>
      httpError(404, "not_found", "The requested contribution version was not found.");
    const owned = await env.DB.prepare(
      `SELECT 1 AS ok
         FROM contribution_versions v
         JOIN version_quality_states q
           ON q.contribution_id = v.contribution_id AND q.version = v.version
        WHERE v.contribution_id = ? AND v.version = ?
          AND v.author_agent_id = ? AND v.author_operator_id = ?
          AND q.state = 'pending'`,
    )
      .bind(
        record.contributionId,
        record.version,
        authorization.actor.agentId,
        authorization.actor.operatorId,
      )
      .first();
    if (owned === null) return notFound();

    const result = await new ContributionRetriever({
      DB: env.DB,
      CONTENT_BUCKET: env.CONTENT_BUCKET,
    }).getConditionalContributionVersion(record.contributionId, record.version);
    if (!result.ok) {
      switch (result.error.code) {
        case "invalid_request":
          return httpError(400, "invalid_request", "The retrieval request is invalid.");
        case "contribution_not_found":
        case "version_not_found":
          return notFound();
        case "content_missing":
        case "content_corrupted":
        case "metadata_inconsistent":
          return httpError(500, "content_unavailable", "Contribution content is unavailable.");
      }
    }

    const data = await withListedReferencesOnly(
      toPublicRetrievalResponse(result.response),
      new QualityStateStore(env.DB),
      record.contributionId,
    );
    const usedUtf8Bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (usedUtf8Bytes > record.maxUtf8Bytes) {
      return httpError(
        413,
        "response_too_large",
        "The complete retrieval response exceeds the UTF-8 byte budget.",
        { requiredUtf8Bytes: usedUtf8Bytes, maxUtf8Bytes: record.maxUtf8Bytes },
      );
    }

    return Response.json({
      data,
      budget: { maxUtf8Bytes: record.maxUtf8Bytes, usedUtf8Bytes },
      quality: PREVIEW_QUALITY_LABEL,
    });
  } catch {
    return httpError(500, "internal_error", "Preview is unavailable.");
  }
}

const CONTRIBUTION_PLATFORM_FIELDS = new Set([
  "id",
  "version",
  "previousVersion",
  "contentHash",
  "hash",
  "contentKey",
  "author",
  "authorAgentId",
  "authorOperatorId",
  "contributor",
  "contributorAgentId",
  "contributorOperatorId",
  "contributorId",
  "agentId",
  "operatorId",
  "createdAt",
  "contributionCreatedAt",
  "lastVerifiedAt",
  "reliabilityScore",
  "consumerCount",
  "platformState",
  "updatedAt",
  "timestamp",
  "executionDomainPolicy",
  "knowledgePermissionPolicy",
]);

function reservedContributionFields(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((field) => CONTRIBUTION_PLATFORM_FIELDS.has(field));
}

function mapContributionError(error: CreationError | VersionError): Response {
  const details = error.errors === undefined ? undefined : { errors: error.errors };
  switch (error.code) {
    case "operator_not_allow_listed":
      return httpError(
        403,
        "contribution_not_allowed",
        "This operator is not allowed to contribute.",
      );
    case "execution_domain_policy_unavailable":
      return httpError(
        503,
        "execution_domain_policy_unavailable",
        "Execution target policy is unavailable.",
        details,
      );
    case "knowledge_permission_policy_unavailable":
      return httpError(
        503,
        "knowledge_permission_policy_unavailable",
        "Knowledge permission policy is unavailable.",
        details,
      );
    case "actor_not_found":
    case "actor_inactive":
      return httpError(401, "unauthorized", "Authentication required.");
    case "invalid_expected_version":
      return httpError(
        400,
        "invalid_expected_version",
        "expectedPreviousVersion must be a positive safe integer.",
      );
    case "contribution_not_found":
    case "operator_mismatch":
      return httpError(404, "not_found", "The requested contribution was not found.");
    case "version_conflict":
      return httpError(
        409,
        "version_conflict",
        "expectedPreviousVersion is not the latest version.",
      );
    case "duplicate_content":
      return httpError(409, "duplicate_content", "Identical contribution content already exists.");
    case "invalid_content":
      return httpError(422, "invalid_content", "Contribution content failed validation.", details);
    case "platform_field_rejected":
      return httpError(
        422,
        "platform_field_rejected",
        "Platform-managed fields cannot be submitted.",
        details,
      );
    case "unresolved_reference":
      return httpError(
        422,
        "unresolved_reference",
        "One or more exact contribution references do not resolve.",
        details,
      );
    case "family_mismatch":
      return httpError(422, "family_mismatch", "A contribution version cannot change family.");
    case "storage_failed":
    case "persistence_failed":
      return httpError(500, "internal_error", "Contribution could not be saved.");
  }
}

async function handleContribute(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authorization = await authenticateAndRateLimit(request, env, "Contribution");
    if (!authorization.ok) return authorization.response;
    if (!env.DB || !env.CONTENT_BUCKET) {
      return httpError(500, "internal_error", "Contribution is unavailable.");
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return httpError(400, "invalid_request", "Contribution request body must be an object.");
    }

    const record = body as Record<string, unknown>;
    if (reservedContributionFields(record).length > 0) {
      return httpError(
        400,
        "invalid_request",
        "Platform-managed identity and metadata fields are not accepted.",
      );
    }

    const isVersion =
      Object.hasOwn(record, "contributionId") || Object.hasOwn(record, "expectedPreviousVersion");
    const allowedFields = isVersion
      ? new Set(["contributionId", "expectedPreviousVersion", "contribution"])
      : new Set(["contribution"]);
    if (Object.keys(record).some((field) => !allowedFields.has(field))) {
      return httpError(400, "invalid_request", "Contribution request contains unsupported fields.");
    }
    if (!Object.hasOwn(record, "contribution")) {
      return httpError(400, "invalid_request", "A contribution object is required.");
    }
    if (isVersion) {
      if (
        typeof record.contributionId !== "string" ||
        record.contributionId.length === 0 ||
        !requirePositiveSafeInteger(record.expectedPreviousVersion)
      ) {
        return httpError(
          400,
          "invalid_expected_version",
          "contributionId and a positive safe-integer expectedPreviousVersion are required.",
        );
      }
    } else if (Object.hasOwn(record, "expectedPreviousVersion")) {
      return httpError(400, "invalid_request", "Version requests require both version fields.");
    }

    const contribution = record.contribution;
    if (typeof contribution !== "object" || contribution === null || Array.isArray(contribution)) {
      return httpError(400, "invalid_request", "contribution must be an object.");
    }
    const input = contribution as Record<string, unknown>;
    const reservedFields = reservedContributionFields(input);
    if (reservedFields.length > 0) {
      return httpError(
        422,
        "platform_field_rejected",
        "Platform-managed fields cannot be submitted.",
        {
          errors: reservedFields.map((field) => `${field}: platform-managed field cannot be set`),
        },
      );
    }

    const registry = new ContributionRegistry({
      DB: env.DB,
      CONTENT_BUCKET: env.CONTENT_BUCKET,
      EXECUTION_DOMAIN_POLICY_JSON: env.EXECUTION_DOMAIN_POLICY_JSON,
      KNOWLEDGE_PERMISSION_POLICY_JSON: env.KNOWLEDGE_PERMISSION_POLICY_JSON,
    });
    const result = isVersion
      ? await registry.createContributionVersion(
          authorization.actor.agentId,
          record.contributionId as string,
          record.expectedPreviousVersion as number,
          input,
        )
      : await registry.createContribution(authorization.actor.agentId, input);
    if (!result.ok) return mapContributionError(result.error);

    const created = result.contribution;
    return Response.json({
      schemaVersion: "contribution-created/v1",
      contribution: {
        contributionId: created.id,
        version: created.version,
        previousVersion: "previousVersion" in created ? created.previousVersion : null,
        family: created.family,
        contentHash: created.contentHash,
        payloadBytes: created.payloadBytes,
        createdAt: created.createdAt,
      },
    });
  } catch {
    return httpError(500, "internal_error", "Contribution could not be saved.");
  }
}

async function handleFeedback(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authorization = await authenticateAndRateLimit(request, env, "Feedback");
    if (!authorization.ok) return authorization.response;
    if (!env.DB || !env.CONTENT_BUCKET) {
      return httpError(500, "internal_error", "Feedback could not be saved.");
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
      return httpError(400, "invalid_request", "Feedback request body must be an object.");
    }
    const record = parsed.value as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (field) => !["contributionId", "version", "assessment"].includes(field),
      )
    ) {
      return httpError(400, "invalid_request", "Feedback request contains unsupported fields.");
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

    const result = await new FeedbackRegistry({
      DB: env.DB,
      CONTENT_BUCKET: env.CONTENT_BUCKET,
    }).submit(authorization.actor, record.contributionId, record.version, record.assessment);
    if (!result.ok) {
      switch (result.code) {
        case "feedback_not_eligible":
          return httpError(
            403,
            "feedback_not_eligible",
            "This agent is not eligible to submit feedback for this exact version.",
          );
        case "feedback_conflict":
          return httpError(
            409,
            "feedback_conflict",
            "A report for this dimension already exists under this operator.",
          );
        case "invalid_feedback":
          return httpError(422, "invalid_feedback", "The feedback assessment is invalid.");
        case "content_unavailable":
          return httpError(500, "content_unavailable", "Contribution content is unavailable.");
      }
    }

    return Response.json({
      schemaVersion: "feedback-response/v1",
      accepted: true,
      contributionId: record.contributionId,
      version: record.version,
    });
  } catch {
    return httpError(500, "internal_error", "Feedback could not be saved.");
  }
}

async function handleNeeds(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authorization = await authenticateAndRateLimit(request, env, "Needs intake");
    if (!authorization.ok) return authorization.response;
    if (!env.DB) return httpError(500, "internal_error", "Needs intake is unavailable.");

    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declared) && declared > NEEDS_LIMITS.maxBodyBytes) {
      return httpError(413, "request_too_large", "The needs report body is too large.", {
        maxBodyBytes: NEEDS_LIMITS.maxBodyBytes,
      });
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > NEEDS_LIMITS.maxBodyBytes) {
      return httpError(413, "request_too_large", "The needs report body is too large.", {
        maxBodyBytes: NEEDS_LIMITS.maxBodyBytes,
      });
    }
    let body: unknown;
    try {
      if (!text.trim()) return httpError(400, "invalid_request", "Request body is required.");
      body = JSON.parse(text) as unknown;
    } catch {
      return httpError(400, "invalid_request", "Request body must be valid JSON.");
    }

    const validated = validateNeedsReport(body);
    if (!validated.ok) {
      const status = validated.code === "invalid_request" ? 400 : 422;
      const message =
        validated.code === "needs_report_rejected"
          ? "The needs report contains content that is not accepted."
          : validated.code === "invalid_needs_report"
            ? "The needs report is invalid."
            : "The needs report request is invalid.";
      return httpError(status, validated.code, message, { errors: validated.errors });
    }

    const result = await new NeedsIntake(env.DB, {
      now: env.NOW,
      operatorDailyLimit: coercePositiveInteger(
        env.NEEDS_INTAKE_OPERATOR_DAILY_LIMIT,
        DEFAULT_NEEDS_OPERATOR_DAILY_LIMIT,
      ),
    }).submit(authorization.actor, validated.report);
    if (!result.ok) {
      return httpError(
        429,
        "needs_intake_limited",
        "This operator has reached the needs report limit; try again later.",
        { scope: "operator" },
      );
    }

    return Response.json(
      { schemaVersion: "needs-report-accepted/v1", accepted: true, duplicate: result.duplicate },
      { status: 202 },
    );
  } catch {
    return httpError(500, "internal_error", "Needs intake is unavailable.");
  }
}

/** Needs intake is a separately enabled pilot operation; off unless explicitly "on". */
function resolveNeedsIntake(value: unknown): boolean | undefined {
  if (value === undefined || value === "" || value === "off") return false;
  if (value === "on") return true;
  return undefined;
}

type PilotMode = "off" | "read-only";

/** Explicit allow-list: unset/empty means unrestricted (local development); anything else invalid fails closed. */
function resolvePilotMode(value: unknown): PilotMode | undefined {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "read-only") return "read-only";
  return undefined;
}

export default {
  async fetch(request: Request, env?: unknown): Promise<Response> {
    const workerEnv = (env ?? {}) as WorkerEnv;
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ status: "ok", service: "agent-commons" });
    }
    const enrollmentPage = handleEnrollmentPage(request, workerEnv);
    if (enrollmentPage) return enrollmentPage;
    // Operator-only review: separate prefix, reviewer token only, never agent credentials.
    if (pathname.startsWith(REVIEW_PATH_PREFIX)) {
      return handleReview(request, workerEnv);
    }
    // Wallet enrollment: unauthenticated by design, off by default, never accepts identity IDs.
    if (pathname.startsWith(ENROLL_PATH_PREFIX)) {
      return handleEnrollment(request, workerEnv);
    }
    if (pathname.startsWith("/v1/commons/")) {
      const mode = resolvePilotMode(workerEnv.PILOT_MODE);
      const needsIntake = resolveNeedsIntake(workerEnv.NEEDS_INTAKE);
      if (mode === undefined || needsIntake === undefined) {
        return httpError(503, "misconfigured", "Service configuration is invalid.");
      }
      if (
        mode === "read-only" &&
        request.method === "POST" &&
        (pathname === "/v1/commons/contribute" || pathname === "/v1/commons/feedback")
      ) {
        return httpError(
          403,
          "pilot_read_only",
          "This operation is disabled while the service is in read-only pilot mode.",
        );
      }
    }
    if (pathname === "/v1/commons/needs" && request.method === "POST") {
      if (resolveNeedsIntake(workerEnv.NEEDS_INTAKE) !== true) {
        return httpError(403, "needs_intake_disabled", "Needs intake is not enabled.");
      }
      return handleNeeds(request, workerEnv);
    }
    if (pathname === "/v1/commons/search" && request.method === "POST") {
      return handleSearch(request, workerEnv);
    }
    if (pathname === "/v1/commons/get" && request.method === "POST") {
      return handleGet(request, workerEnv);
    }
    if (pathname === "/v1/commons/preview" && request.method === "POST") {
      return handlePreview(request, workerEnv);
    }
    if (pathname === "/v1/commons/contribute" && request.method === "POST") {
      return handleContribute(request, workerEnv);
    }
    if (pathname === "/v1/commons/feedback" && request.method === "POST") {
      return handleFeedback(request, workerEnv);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
