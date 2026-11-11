/**
 * Internal D1 full-text search over the FTS5 index (Phase 3), with metadata filtering.
 *
 * Internal only: no HTTP, MCP or Worker route, no ranking, no discovery response, no pagination,
 * caching or Vectorize. Reads D1 only; never touches R2. No LLM calls.
 *
 * Query handling: the query is PLAIN TEXT, never FTS syntax. It is NFKC-normalized, lowercased and
 * split on every character that is not a Unicode letter, mark or number. Each token is emitted as an
 * FTS5 double-quoted string, so quotes, punctuation, column filters, prefix stars and operator
 * words (AND/OR/NOT/NEAR) are inert; all tokens are required (implicit AND). The match expression
 * and every filter value are bound as SQL parameters.
 *
 * Latest-version rule: only the latest version of each contribution is searched. If an older version
 * matches but the latest does not, the contribution is not returned. Historical versions remain
 * available only through exact-version retrieval.
 *
 * Ordering (not ranking): latest-version creation time descending, then contribution ID ascending.
 *
 * Results carry only typed metadata from `contribution_versions` and `version_platform_state`; no
 * indexed text, facts, summary, explanation, objective, steps, R2 content, identities or hashes.
 */
import type { ContributionFamily } from "./envelope";
import { EXECUTION_VERIFICATION_METHODS, SIDE_EFFECTS } from "./execution";
import { PERMITTED_USES, VERIFICATION_METHODS } from "./knowledge";

export const SEARCH_LIMITS = {
  /** Maximum query length in characters, after NFKC normalization and trimming. */
  maxQueryLength: 256,
  /** Maximum number of tokens (before de-duplication). */
  maxTokens: 12,
  /** Maximum length of one token in characters. */
  maxTokenLength: 64,
  defaultLimit: 10,
  maxLimit: 50,
  maxContentTypeLength: 200,
  maxTargetDomainLength: 253,
  maxCapabilityLength: 64,
} as const;

export const KNOWLEDGE_SEARCH_FILTERS = ["verificationMethod", "permittedUse"] as const;
export const EXECUTION_SEARCH_FILTERS = [
  "verificationMethod",
  "targetDomain",
  "requiredCapability",
  "sideEffect",
  "requiresHumanApproval",
] as const;

export interface KnowledgeSearchFilters {
  readonly verificationMethod?: (typeof VERIFICATION_METHODS)[number];
  readonly permittedUse?: (typeof PERMITTED_USES)[number];
}
export interface ExecutionSearchFilters {
  readonly verificationMethod?: (typeof EXECUTION_VERIFICATION_METHODS)[number];
  readonly targetDomain?: string;
  readonly requiredCapability?: string;
  readonly sideEffect?: (typeof SIDE_EFFECTS)[number];
  readonly requiresHumanApproval?: boolean;
}

interface SearchRequestBase {
  readonly query: string;
  readonly contentType?: string;
  readonly limit?: number;
}
export type SearchRequest =
  | (SearchRequestBase & { readonly family?: undefined; readonly filters?: undefined })
  | (SearchRequestBase & {
      readonly family: "knowledge";
      readonly filters?: KnowledgeSearchFilters;
    })
  | (SearchRequestBase & {
      readonly family: "execution";
      readonly filters?: ExecutionSearchFilters;
    });

export interface SearchResultItem {
  readonly id: string;
  readonly version: number;
  readonly family: ContributionFamily;
  readonly contentType: string;
  readonly title: string;
  readonly purpose: string;
  readonly asOf: string;
  readonly createdAt: string;
  readonly reviewIntervalDays: number;
  readonly lastVerifiedAt: string | null;
  readonly reliabilityScore: number | null;
  readonly consumerCount: number;
}

export type SearchIssueCode =
  | "invalid_request"
  | "unknown_field"
  | "invalid_value"
  | "query_empty"
  | "query_too_long"
  | "too_many_tokens"
  | "token_too_long"
  | "filter_requires_family"
  | "incompatible_filter"
  | "invalid_limit";

export interface SearchIssue {
  readonly path: string;
  readonly code: SearchIssueCode;
  readonly message: string;
}

export type SearchResult =
  | { readonly ok: true; readonly results: readonly SearchResultItem[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_search_request";
        readonly issues: readonly SearchIssue[];
      };
    };

const REQUEST_KEYS = new Set(["query", "family", "contentType", "filters", "limit"]);
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
const TOKEN_SEPARATORS = /[^\p{L}\p{M}\p{N}]+/u;

/**
 * Deterministic plain-text tokenization. Returns the distinct tokens in first-seen order, or an
 * issue when the query is empty or exceeds the documented limits.
 */
export function tokenizeQuery(
  query: string,
): { ok: true; tokens: string[] } | { ok: false; issue: SearchIssue } {
  const issue = (code: SearchIssueCode, message: string) =>
    ({ ok: false, issue: { path: "query", code, message } }) as const;
  const normalized = query.normalize("NFKC").trim();
  if (normalized.length > SEARCH_LIMITS.maxQueryLength) {
    return issue("query_too_long", `must be at most ${SEARCH_LIMITS.maxQueryLength} characters`);
  }
  const raw = normalized
    .toLowerCase()
    .split(TOKEN_SEPARATORS)
    .filter((t) => t !== "");
  if (raw.length === 0) return issue("query_empty", "must contain at least one letter or digit");
  if (raw.length > SEARCH_LIMITS.maxTokens) {
    return issue("too_many_tokens", `must contain at most ${SEARCH_LIMITS.maxTokens} tokens`);
  }
  if (raw.some((t) => t.length > SEARCH_LIMITS.maxTokenLength)) {
    return issue(
      "token_too_long",
      `tokens must be at most ${SEARCH_LIMITS.maxTokenLength} characters`,
    );
  }
  return { ok: true, tokens: [...new Set(raw)] };
}

/** FTS5 match expression: every token as a quoted string, implicitly ANDed. Tokens never contain `"`. */
export const toMatchExpression = (tokens: readonly string[]): string =>
  tokens.map((t) => `"${t}"`).join(" ");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface FilterClause {
  readonly sql: string;
  readonly value: string | number;
}

interface ValidatedRequest {
  readonly match: string;
  readonly family?: ContributionFamily;
  readonly contentType?: string;
  readonly clauses: readonly FilterClause[];
  readonly limit: number;
}

const boundedString = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max && !hasControlCharacter(v);

function validate(
  input: unknown,
): { ok: true; req: ValidatedRequest } | { ok: false; issues: SearchIssue[] } {
  const issues: SearchIssue[] = [];
  const add = (path: string, code: SearchIssueCode, message: string) =>
    issues.push({ path, code, message });
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [{ path: "", code: "invalid_request", message: "must be an object" }],
    };
  }
  for (const key of Object.keys(input).sort()) {
    if (!REQUEST_KEYS.has(key)) add(key, "unknown_field", "is not a supported search field");
  }

  let match = "";
  if (typeof input.query !== "string") {
    add("query", "invalid_value", "is required and must be a string");
  } else {
    const t = tokenizeQuery(input.query);
    if (t.ok) match = toMatchExpression(t.tokens);
    else issues.push(t.issue);
  }

  let family: ContributionFamily | undefined;
  if (input.family !== undefined) {
    if (input.family === "knowledge" || input.family === "execution") family = input.family;
    else add("family", "invalid_value", "must be knowledge or execution");
  }

  let contentType: string | undefined;
  if (input.contentType !== undefined) {
    if (boundedString(input.contentType, SEARCH_LIMITS.maxContentTypeLength)) {
      contentType = input.contentType;
    } else add("contentType", "invalid_value", "must be a non-empty string");
  }

  let limit: number = SEARCH_LIMITS.defaultLimit;
  if (input.limit !== undefined) {
    if (
      typeof input.limit === "number" &&
      Number.isInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= SEARCH_LIMITS.maxLimit
    ) {
      limit = input.limit;
    } else add("limit", "invalid_limit", `must be an integer from 1 to ${SEARCH_LIMITS.maxLimit}`);
  }

  const clauses: FilterClause[] = [];
  if (input.filters !== undefined) {
    if (!isPlainObject(input.filters)) {
      add("filters", "invalid_value", "must be an object");
    } else {
      const keys = Object.keys(input.filters).sort();
      if (keys.length > 0 && input.family === undefined) {
        add("filters", "filter_requires_family", "family-specific filters require family");
      } else if (family !== undefined) {
        const own: readonly string[] =
          family === "knowledge" ? KNOWLEDGE_SEARCH_FILTERS : EXECUTION_SEARCH_FILTERS;
        const other: readonly string[] =
          family === "knowledge" ? EXECUTION_SEARCH_FILTERS : KNOWLEDGE_SEARCH_FILTERS;
        for (const key of keys) {
          const path = `filters.${key}`;
          const value = input.filters[key];
          if (!own.includes(key)) {
            if (other.includes(key)) {
              add(path, "incompatible_filter", `is not a ${family} filter`);
            } else add(path, "unknown_field", "is not a supported filter");
            continue;
          }
          const clause = filterClause(family, key, value);
          if (clause) clauses.push(clause);
          else add(path, "invalid_value", "has an invalid value");
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, req: { match, family, contentType, clauses, limit } };
}

const oneOf = (v: unknown, allowed: readonly string[]): v is string =>
  typeof v === "string" && allowed.includes(v);

function filterClause(family: ContributionFamily, key: string, v: unknown): FilterClause | null {
  if (family === "knowledge") {
    if (key === "verificationMethod" && oneOf(v, VERIFICATION_METHODS)) {
      return { sql: "k.verification_method = ?", value: v };
    }
    if (key === "permittedUse" && oneOf(v, PERMITTED_USES)) {
      return { sql: "k.permitted_use = ?", value: v };
    }
    return null;
  }
  switch (key) {
    case "verificationMethod":
      return oneOf(v, EXECUTION_VERIFICATION_METHODS)
        ? { sql: "e.verification_method = ?", value: v }
        : null;
    case "sideEffect":
      return oneOf(v, SIDE_EFFECTS) ? { sql: "e.side_effect = ?", value: v } : null;
    case "requiresHumanApproval":
      return typeof v === "boolean"
        ? { sql: "e.requires_human_approval = ?", value: v ? 1 : 0 }
        : null;
    case "targetDomain":
      return boundedString(v, SEARCH_LIMITS.maxTargetDomainLength)
        ? {
            sql: `EXISTS (SELECT 1 FROM execution_target_domains t
                   WHERE t.contribution_id = e.contribution_id AND t.version = e.version
                     AND t.domain = ?)`,
            value: v,
          }
        : null;
    case "requiredCapability":
      return boundedString(v, SEARCH_LIMITS.maxCapabilityLength)
        ? {
            sql: `EXISTS (SELECT 1 FROM json_each(e.compatibility_json, '$.requiredCapabilities') j
                   WHERE j.value = ?)`,
            value: v,
          }
        : null;
    default:
      return null;
  }
}

interface ResultRow {
  id: string;
  version: number;
  family: ContributionFamily;
  content_type: string;
  title: string;
  purpose: string;
  as_of: string;
  created_at: string;
  review_interval_days: number;
  last_verified_at: string | null;
  reliability_score: number | null;
  consumer_count: number;
}

export class ContributionSearch {
  constructor(private readonly env: { readonly DB: D1Database }) {}

  /** Plain-text search over the latest version of each contribution; D1 only. */
  async search(request: SearchRequest | unknown): Promise<SearchResult> {
    const v = validate(request);
    if (!v.ok) return { ok: false, error: { code: "invalid_search_request", issues: v.issues } };
    const { match, family, contentType, clauses, limit } = v.req;

    const where: string[] = [];
    const params: (string | number)[] = [match];
    if (family !== undefined) {
      where.push("v.family = ?");
      params.push(family);
    }
    if (contentType !== undefined) {
      where.push("v.content_type = ?");
      params.push(contentType);
    }
    for (const c of clauses) {
      where.push(c.sql);
      params.push(c.value);
    }
    params.push(limit);

    const familyJoin =
      family === "knowledge"
        ? "JOIN knowledge_versions k ON k.contribution_id = v.contribution_id AND k.version = v.version"
        : family === "execution"
          ? "JOIN execution_versions e ON e.contribution_id = v.contribution_id AND e.version = v.version"
          : "";

    const sql = `
      WITH matched AS (
        SELECT d.contribution_id, d.version
          FROM contribution_search s
          JOIN contribution_search_documents d ON d.doc_id = s.rowid
         WHERE contribution_search MATCH ?
      ),
      latest AS (
        SELECT contribution_id, MAX(version) AS version
          FROM contribution_versions GROUP BY contribution_id
      )
      SELECT v.contribution_id AS id, v.version, v.family, v.content_type, v.title, v.purpose,
             v.as_of, v.created_at, v.review_interval_days,
             p.last_verified_at, p.reliability_score, p.consumer_count
        FROM matched m
        JOIN latest l ON l.contribution_id = m.contribution_id AND l.version = m.version
        JOIN contribution_versions v ON v.contribution_id = m.contribution_id AND v.version = m.version
        JOIN version_platform_state p ON p.contribution_id = v.contribution_id AND p.version = v.version
        ${familyJoin}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY v.created_at DESC, v.contribution_id ASC
       LIMIT ?`;

    const { results } = await this.env.DB.prepare(sql)
      .bind(...params)
      .all<ResultRow>();
    return {
      ok: true,
      results: results.map((r) =>
        Object.freeze({
          id: r.id,
          version: r.version,
          family: r.family,
          contentType: r.content_type,
          title: r.title,
          purpose: r.purpose,
          asOf: r.as_of,
          createdAt: r.created_at,
          reviewIntervalDays: r.review_interval_days,
          lastVerifiedAt: r.last_verified_at,
          reliabilityScore: r.reliability_score,
          consumerCount: r.consumer_count,
        }),
      ),
    };
  }
}
