/**
 * Internal D1 full-text search over the FTS5 index (Phase 3), with metadata filtering and a
 * deterministic baseline ranking.
 *
 * Internal only: no HTTP, MCP or Worker route, no discovery response, no pagination, caching or
 * Vectorize. Reads D1 only; never touches R2. No LLM calls.
 *
 * Query handling: the query is PLAIN TEXT, never FTS syntax. It is NFKC-normalized, lowercased and
 * split on every character that is not a Unicode letter, mark or number; the validation limits apply
 * to these raw tokens. Every FTS5 expression is generated internally: each token is emitted as an
 * FTS5 double-quoted string, so quotes, punctuation, column filters, prefix stars and operator
 * words (AND/OR/NOT/NEAR) typed by the caller are inert. Match expressions, group counts and every
 * filter value are bound as SQL parameters.
 *
 * Query normalization (deterministic, LLM-free; see {@link normalizeQuery}):
 *   - stop words: tokens in the fixed English framing/grammar list {@link SEARCH_STOP_WORDS} are
 *     dropped. Negations and safety-significant words ({@link SEARCH_PROTECTED_TERMS}, e.g. `no`,
 *     `not`, `without`, approval, side-effect and capability terms) are never stop words. A query of
 *     only stop words is searched literally (every raw token required, no expansion, no relaxation),
 *     exactly as before normalization existed;
 *   - token groups: each remaining distinct token becomes one group of at most three alternatives:
 *     the token plus narrowly scoped English singular/plural forms ({@link singularPluralForms};
 *     ASCII letters only, e.g. `limit`/`limits`, `request`/`requests`, `policy`/`policies`). A
 *     group matches when any alternative matches; tokens sharing a form collapse into one group.
 *
 * Matching (at most {@link SEARCH_RELAXATION.maxSearchQueries} D1 search queries per request):
 *   1. strict: every group is required (implicit AND), as before. If it returns any result, that is
 *      the answer;
 *   2. bounded relaxation, only when the strict search returns zero results and the query has at
 *      least {@link SEARCH_RELAXATION.minGroups} groups: first documents matching all groups but one,
 *      then (only if still empty) all groups but two. At most
 *      {@link SEARCH_RELAXATION.maxDroppedGroups} groups are relaxed and a relaxed match still
 *      requires at least {@link SEARCH_RELAXATION.minRequiredGroups} groups, so a multi-token query
 *      never falls back to a single broad token. Relaxed searches apply the same family, content
 *      type and metadata filters, the same latest-version rule, ranking contract and result limit.
 *
 * Latest-version rule: only the latest version of each contribution is searched. If an older version
 * matches but the latest does not, the contribution is not returned. Historical versions remain
 * available only through exact-version retrieval.
 *
 * Freshness (computed from persisted D1 metadata against an injected reference time):
 *   anchor       = the later of `asOf` and platform `lastVerifiedAt` (when set)
 *   reviewDueAt  = anchor + `reviewIntervalDays` × 24 h (millisecond precision, UTC)
 *   freshness    = "current" when referenceTime < reviewDueAt, otherwise "stale"
 *                  (exactly at reviewDueAt is stale). An unparseable anchor is "stale" with a
 *                  null `reviewDueAt`.
 *
 * Ranking contract (baseline, deterministic, applied in SQL before LIMIT; lexicographic keys):
 *   1. freshness: current before stale (stale is demoted below every current match);
 *   2. evidence tier, descending, family-aware on a common 0–2 scale ({@link EVIDENCE_TIERS}):
 *      Knowledge cross-source 2, source-checked 1, owner-tested 1, unverified 0;
 *      Execution owner-tested 2, simulated 1, unverified 0;
 *   3. platform `reliabilityScore` descending, null after any score (no Phase 5 data exists yet);
 *   4. Knowledge corroboration descending: distinct source URIs beyond the first, capped at
 *      {@link SEARCH_RANKING.maxCorroboration}; Execution is always 0 (it has no persisted
 *      equivalent);
 *   5. latest-version creation time descending;
 *   6. contribution ID ascending (final, unique tie-break).
 * Every key is defined for both families, so the order is total and transitive across mixed
 * results. Ranking never reads indexed text, Knowledge `explanation`, steps or R2 content. Not
 * implemented (Phase 5): recent Execution outcomes, consumer feedback, trust or source re-checks;
 * `consumerCount` is not a ranking input.
 *
 * Results carry only typed metadata from `contribution_versions` and `version_platform_state` plus
 * the derived freshness state and review-due time; no indexed text, facts, summary, explanation,
 * objective, steps, R2 content, identities or hashes.
 */
import type { ContributionFamily, ContributionId, ContributionRef } from "./envelope";
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

/** Family-aware evidence tiers (ranking key 2), on a common 0–2 scale. */
export const EVIDENCE_TIERS = {
  knowledge: { "cross-source": 2, "source-checked": 1, "owner-tested": 1, unverified: 0 },
  execution: { "owner-tested": 2, simulated: 1, unverified: 0 },
} as const satisfies {
  knowledge: Record<(typeof VERIFICATION_METHODS)[number], number>;
  execution: Record<(typeof EXECUTION_VERIFICATION_METHODS)[number], number>;
};

export const SEARCH_RANKING = {
  /** Cap on Knowledge corroboration (distinct source URIs beyond the first). */
  maxCorroboration: 4,
  msPerDay: 86_400_000,
} as const;

export type FreshnessState = "current" | "stale";

export interface ContributionSearchOptions {
  /** Reference time for freshness; injected for deterministic tests. Defaults to the clock. */
  readonly now?: () => Date;
}

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
  /** Derived at the reference time; see the freshness contract above. */
  readonly freshness: FreshnessState;
  /** ISO-8601 UTC; null only when the stored anchor cannot be parsed. */
  readonly reviewDueAt: string | null;
  /**
   * Exact cross-family references stored for exactly this result version, in stored order
   * (`ordinal`). Deeply frozen; empty when none. Never "latest" and never referenced content.
   */
  readonly related: readonly ContributionRef[];
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
  tokens.map(quoteToken).join(" ");

const SAFE_TOKEN = /^[\p{L}\p{M}\p{N}]+$/u;
/** Quotes one token as an FTS5 string. Only letter/mark/number tokens are accepted. */
function quoteToken(token: string): string {
  if (!SAFE_TOKEN.test(token)) throw new RangeError("unsafe search token");
  return `"${token}"`;
}

/**
 * Fixed, conservative English stop words: question framing, pronouns, articles, auxiliaries and
 * prepositions only. Changing this list changes search behaviour and must be documented.
 */
export const SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "many",
  "me",
  "much",
  "my",
  "need",
  "of",
  "on",
  "or",
  "our",
  "per",
  "please",
  "should",
  "some",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Negations and safety-significant terms that must never be stop words (asserted by tests).
 * Documentation of intent; normalization never drops a token that is not in the stop-word list.
 */
export const SEARCH_PROTECTED_TERMS: readonly string[] = [
  "no",
  "not",
  "nor",
  "never",
  "none",
  "without",
  "cannot",
  "except",
  "only",
  "must",
  "approval",
  "approve",
  "approved",
  "human",
  "require",
  "required",
  "requires",
  "side",
  "effect",
  "effects",
  "read",
  "write",
  "reversible",
  "irreversible",
  "delete",
  "capability",
  "capabilities",
  "safe",
  "unsafe",
  "dangerous",
  "destructive",
  "all",
];

export const SEARCH_RELAXATION = {
  /** Fewest meaningful groups for which relaxation is attempted. */
  minGroups: 4,
  /** Most groups that may be left unmatched by a relaxed search. */
  maxDroppedGroups: 2,
  /** Fewest groups every relaxed match must still contain. */
  minRequiredGroups: 3,
  /** Strict search plus at most two relaxed levels. */
  maxSearchQueries: 3,
  /** Most alternatives (token + singular/plural forms) in one group. */
  maxFormsPerGroup: 3,
} as const;

const ASCII_WORD = /^[a-z]+$/;
const SIBILANT_END = /(?:s|x|z|ch|sh)$/;
const CONSONANT_Y = /[^aeiou]y$/;

/**
 * Narrowly scoped, deterministic English singular/plural alternatives for one token (the token
 * itself first). Only lowercase ASCII words of at least three letters are expanded; tokens with
 * digits or other scripts are returned unchanged. Rules:
 *   - `…ies` (≥ 5 letters) ↔ `…y`             (policies → policy)
 *   - `…ches|shes|xes|zes|ses` (≥ 5) → drop `s` and `es` (caches → cache, cach; statuses → status)
 *   - `…s` (≥ 4, not `ss`/`us`/`is`) → drop `s` (limits → limit, requests → request)
 *   - consonant + `y` → `…ies`                 (policy → policies)
 *   - `…s|x|z|ch|sh` (incl. `ss`/`us`) → `…es` (status → statuses, box → boxes)
 *   - `…is` → unchanged                         (analysis)
 *   - otherwise → `…s`                          (limit → limits, key → keys)
 */
export function singularPluralForms(token: string): readonly string[] {
  if (token.length < 3 || !ASCII_WORD.test(token)) return [token];
  const forms = [token];
  if (token.endsWith("ies") && token.length >= 5) {
    forms.push(`${token.slice(0, -3)}y`);
  } else if (/(?:ch|sh|x|z|s)es$/.test(token) && token.length >= 5) {
    forms.push(token.slice(0, -1), token.slice(0, -2));
  } else if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) {
    if (token.length >= 4) forms.push(token.slice(0, -1));
  } else if (CONSONANT_Y.test(token)) {
    forms.push(`${token.slice(0, -1)}ies`);
  } else if (SIBILANT_END.test(token)) {
    if (!token.endsWith("is")) forms.push(`${token}es`);
  } else {
    forms.push(`${token}s`);
  }
  return forms.slice(0, SEARCH_RELAXATION.maxFormsPerGroup);
}

/** A normalized query: ordered token groups, each a list of alternative forms. */
export interface NormalizedQuery {
  readonly groups: readonly (readonly string[])[];
  /** True when every token was a stop word and the raw tokens are searched as-is. */
  readonly literal: boolean;
}

/**
 * Deterministic query normalization over validated, distinct tokens (see the module header):
 * drops stop words, expands singular/plural forms and merges groups that share a form.
 */
export function normalizeQuery(tokens: readonly string[]): NormalizedQuery {
  const meaningful = tokens.filter((t) => !SEARCH_STOP_WORDS.has(t));
  if (meaningful.length === 0) {
    return { groups: tokens.map((t) => [t]), literal: true };
  }
  const groups: string[][] = [];
  for (const token of meaningful) {
    const forms = singularPluralForms(token);
    if (groups.some((g) => g.some((f) => forms.includes(f)))) continue;
    groups.push([...forms]);
  }
  return { groups, literal: false };
}

/** FTS5 expression for one group: a quoted token, or a parenthesized OR of quoted forms. */
export const groupExpression = (forms: readonly string[]): string =>
  forms.length === 1 ? quoteToken(forms[0]) : `(${forms.map(quoteToken).join(" OR ")})`;

/** Relaxed candidate FTS5 expression: any group. */
export const anyGroupExpression = (groups: readonly (readonly string[])[]): string =>
  groups.map(groupExpression).join(" OR ");

/** Strict FTS5 expression: every group required. */
export const strictExpression = (groups: readonly (readonly string[])[]): string =>
  groups.map(groupExpression).join(" AND ");

/**
 * Minimum number of matched groups for each relaxed level, in order (empty when relaxation does
 * not apply). Never more than {@link SEARCH_RELAXATION.maxDroppedGroups} levels and never below
 * {@link SEARCH_RELAXATION.minRequiredGroups}.
 */
export function relaxationLevels(query: NormalizedQuery): readonly number[] {
  const n = query.groups.length;
  if (query.literal || n < SEARCH_RELAXATION.minGroups) return [];
  const levels: number[] = [];
  for (let dropped = 1; dropped <= SEARCH_RELAXATION.maxDroppedGroups; dropped++) {
    if (n - dropped >= SEARCH_RELAXATION.minRequiredGroups) levels.push(n - dropped);
  }
  return levels;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface FilterClause {
  readonly sql: string;
  readonly value: string | number;
}

interface ValidatedRequest {
  readonly query: NormalizedQuery;
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

  let query: NormalizedQuery = { groups: [], literal: true };
  if (typeof input.query !== "string") {
    add("query", "invalid_value", "is required and must be a string");
  } else {
    const t = tokenizeQuery(input.query);
    if (t.ok) query = normalizeQuery(t.tokens);
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
  return { ok: true, req: { query, family, contentType, clauses, limit } };
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
  review_due_ms: number | null;
  stale: number;
}

const EMPTY_RELATED: readonly ContributionRef[] = Object.freeze([]);

const tierCase = (column: string, tiers: Readonly<Record<string, number>>): string =>
  `CASE ${column} ${Object.entries(tiers)
    .map(([method, tier]) => `WHEN '${method}' THEN ${tier}`)
    .join(" ")} ELSE 0 END`;

/** Exact integer epoch milliseconds of an ISO timestamp column (NULL if unparseable). */
const epochMs = (expr: string): string =>
  `CAST(ROUND((julianday(${expr}) - 2440587.5) * ${SEARCH_RANKING.msPerDay}) AS INTEGER)`;

export class ContributionSearch {
  private readonly now: () => Date;

  constructor(
    private readonly env: { readonly DB: D1Database },
    options: ContributionSearchOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Ranked plain-text search over the latest version of each contribution; D1 only. */
  async search(request: SearchRequest | unknown): Promise<SearchResult> {
    const v = validate(request);
    if (!v.ok) return { ok: false, error: { code: "invalid_search_request", issues: v.issues } };
    const referenceMs = this.now().getTime();
    if (!Number.isFinite(referenceMs)) throw new RangeError("invalid search reference time");

    // Strict first; bounded relaxation only while every earlier level returned nothing.
    let results = await this.rankedSearch(v.req, referenceMs, null);
    for (const required of relaxationLevels(v.req.query)) {
      if (results.length > 0) break;
      results = await this.rankedSearch(v.req, referenceMs, required);
    }
    const related = await this.loadRelated(results);
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
          freshness: r.stale === 0 ? ("current" as const) : ("stale" as const),
          reviewDueAt: r.review_due_ms === null ? null : new Date(r.review_due_ms).toISOString(),
          related: related.get(`${r.id}\u0000${r.version}`) ?? EMPTY_RELATED,
        }),
      ),
    };
  }

  /**
   * One ranked D1 search query. `required` null: every group must match (strict). Otherwise a
   * document must match at least `required` groups, each group evaluated by its own FTS5 MATCH.
   */
  private async rankedSearch(
    req: ValidatedRequest,
    referenceMs: number,
    required: number | null,
  ): Promise<ResultRow[]> {
    const { query, family, contentType, clauses, limit } = req;
    const params: (string | number)[] = [];
    let matched: string;
    if (required === null) {
      matched = `SELECT d.contribution_id, d.version
          FROM contribution_search s
          JOIN contribution_search_documents d ON d.doc_id = s.rowid
         WHERE contribution_search MATCH ?`;
      params.push(strictExpression(query.groups));
    } else {
      // Candidates match any group; each group is then counted by its own MATCH subquery.
      const perGroup = query.groups.map(
        () =>
          "(s.rowid IN (SELECT rowid FROM contribution_search WHERE contribution_search MATCH ?))",
      );
      matched = `SELECT d.contribution_id, d.version
          FROM contribution_search s
          JOIN contribution_search_documents d ON d.doc_id = s.rowid
         WHERE contribution_search MATCH ?
           AND (${perGroup.join(" + ")}) >= ?`;
      params.push(anyGroupExpression(query.groups), ...query.groups.map(groupExpression), required);
    }

    const where: string[] = [];
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
    // Bound in SQL order: match expression(s) [and required count], filters, reference time, limit.
    params.push(referenceMs, limit);

    const sql = `
      WITH matched AS (
        ${matched}
      ),
      latest AS (
        SELECT contribution_id, MAX(version) AS version
          FROM contribution_versions GROUP BY contribution_id
      ),
      candidates AS (
        SELECT v.contribution_id AS id, v.version, v.family, v.content_type, v.title, v.purpose,
               v.as_of, v.created_at, v.review_interval_days,
               p.last_verified_at, p.reliability_score, p.consumer_count,
               MAX(${epochMs("v.as_of")}, COALESCE(${epochMs("p.last_verified_at")}, ${epochMs("v.as_of")}))
                 + v.review_interval_days * ${SEARCH_RANKING.msPerDay} AS review_due_ms,
               CASE v.family
                 WHEN 'knowledge' THEN ${tierCase("k.verification_method", EVIDENCE_TIERS.knowledge)}
                 ELSE ${tierCase("e.verification_method", EVIDENCE_TIERS.execution)}
               END AS evidence_tier,
               CASE v.family WHEN 'knowledge' THEN
                 MIN(MAX((SELECT COUNT(DISTINCT ks.uri) FROM knowledge_sources ks
                           WHERE ks.contribution_id = v.contribution_id AND ks.version = v.version)
                         - 1, 0), ${SEARCH_RANKING.maxCorroboration})
               ELSE 0 END AS corroboration
          FROM matched m
          JOIN latest l ON l.contribution_id = m.contribution_id AND l.version = m.version
          JOIN contribution_versions v
            ON v.contribution_id = m.contribution_id AND v.version = m.version
          JOIN version_platform_state p
            ON p.contribution_id = v.contribution_id AND p.version = v.version
          LEFT JOIN knowledge_versions k
            ON k.contribution_id = v.contribution_id AND k.version = v.version
          LEFT JOIN execution_versions e
            ON e.contribution_id = v.contribution_id AND e.version = v.version
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      )
      SELECT c.*, CASE WHEN c.review_due_ms IS NULL OR ? >= c.review_due_ms THEN 1 ELSE 0 END
                    AS stale
        FROM candidates c
       ORDER BY stale ASC, c.evidence_tier DESC, c.reliability_score IS NULL ASC,
                c.reliability_score DESC, c.corroboration DESC, c.created_at DESC, c.id ASC
       LIMIT ?`;

    const { results } = await this.env.DB.prepare(sql)
      .bind(...params)
      .all<ResultRow>();
    return results;
  }

  /** One bounded bulk D1 query (at most `maxLimit` result versions) for exact-version references. */
  private async loadRelated(
    rows: readonly ResultRow[],
  ): Promise<Map<string, readonly ContributionRef[]>> {
    const out = new Map<string, ContributionRef[]>();
    if (rows.length === 0) return new Map();
    const keys = JSON.stringify(rows.map((r) => ({ id: r.id, version: r.version })));
    const { results } = await this.env.DB.prepare(
      `SELECT r.from_contribution_id AS from_id, r.from_version AS from_version,
              r.to_family AS family, r.to_contribution_id AS id, r.to_version AS version
         FROM json_each(?) j
         JOIN contribution_references r
           ON r.from_contribution_id = json_extract(j.value, '$.id')
          AND r.from_version = json_extract(j.value, '$.version')
        ORDER BY r.from_contribution_id, r.from_version, r.ordinal`,
    )
      .bind(keys)
      .all<{
        from_id: string;
        from_version: number;
        family: ContributionFamily;
        id: string;
        version: number;
      }>();
    for (const r of results) {
      const k = `${r.from_id}\u0000${r.from_version}`;
      const list = out.get(k) ?? [];
      list.push(
        Object.freeze({ family: r.family, id: r.id as ContributionId, version: r.version }),
      );
      out.set(k, list);
    }
    return new Map([...out].map(([k, v]) => [k, Object.freeze(v)]));
  }
}
